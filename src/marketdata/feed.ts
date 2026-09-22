import type { TokenRef } from "../types.js";

/**
 * Where historical prices come from.
 *
 * # Why this interface exists at all
 *
 * Two of the five ability dimensions -- entry skill and exit skill -- ask what
 * a token did *after* the trader acted. That is the one question a trade log
 * cannot answer, because it needs prices at moments the trader did nothing.
 *
 * Until this module existed, `ObservedPricePath` answered it from the trader's
 * own later fills plus one current price. Those are real prices, and the
 * approach has a fatal bias: a trader is far more likely to act when price has
 * moved, so the only prices ever observed are the ones that provoked a trade.
 * Capture ratio computed against that sample asks "did you sell near the
 * highest price you yourself traded at", which is close to a tautology, and
 * `medianTimeToPeakSec` collapses to zero because the entry fill is usually
 * the only observation in the window.
 *
 * A candle feed removes the bias by observing every interval whether or not
 * anyone acted in it. It is the difference between the exit dimension being a
 * measurement and being a restatement of the trade log.
 *
 * # What a feed must not do
 *
 * Invent. A feed returns the candles it has and nothing else: no interpolation
 * across gaps, no carrying the last price forward, no zero for a missing
 * interval. Coverage is reported and acted on by the caller, because a
 * confident wrong price is worse for a published grade than a visible hole.
 */

export interface Candle {
  /** Start of the interval, in ms. */
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

/**
 * Candle width.
 *
 * Kept as a pair rather than a duration so it can be handed to APIs that take
 * a timeframe and an aggregate, which is most of them.
 */
export interface Resolution {
  timeframe: "minute" | "hour" | "day";
  aggregate: number;
}

export function resolutionMs(r: Resolution): number {
  const unit = r.timeframe === "minute" ? 60_000 : r.timeframe === "hour" ? 3_600_000 : 86_400_000;
  return unit * r.aggregate;
}

export function resolutionKey(r: Resolution): string {
  return `${r.timeframe}${r.aggregate}`;
}

/**
 * The finest resolution that covers a span without asking for absurd numbers
 * of candles.
 *
 * Entry quality is judged at +1h, so a five-day window measured in daily
 * candles would answer every horizon with the same number. Conversely a
 * six-month window at one-minute resolution is a quarter of a million candles
 * per token and several minutes of paging. This picks the finest resolution
 * that keeps a token under roughly `budget` candles.
 */
export function resolutionFor(spanMs: number, budget = 1_500): Resolution {
  const ladder: Resolution[] = [
    { timeframe: "minute", aggregate: 1 },
    { timeframe: "minute", aggregate: 5 },
    { timeframe: "minute", aggregate: 15 },
    { timeframe: "hour", aggregate: 1 },
    { timeframe: "hour", aggregate: 4 },
    { timeframe: "hour", aggregate: 12 },
    { timeframe: "day", aggregate: 1 },
  ];
  for (const r of ladder) {
    if (spanMs / resolutionMs(r) <= budget) return r;
  }
  return ladder[ladder.length - 1]!;
}

export interface CandleRequest {
  token: TokenRef;
  fromMs: number;
  toMs: number;
  resolution: Resolution;
}

export interface PriceFeed {
  /** Named so provenance can say which source a published grade rests on. */
  readonly name: string;
  /**
   * Candles covering as much of `[fromMs, toMs]` as the feed has.
   *
   * Returns `[]` rather than throwing when the token is unknown to the feed --
   * an unlisted memecoin is the normal case here, not an error, and one such
   * token must not fail a whole profiling run.
   */
  candles(req: CandleRequest): Promise<Candle[]>;
}

/**
 * A minimum interval between calls, awaited in order.
 *
 * Free market-data endpoints are rate limited per minute and answer a burst
 * with 429s rather than a queue. Profiling forty tokens issues forty requests
 * as fast as the event loop allows, so the gate has to be here rather than in
 * each call site. Serialising also keeps the backoff meaningful: parallel
 * retries against a limited endpoint just re-trigger the limit.
 */
export class RateGate {
  private tail: Promise<void> = Promise.resolve();
  private last = 0;

  constructor(private readonly minIntervalMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const started = this.tail.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    // The queue advances even when a call fails, or one rejection would stall
    // every request behind it for the rest of the process.
    this.tail = started.then(
      () => undefined,
      () => undefined,
    );
    return started.then(fn);
  }
}

/** Retry the transient failures a public endpoint produces as a matter of course. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!/429|rate|timeout|fetch failed|ECONNRESET|502|503|504/i.test(String(err))) break;
      await new Promise((r) => setTimeout(r, 600 * 2 ** i + Math.random() * 300));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Merge candle pages into one ascending series, newest value winning on a tie. */
export function mergeCandles(...pages: Candle[][]): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const page of pages) for (const c of page) byTs.set(c.tsMs, c);
  return [...byTs.values()].sort((a, b) => a.tsMs - b.tsMs);
}
