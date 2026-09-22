import type { TokenRef } from "../types.js";
import { CandleCache } from "./cache.js";
import {
  RateGate,
  mergeCandles,
  resolutionMs,
  withRetry,
  type Candle,
  type CandleRequest,
  type PriceFeed,
} from "./feed.js";

/**
 * Candles from GeckoTerminal's public API.
 *
 * # Why this one is the default
 *
 * It needs no key and no account, which matters more than it sounds: a price
 * feed that requires signing up is a feed that is not configured on the
 * machine where someone first runs `cli.ts profile`, and the profile silently
 * falls back to the biased path instead. A default that works on a fresh
 * checkout is the difference between the good data path being the normal one
 * and being the one nobody turns on.
 *
 * The cost is resolution and rate limit. Thirty calls a minute, and pool-level
 * rather than token-level aggregation. `BirdeyeFeed` is the upgrade for anyone
 * with a key, and both satisfy the same interface so swapping is configuration
 * rather than code.
 *
 * # Pools, and picking the right one
 *
 * OHLCV is served per *pool*, not per token, so a token has as many candle
 * series as it has markets -- and they disagree, because a thin pool prints
 * prices a deep one never sees. The deepest pool is chosen and the choice is
 * remembered.
 *
 * The listing endpoint does **not** return pools in liquidity order. That is
 * worth stating because taking the first result looks right, works on most
 * tokens, and silently picks a pool with a fraction of the real depth on the
 * rest.
 */

const BASE = "https://api.geckoterminal.com/api/v2";

/** GeckoTerminal's documented public ceiling is 30 calls a minute. */
const MIN_INTERVAL_MS = 2_100;

/** The API caps a page at 1000 candles. */
const PAGE_LIMIT = 1000;

/** Pages per request, so one illiquid token cannot consume a whole run. */
const MAX_PAGES = 6;

interface PoolAttributes {
  address?: string;
  reserve_in_usd?: string | number | null;
}

export interface GeckoTerminalOptions {
  network?: string;
  cache?: CandleCache;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  minIntervalMs?: number;
}

export class GeckoTerminalFeed implements PriceFeed {
  readonly name = "geckoterminal";

  private readonly gate: RateGate;
  private readonly network: string;
  private readonly base: string;
  /** token -> deepest pool, or null when the token has no pool at all. */
  private readonly pools = new Map<string, string | null>();

  constructor(private readonly opts: GeckoTerminalOptions = {}) {
    this.gate = new RateGate(opts.minIntervalMs ?? MIN_INTERVAL_MS);
    this.network = opts.network ?? "solana";
    this.base = opts.baseUrl ?? BASE;
  }

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string): Promise<T | null> {
    return this.gate.run(() =>
      withRetry(async () => {
        const res = await this.fetch(`${this.base}${path}`, {
          headers: { accept: "application/json" },
        });
        // 404 means the token or pool is unknown here, which for a two-hour-old
        // memecoin is the ordinary case rather than a fault.
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`geckoterminal ${res.status} on ${path}`);
        return (await res.json()) as T;
      }),
    );
  }

  /** The deepest pool for a token, or null when it has none. */
  async deepestPool(address: string): Promise<string | null> {
    const cached = this.pools.get(address);
    if (cached !== undefined) return cached;

    const body = await this.get<{ data?: { attributes?: PoolAttributes }[] }>(
      `/networks/${this.network}/tokens/${address}/pools`,
    );

    let best: string | null = null;
    let bestLiquidity = -1;
    for (const row of body?.data ?? []) {
      const attrs = row.attributes ?? {};
      if (!attrs.address) continue;
      const liquidity = Number(attrs.reserve_in_usd ?? 0);
      // Explicitly max rather than first: the endpoint's order is not depth.
      if (Number.isFinite(liquidity) && liquidity > bestLiquidity) {
        bestLiquidity = liquidity;
        best = attrs.address;
      }
    }

    this.pools.set(address, best);
    return best;
  }

  async candles(req: CandleRequest): Promise<Candle[]> {
    const address = req.token.address;
    const cache = this.opts.cache;

    const cached = cache ? await cache.read(address, req.resolution) : [];
    const missing = CandleCache.missingRange(cached, req.fromMs, req.toMs, req.resolution);
    if (!missing) return clip(cached, req.fromMs, req.toMs);

    const pool = await this.deepestPool(address);
    if (!pool) return clip(cached, req.fromMs, req.toMs);

    const fetched = await this.page(pool, missing.fromMs, missing.toMs, req);
    const merged = mergeCandles(cached, fetched);
    if (cache && fetched.length > 0) await cache.write(address, req.resolution, fetched);

    return clip(merged, req.fromMs, req.toMs);
  }

  /**
   * Page backwards from the end of the window.
   *
   * The API returns newest-first and takes `before_timestamp`, so the only
   * way to reach older data is to walk back from the newest candle of the
   * previous page. Stopping conditions are all three of: reached the start,
   * ran out of pages, or the feed returned nothing -- the last being how a
   * token younger than the window ends.
   */
  private async page(
    pool: string,
    fromMs: number,
    toMs: number,
    req: CandleRequest,
  ): Promise<Candle[]> {
    const { timeframe, aggregate } = req.resolution;
    const out: Candle[][] = [];
    let before = Math.ceil(toMs / 1000);

    for (let i = 0; i < MAX_PAGES; i++) {
      const qs = new URLSearchParams({
        aggregate: String(aggregate),
        before_timestamp: String(before),
        limit: String(PAGE_LIMIT),
        currency: "usd",
        token: "base",
      });
      const body = await this.get<{
        data?: { attributes?: { ohlcv_list?: (number | string)[][] } };
      }>(`/networks/${this.network}/pools/${pool}/ohlcv/${timeframe}?${qs}`);

      const rows = body?.data?.attributes?.ohlcv_list ?? [];
      if (rows.length === 0) break;

      const page = rows.map(toCandle).filter((c): c is Candle => c !== null);
      if (page.length === 0) break;
      out.push(page);

      const oldest = Math.min(...page.map((c) => c.tsMs));
      if (oldest <= fromMs) break;
      // Step strictly past the oldest candle, or the next page repeats it for
      // ever on a pool with fewer candles than the page limit.
      before = Math.floor(oldest / 1000) - 1;
    }

    return mergeCandles(...out);
  }
}

/**
 * One `[ts, o, h, l, c, v]` row.
 *
 * Every field is re-parsed rather than trusted: the API returns numbers for
 * some tokens and strings for others, and a string price silently poisons
 * every comparison downstream by turning `>` into lexicographic order.
 */
function toCandle(row: (number | string)[]): Candle | null {
  const [ts, o, h, l, c, v] = row;
  const n = (x: unknown) => Number(x);
  const tsMs = n(ts) * 1000;
  const close = n(c);
  if (!Number.isFinite(tsMs) || !Number.isFinite(close) || close <= 0) return null;
  return {
    tsMs,
    open: n(o),
    high: n(h),
    low: n(l),
    close,
    volumeUsd: Number.isFinite(n(v)) ? n(v) : 0,
  };
}

/** Candles intersecting the window, with one interval of slack at each end. */
function clip(candles: Candle[], fromMs: number, toMs: number): Candle[] {
  return candles.filter((c) => c.tsMs >= fromMs - 86_400_000 && c.tsMs <= toMs + 86_400_000);
}

/** Convenience for callers that only have a mint address. */
export function tokenRef(address: string, decimals = 0): TokenRef {
  return { chain: "solana", address, decimals };
}

export { resolutionMs };
