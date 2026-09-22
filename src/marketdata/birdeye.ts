import { CandleCache } from "./cache.js";
import {
  RateGate,
  mergeCandles,
  resolutionMs,
  withRetry,
  type Candle,
  type CandleRequest,
  type PriceFeed,
  type Resolution,
} from "./feed.js";

/**
 * Candles from Birdeye.
 *
 * The upgrade over GeckoTerminal for anyone holding a key: token-level
 * aggregation rather than a single pool, so a token that migrated venues --
 * which on Solana is most of them, from a bonding curve to an AMM -- keeps one
 * continuous series instead of going flat when its first pool died.
 *
 * Not the default only because it needs an account. A feed nobody has
 * configured is a feed that silently is not used, and the fallback is the
 * biased path this module exists to replace.
 */

const BASE = "https://public-api.birdeye.so";

/** Birdeye's free tier is roughly a call a second; paid tiers are far higher. */
const MIN_INTERVAL_MS = 1_100;

/** Requests per call, to keep one token from monopolising a run. */
const MAX_PAGES = 6;

/** Rows the endpoint will return in one response. */
const PAGE_LIMIT = 1_000;

export interface BirdeyeOptions {
  apiKey: string;
  chain?: string;
  cache?: CandleCache;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  minIntervalMs?: number;
}

/** Our resolution, in Birdeye's vocabulary. */
function birdeyeType(r: Resolution): string {
  if (r.timeframe === "minute") {
    const allowed = [1, 3, 5, 15, 30];
    const pick = allowed.find((a) => a >= r.aggregate) ?? 30;
    return `${pick}m`;
  }
  if (r.timeframe === "hour") {
    const allowed = [1, 2, 4, 6, 8, 12];
    const pick = allowed.find((a) => a >= r.aggregate) ?? 12;
    return `${pick}H`;
  }
  return r.aggregate >= 7 ? "1W" : r.aggregate >= 3 ? "3D" : "1D";
}

interface BirdeyeBar {
  unixTime?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}

export class BirdeyeFeed implements PriceFeed {
  readonly name = "birdeye";

  private readonly gate: RateGate;

  constructor(private readonly opts: BirdeyeOptions) {
    this.gate = new RateGate(opts.minIntervalMs ?? MIN_INTERVAL_MS);
  }

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  async candles(req: CandleRequest): Promise<Candle[]> {
    const address = req.token.address;
    const cache = this.opts.cache;

    const cached = cache ? await cache.read(address, req.resolution) : [];
    const missing = CandleCache.missingRange(cached, req.fromMs, req.toMs, req.resolution);
    if (!missing) return clip(cached, req.fromMs, req.toMs);

    const fetched = await this.page(address, missing.fromMs, missing.toMs, req.resolution);
    const merged = mergeCandles(cached, fetched);
    if (cache && fetched.length > 0) await cache.write(address, req.resolution, fetched);

    return clip(merged, req.fromMs, req.toMs);
  }

  /**
   * Page forwards from the start of the window.
   *
   * Birdeye takes an explicit `time_from`/`time_to` pair and answers oldest
   * first, so paging advances the floor rather than lowering a ceiling. The
   * loop stops when a page comes back short, which is the only reliable signal
   * that the series has been exhausted -- the endpoint does not say how much
   * it withheld.
   */
  private async page(
    address: string,
    fromMs: number,
    toMs: number,
    resolution: Resolution,
  ): Promise<Candle[]> {
    const out: Candle[][] = [];
    const step = resolutionMs(resolution);
    let from = Math.floor(fromMs / 1000);
    const to = Math.ceil(toMs / 1000);

    for (let i = 0; i < MAX_PAGES && from < to; i++) {
      const qs = new URLSearchParams({
        address,
        type: birdeyeType(resolution),
        time_from: String(from),
        time_to: String(to),
      });

      const body = await this.gate.run(() =>
        withRetry(async () => {
          const res = await this.fetch(`${this.opts.baseUrl ?? BASE}/defi/ohlcv?${qs}`, {
            headers: {
              accept: "application/json",
              "X-API-KEY": this.opts.apiKey,
              "x-chain": this.opts.chain ?? "solana",
            },
          });
          // An unlisted token is a 404 here and is not worth a retry or a throw.
          if (res.status === 404) return null;
          if (!res.ok) throw new Error(`birdeye ${res.status}`);
          return (await res.json()) as { success?: boolean; data?: { items?: BirdeyeBar[] } };
        }),
      );

      const rows = body?.data?.items ?? [];
      if (rows.length === 0) break;

      const page = rows.map(toCandle).filter((c): c is Candle => c !== null);
      if (page.length === 0) break;
      out.push(page);

      if (rows.length < PAGE_LIMIT) break;
      const newest = Math.max(...page.map((c) => c.tsMs));
      from = Math.floor((newest + step) / 1000);
    }

    return mergeCandles(...out);
  }
}

function toCandle(bar: BirdeyeBar): Candle | null {
  const tsMs = Number(bar.unixTime) * 1000;
  const close = Number(bar.c);
  if (!Number.isFinite(tsMs) || !Number.isFinite(close) || close <= 0) return null;
  return {
    tsMs,
    open: Number(bar.o),
    high: Number(bar.h),
    low: Number(bar.l),
    close,
    volumeUsd: Number.isFinite(Number(bar.v)) ? Number(bar.v) : 0,
  };
}

function clip(candles: Candle[], fromMs: number, toMs: number): Candle[] {
  return candles.filter((c) => c.tsMs >= fromMs - 86_400_000 && c.tsMs <= toMs + 86_400_000);
}
