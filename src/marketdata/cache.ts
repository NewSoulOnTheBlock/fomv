import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { mergeCandles, resolutionKey, resolutionMs, type Candle, type Resolution } from "./feed.js";

/**
 * Candles on disk, so widening a scoring window is affordable.
 *
 * # Why this is not optional
 *
 * A profile over a month of history asks a free endpoint for a few hundred
 * candle pages, serialised behind a rate gate. That is minutes of wall time,
 * and without a cache every re-run pays it again -- which in practice means
 * nobody re-runs, the window stays narrow to keep the loop fast, and the
 * grades get computed off five days of history because the tooling made five
 * days convenient. The cache is what makes "score them over a quarter" a
 * decision rather than an afternoon.
 *
 * # What is safe to keep
 *
 * A closed candle never changes: the high of 14:00-15:00 yesterday is a fact.
 * Only the candle covering *now* is still moving. So everything older than one
 * interval is cached indefinitely and the newest candle is always refetched,
 * which is both correct and the cheapest possible policy.
 */

interface CacheFile {
  version: 1;
  token: string;
  resolution: string;
  /** Ascending, never containing the interval that was open when written. */
  candles: Candle[];
  updatedAtMs: number;
}

export interface CandleCacheOptions {
  /** Root directory. One file per token and resolution. */
  dir: string;
}

export class CandleCache {
  /**
   * Read-through memo, so one profiling run touches each file once.
   *
   * A run asks for the same token repeatedly -- once per episode -- and
   * hitting the filesystem for each would turn a cache into a different kind
   * of slow.
   */
  private readonly memo = new Map<string, CacheFile>();

  constructor(private readonly opts: CandleCacheOptions) {}

  private path(token: string, resolution: Resolution): string {
    // The address is used verbatim: base58 has no path separators and no case
    // collisions that matter, and hashing it would make the cache
    // un-inspectable for no gain.
    return `${this.opts.dir}/${resolutionKey(resolution)}/${token}.json`;
  }

  async read(token: string, resolution: Resolution): Promise<Candle[]> {
    const key = `${resolutionKey(resolution)}:${token}`;
    const hit = this.memo.get(key);
    if (hit) return hit.candles;

    try {
      const raw = await readFile(this.path(token, resolution), "utf8");
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.candles)) return [];
      this.memo.set(key, parsed);
      return parsed.candles;
    } catch {
      // A missing or unreadable cache file is a cache miss, never a failure.
      // The feed is the authority; this only decides how much of it to ask for.
      return [];
    }
  }

  async write(token: string, resolution: Resolution, candles: Candle[]): Promise<void> {
    const key = `${resolutionKey(resolution)}:${token}`;
    const existing = await this.read(token, resolution);

    // The still-open interval is dropped rather than stored: writing it would
    // freeze a partial high into a file that is never refetched.
    const openFrom = Date.now() - resolutionMs(resolution);
    const merged = mergeCandles(existing, candles).filter((c) => c.tsMs < openFrom);

    const file: CacheFile = {
      version: 1,
      token,
      resolution: resolutionKey(resolution),
      candles: merged,
      updatedAtMs: Date.now(),
    };
    this.memo.set(key, file);

    const path = this.path(token, resolution);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(file));
  }

  /**
   * The sub-range of `[fromMs, toMs]` the cache cannot answer.
   *
   * Returns null when the cache covers the request. Coverage means a candle
   * exists at or before the start and at or after the end minus one interval;
   * gaps *inside* that span are left alone, because a token that genuinely
   * did not trade for an hour has no candle there and refetching would find
   * the same hole every time.
   */
  static missingRange(
    candles: Candle[],
    fromMs: number,
    toMs: number,
    resolution: Resolution,
  ): { fromMs: number; toMs: number } | null {
    if (candles.length === 0) return { fromMs, toMs };

    const step = resolutionMs(resolution);
    const first = candles[0]!.tsMs;
    const last = candles[candles.length - 1]!.tsMs;

    const needBefore = fromMs < first - step;
    const needAfter = toMs > last + step;

    if (!needBefore && !needAfter) return null;
    // One range rather than two: feeds page backwards from a timestamp, so
    // asking for the union costs the same calls as asking for either end.
    return { fromMs: needBefore ? fromMs : first, toMs: needAfter ? toMs : last };
  }
}
