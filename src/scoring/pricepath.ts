import type { LeaderTrade, TokenRef } from "../types.js";
import { tokenKey } from "../types.js";

/**
 * Prices for a token at arbitrary past moments.
 *
 * Entry and exit quality are the two metrics that cannot be computed from a
 * trade log alone: both ask what the token did *after* an action, which means
 * knowing prices at times the trader did nothing. This is the seam where that
 * data comes from.
 */
export interface PricePath {
  /**
   * Price at a moment, or `undefined` when it was not observed.
   *
   * `undefined` is load-bearing. Every caller in this module reports `null`
   * rather than substituting a neighbouring price, because an interpolated
   * price is indistinguishable in the output from a real one and quietly turns
   * a coverage problem into a confident wrong answer.
   */
  priceAt(token: TokenRef, tsMs: number): number | undefined;
  /** Highest observed price in a window, or undefined if nothing was observed. */
  maxBetween(token: TokenRef, fromMs: number, toMs: number): { priceUsd: number; tsMs: number } | undefined;
  /** How many price points exist for a token. Lets callers judge their own coverage. */
  observationCount(token: TokenRef): number;
}

interface Observation {
  tsMs: number;
  priceUsd: number;
}

/**
 * A price path assembled from prices that were actually observed.
 *
 * Two sources, both real:
 *
 * 1. **The trader's own fills.** Every trade carries `fillPxUsd` at a known
 *    block time. A trader who scales into a position or sells in tranches is
 *    handing over a genuine price series for that token, for free.
 * 2. **The current price**, as one observation at "now".
 *
 * What this is not: a candle feed. Coverage is sparse and clustered around
 * moments the trader chose to act, which is itself a bias -- they are more
 * likely to trade when price moved. Metrics built on it must report their own
 * sample size, and every lookup is bounded by a tolerance so a question about
 * 3pm is never answered with a price from midnight.
 *
 * Swapping in a real OHLCV source later means implementing `PricePath` and
 * changing nothing else.
 */
export class ObservedPricePath implements PricePath {
  private readonly byToken = new Map<string, Observation[]>();

  constructor(private readonly toleranceMs: number = 2 * 60 * 60 * 1000) {}

  static from(
    trades: LeaderTrade[],
    opts: { currentPrice?: (token: TokenRef) => number | undefined; nowMs?: number; toleranceMs?: number } = {},
  ): ObservedPricePath {
    const path = new ObservedPricePath(opts.toleranceMs);
    const tokens = new Map<string, TokenRef>();

    for (const t of trades) {
      if (t.fillPxUsd > 0) path.add(t.asset, t.ts, t.fillPxUsd);
      tokens.set(tokenKey(t.asset), t.asset);
    }

    if (opts.currentPrice) {
      const now = opts.nowMs ?? Date.now();
      for (const token of tokens.values()) {
        const px = opts.currentPrice(token);
        if (px !== undefined && px > 0) path.add(token, now, px);
      }
    }

    for (const obs of path.byToken.values()) obs.sort((a, b) => a.tsMs - b.tsMs);
    return path;
  }

  add(token: TokenRef, tsMs: number, priceUsd: number): void {
    const key = tokenKey(token);
    const list = this.byToken.get(key);
    if (list) list.push({ tsMs, priceUsd });
    else this.byToken.set(key, [{ tsMs, priceUsd }]);
  }

  observationCount(token: TokenRef): number {
    return this.byToken.get(tokenKey(token))?.length ?? 0;
  }

  priceAt(token: TokenRef, tsMs: number): number | undefined {
    const obs = this.byToken.get(tokenKey(token));
    if (!obs || obs.length === 0) return undefined;

    // Nearest observation, accepted only if it is close enough in time to be
    // describing the same market.
    let best: Observation | undefined;
    let bestGap = Infinity;
    for (const o of obs) {
      const gap = Math.abs(o.tsMs - tsMs);
      if (gap < bestGap) {
        bestGap = gap;
        best = o;
      }
    }
    return best !== undefined && bestGap <= this.toleranceMs ? best.priceUsd : undefined;
  }

  maxBetween(token: TokenRef, fromMs: number, toMs: number): { priceUsd: number; tsMs: number } | undefined {
    const obs = this.byToken.get(tokenKey(token));
    if (!obs) return undefined;
    let best: Observation | undefined;
    for (const o of obs) {
      if (o.tsMs < fromMs || o.tsMs > toMs) continue;
      if (!best || o.priceUsd > best.priceUsd) best = o;
    }
    return best ? { priceUsd: best.priceUsd, tsMs: best.tsMs } : undefined;
  }
}

/** A path that knows nothing. Makes "no price data" an explicit choice. */
export const EMPTY_PRICE_PATH: PricePath = {
  priceAt: () => undefined,
  maxBetween: () => undefined,
  observationCount: () => 0,
};
