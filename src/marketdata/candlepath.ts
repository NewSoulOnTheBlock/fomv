import type { PricePath } from "../scoring/pricepath.js";
import type { LeaderTrade, TokenRef } from "../types.js";
import { tokenKey } from "../types.js";
import { resolutionFor, resolutionMs, type Candle, type PriceFeed, type Resolution } from "./feed.js";

/**
 * A `PricePath` backed by real candles.
 *
 * # What changes because of this
 *
 * `ObservedPricePath` answers "what was this worth at 3pm" from the trader's
 * own fills. Candles answer it from the market. The difference shows up
 * hardest in the two places it matters most:
 *
 * - **Capture ratio** asks what the peak was between entry and exit. From
 *   fills, the peak can only ever be a price the trader themselves traded at,
 *   so a trader who sold at their own best fill scores 100% by construction.
 *   From candle highs it is the real peak, including the one they slept
 *   through.
 * - **Time to peak** collapsed to zero on sparse data, because the entry fill
 *   was often the only observation in the window. With candles it is a
 *   duration rather than an artefact.
 *
 * # The price *at* a moment
 *
 * The close of the candle containing the moment, not an interpolation. A
 * candle is a summary of an interval and its close is the only value in it
 * that is a price at a stated time; open, high and low are prices at times the
 * feed does not report. Interpolating between them would manufacture a
 * precision the data does not have, in a file whose entire job is to avoid
 * exactly that.
 */
export class CandlePricePath implements PricePath {
  private readonly byToken = new Map<string, Candle[]>();

  constructor(
    private readonly resolution: Resolution,
    /**
     * How far a candle may be from the moment asked about.
     *
     * Defaults to one interval: a question about 14:05 may be answered by the
     * 14:00 candle and never by yesterday's.
     */
    private readonly toleranceMs?: number,
  ) {}

  private get tolerance(): number {
    return this.toleranceMs ?? resolutionMs(this.resolution);
  }

  set(token: TokenRef, candles: Candle[]): void {
    this.byToken.set(tokenKey(token), [...candles].sort((a, b) => a.tsMs - b.tsMs));
  }

  /** Tokens for which at least one candle was obtained. */
  get covered(): number {
    let n = 0;
    for (const list of this.byToken.values()) if (list.length > 0) n++;
    return n;
  }

  observationCount(token: TokenRef): number {
    return this.byToken.get(tokenKey(token))?.length ?? 0;
  }

  priceAt(token: TokenRef, tsMs: number): number | undefined {
    const list = this.byToken.get(tokenKey(token));
    if (!list || list.length === 0) return undefined;

    const i = lastAtOrBefore(list, tsMs);
    if (i < 0) {
      // Before the series began. The first candle may still be close enough to
      // answer, but only within tolerance -- never by extrapolating backwards.
      const first = list[0]!;
      return first.tsMs - tsMs <= this.tolerance ? first.open : undefined;
    }

    const candle = list[i]!;
    const age = tsMs - candle.tsMs;
    if (age > this.tolerance + resolutionMs(this.resolution)) return undefined;
    return candle.close;
  }

  maxBetween(
    token: TokenRef,
    fromMs: number,
    toMs: number,
  ): { priceUsd: number; tsMs: number } | undefined {
    const list = this.byToken.get(tokenKey(token));
    if (!list || list.length === 0 || toMs < fromMs) return undefined;

    let best: { priceUsd: number; tsMs: number } | undefined;
    for (const c of list) {
      // The interval is [tsMs, tsMs + resolution). One that ends exactly where
      // the window opens covers no moment inside it.
      if (c.tsMs + resolutionMs(this.resolution) <= fromMs) continue;
      if (c.tsMs > toMs) break;
      if (!Number.isFinite(c.high) || c.high <= 0) continue;
      if (!best || c.high > best.priceUsd) best = { priceUsd: c.high, tsMs: c.tsMs };
    }
    return best;
  }
}

/** Index of the last candle at or before `tsMs`, or -1. */
function lastAtOrBefore(list: Candle[], tsMs: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.tsMs <= tsMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Several price paths, best answer wins.
 *
 * Ordered by trust for point lookups -- the first layer that can answer does.
 * Peaks are the exception and take the **maximum** across every layer that
 * answers, because each observation is a price that genuinely traded and a
 * higher one can only mean the peak was higher than the first layer saw.
 * Taking the first answer there would let a coarse candle hide a spike that a
 * fill recorded.
 */
export class LayeredPricePath implements PricePath {
  constructor(private readonly layers: PricePath[]) {}

  priceAt(token: TokenRef, tsMs: number): number | undefined {
    for (const layer of this.layers) {
      const px = layer.priceAt(token, tsMs);
      if (px !== undefined && px > 0) return px;
    }
    return undefined;
  }

  maxBetween(
    token: TokenRef,
    fromMs: number,
    toMs: number,
  ): { priceUsd: number; tsMs: number } | undefined {
    let best: { priceUsd: number; tsMs: number } | undefined;
    for (const layer of this.layers) {
      const hit = layer.maxBetween(token, fromMs, toMs);
      if (hit && (!best || hit.priceUsd > best.priceUsd)) best = hit;
    }
    return best;
  }

  observationCount(token: TokenRef): number {
    let n = 0;
    for (const layer of this.layers) n += layer.observationCount(token);
    return n;
  }
}

export interface CandleCoverage {
  /** Which feed answered. */
  feed: string;
  resolution: Resolution;
  tokensRequested: number;
  tokensCovered: number;
  candles: number;
  /** Tokens the feed had nothing for, so the caveat can name the shortfall. */
  uncovered: string[];
}

/**
 * Fetch candles for every token a trader touched.
 *
 * Sequential on purpose. The feeds are rate limited and their gates serialise
 * anyway, so firing forty requests at once would only queue them while making
 * a failure harder to attribute. The resolution is chosen once from the whole
 * window so every token is measured on the same clock -- comparing a token
 * sampled hourly against one sampled by the minute would make the finer one
 * look more volatile purely from having been looked at more often.
 */
export async function candlePathFor(
  trades: LeaderTrade[],
  feed: PriceFeed,
  opts: {
    /** Extra time past the last trade, so exits have something to be judged against. */
    lookaheadMs?: number;
    nowMs?: number;
    onToken?: (address: string, candles: number) => void;
  } = {},
): Promise<{ path: CandlePricePath; coverage: CandleCoverage } | null> {
  if (trades.length === 0) return null;

  const now = opts.nowMs ?? Date.now();
  const lookahead = opts.lookaheadMs ?? 24 * 60 * 60 * 1000;
  const fromMs = Math.min(...trades.map((t) => t.ts));
  const toMs = Math.min(now, Math.max(...trades.map((t) => t.ts)) + lookahead);
  const resolution = resolutionFor(Math.max(toMs - fromMs, 60_000));

  const tokens = new Map<string, TokenRef>();
  for (const t of trades) tokens.set(tokenKey(t.asset), t.asset);

  const path = new CandlePricePath(resolution);
  const uncovered: string[] = [];
  let candles = 0;

  for (const token of tokens.values()) {
    let got: Candle[] = [];
    try {
      got = await feed.candles({ token, fromMs, toMs, resolution });
    } catch {
      // One token the feed cannot serve must not cost the whole profile. It
      // is recorded as uncovered, which is what the caveat reports.
    }
    path.set(token, got);
    candles += got.length;
    if (got.length === 0) uncovered.push(token.address);
    opts.onToken?.(token.address, got.length);
  }

  return {
    path,
    coverage: {
      feed: feed.name,
      resolution,
      tokensRequested: tokens.size,
      tokensCovered: path.covered,
      candles,
      uncovered,
    },
  };
}
