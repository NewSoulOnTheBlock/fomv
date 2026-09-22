import { describe, expect, test } from "bun:test";

import {
  RateGate,
  mergeCandles,
  resolutionFor,
  resolutionMs,
  type Candle,
} from "../src/marketdata/feed.js";
import { CandleCache } from "../src/marketdata/cache.js";
import { CandlePricePath, LayeredPricePath, candlePathFor } from "../src/marketdata/candlepath.js";
import { GeckoTerminalFeed } from "../src/marketdata/geckoterminal.js";
import { ObservedPricePath } from "../src/scoring/pricepath.js";
import type { LeaderTrade, TokenRef } from "../src/types.js";

const TOKEN: TokenRef = { chain: "solana", address: "MintAAA", decimals: 6 };
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

const candle = (tsMs: number, o: number, h: number, l: number, c: number): Candle => ({
  tsMs,
  open: o,
  high: h,
  low: l,
  close: c,
  volumeUsd: 1_000,
});

describe("resolution ladder", () => {
  test("picks the finest resolution that stays inside the candle budget", () => {
    expect(resolutionFor(6 * HOUR)).toEqual({ timeframe: "minute", aggregate: 1 });
    // A five-day window at one minute would be 7,200 candles per token.
    expect(resolutionMs(resolutionFor(5 * 24 * HOUR))).toBeGreaterThanOrEqual(5 * 60_000);
    // 400 days fits in 800 twelve-hour candles, so the ladder stops before
    // dropping to daily -- coarser than needed is a worse answer, not a safer one.
    expect(resolutionFor(400 * 24 * HOUR)).toEqual({ timeframe: "hour", aggregate: 12 });
    // Nothing on the ladder is allowed to blow the budget.
    for (const span of [HOUR, 24 * HOUR, 90 * 24 * HOUR, 400 * 24 * HOUR]) {
      expect(span / resolutionMs(resolutionFor(span))).toBeLessThanOrEqual(1_500);
    }
  });

  test("never returns a resolution finer than the span", () => {
    const r = resolutionFor(30_000);
    expect(resolutionMs(r)).toBeGreaterThan(0);
  });
});

describe("rate gate", () => {
  test("serialises calls and keeps them apart", async () => {
    const gate = new RateGate(30);
    const at: number[] = [];
    await Promise.all([1, 2, 3].map(() => gate.run(async () => at.push(Date.now()))));
    expect(at.length).toBe(3);
    expect(at[2]! - at[0]!).toBeGreaterThanOrEqual(55);
  });

  test("a rejected call does not stall the ones behind it", async () => {
    const gate = new RateGate(1);
    const failed = gate.run(async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    // The whole point: one bad request must not deadlock the run.
    await expect(gate.run(async () => "fine")).resolves.toBe("fine");
  });
});

describe("merging candle pages", () => {
  test("deduplicates on timestamp and sorts ascending", () => {
    const merged = mergeCandles(
      [candle(T0 + HOUR, 1, 2, 1, 2), candle(T0, 1, 1, 1, 1)],
      [candle(T0 + HOUR, 9, 9, 9, 9)],
    );
    expect(merged.map((c) => c.tsMs)).toEqual([T0, T0 + HOUR]);
    // Later page wins: it was fetched more recently.
    expect(merged[1]!.close).toBe(9);
  });
});

describe("cache coverage", () => {
  const res = { timeframe: "hour", aggregate: 1 } as const;

  test("an empty cache is missing the whole range", () => {
    expect(CandleCache.missingRange([], T0, T0 + 5 * HOUR, res)).toEqual({
      fromMs: T0,
      toMs: T0 + 5 * HOUR,
    });
  });

  test("a covering cache reports nothing missing", () => {
    const have = [candle(T0, 1, 1, 1, 1), candle(T0 + 5 * HOUR, 1, 1, 1, 1)];
    expect(CandleCache.missingRange(have, T0 + HOUR, T0 + 4 * HOUR, res)).toBeNull();
  });

  test("a hole inside the covered span is not refetched", () => {
    // A token that did not trade for two hours has no candles there, and
    // asking again would find the same hole every run.
    const have = [candle(T0, 1, 1, 1, 1), candle(T0 + 5 * HOUR, 1, 1, 1, 1)];
    expect(CandleCache.missingRange(have, T0, T0 + 5 * HOUR, res)).toBeNull();
  });

  test("extending either end asks for the union, not two ranges", () => {
    const have = [candle(T0 + 2 * HOUR, 1, 1, 1, 1)];
    const missing = CandleCache.missingRange(have, T0, T0 + 9 * HOUR, res);
    expect(missing).toEqual({ fromMs: T0, toMs: T0 + 9 * HOUR });
  });
});

describe("candle price path", () => {
  const path = new CandlePricePath({ timeframe: "hour", aggregate: 1 });
  path.set(TOKEN, [
    candle(T0, 10, 12, 9, 11),
    candle(T0 + HOUR, 11, 30, 10, 12),
    candle(T0 + 2 * HOUR, 12, 14, 11, 13),
  ]);

  test("answers with the close of the candle containing the moment", () => {
    expect(path.priceAt(TOKEN, T0 + HOUR + 60_000)).toBe(12);
  });

  test("refuses to extrapolate past its own series", () => {
    expect(path.priceAt(TOKEN, T0 + 40 * HOUR)).toBeUndefined();
    expect(path.priceAt(TOKEN, T0 - 40 * HOUR)).toBeUndefined();
  });

  test("the peak is a candle high, including one nobody traded at", () => {
    // 30 is the high of the middle candle. A path built from fills alone
    // could only ever report a price the trader themselves traded at, which
    // is what made capture ratio a restatement of the trade log.
    const peak = path.maxBetween(TOKEN, T0, T0 + 3 * HOUR);
    expect(peak?.priceUsd).toBe(30);
    expect(peak?.tsMs).toBe(T0 + HOUR);
  });

  test("a peak outside the window is not reported", () => {
    expect(path.maxBetween(TOKEN, T0 + 2 * HOUR, T0 + 3 * HOUR)?.priceUsd).toBe(14);
  });

  test("an unknown token is undefined, never zero", () => {
    const other: TokenRef = { chain: "solana", address: "MintBBB", decimals: 6 };
    expect(path.priceAt(other, T0)).toBeUndefined();
    expect(path.maxBetween(other, T0, T0 + HOUR)).toBeUndefined();
    expect(path.observationCount(other)).toBe(0);
  });
});

describe("layered price path", () => {
  const candles = new CandlePricePath({ timeframe: "hour", aggregate: 1 });
  candles.set(TOKEN, [candle(T0, 10, 12, 9, 11)]);

  const fills = new ObservedPricePath(HOUR);
  fills.add(TOKEN, T0 + 30 * 60_000, 99);

  const layered = new LayeredPricePath([candles, fills]);

  test("point lookups take the first layer that can answer", () => {
    expect(layered.priceAt(TOKEN, T0 + 10 * 60_000)).toBe(11);
  });

  test("peaks take the maximum across layers, not the first answer", () => {
    // The fill at 99 is a price that genuinely traded inside an interval whose
    // candle high was 12. A coarse candle must not be allowed to hide it.
    expect(layered.maxBetween(TOKEN, T0, T0 + HOUR)?.priceUsd).toBe(99);
  });

  test("observations are the sum of both layers", () => {
    expect(layered.observationCount(TOKEN)).toBe(2);
  });
});

describe("geckoterminal feed", () => {
  const pools = (rows: { address: string; reserve: number }[]) => ({
    data: rows.map((r) => ({ attributes: { address: r.address, reserve_in_usd: String(r.reserve) } })),
  });

  const ohlcv = (rows: number[][]) => ({
    data: { attributes: { ohlcv_list: rows } },
  });

  function fakeFetch(handler: (url: string) => unknown) {
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const body = handler(url);
      return new Response(JSON.stringify(body ?? {}), {
        status: body === null ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test("picks the deepest pool, not the first one listed", async () => {
    // The listing endpoint does not order by liquidity. Taking the first
    // result works on most tokens and silently picks a thin pool on the rest.
    const { impl } = fakeFetch((url) =>
      url.includes("/tokens/")
        ? pools([
            { address: "SHALLOW", reserve: 25_000 },
            { address: "DEEP", reserve: 4_000_000 },
          ])
        : ohlcv([]),
    );
    const feed = new GeckoTerminalFeed({ fetchImpl: impl });
    expect(await feed.deepestPool("MintAAA")).toBe("DEEP");
  });

  test("a token with no pools is empty rather than an error", async () => {
    const { impl } = fakeFetch(() => ({ data: [] }));
    const feed = new GeckoTerminalFeed({ fetchImpl: impl, minIntervalMs: 0 });
    const got = await feed.candles({
      token: TOKEN,
      fromMs: T0,
      toMs: T0 + HOUR,
      resolution: { timeframe: "hour", aggregate: 1 },
    });
    expect(got).toEqual([]);
  });

  test("string prices are coerced, so comparisons are numeric", async () => {
    // The API returns numbers for some tokens and strings for others, and a
    // string price turns every `>` downstream into lexicographic order.
    const { impl } = fakeFetch((url) =>
      url.includes("/tokens/")
        ? pools([{ address: "P", reserve: 1 }])
        : ohlcv([[T0 / 1000, "9", "100", "8", "90", "5"] as unknown as number[]]),
    );
    const feed = new GeckoTerminalFeed({ fetchImpl: impl, minIntervalMs: 0 });
    const got = await feed.candles({
      token: TOKEN,
      fromMs: T0,
      toMs: T0 + HOUR,
      resolution: { timeframe: "hour", aggregate: 1 },
    });
    expect(got[0]!.high).toBe(100);
    expect(typeof got[0]!.close).toBe("number");
  });

  test("paging stops instead of repeating the oldest candle for ever", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.includes("/tokens/")
        ? pools([{ address: "P", reserve: 1 }])
        : ohlcv([[T0 / 1000, 1, 1, 1, 1, 1]]),
    );
    const feed = new GeckoTerminalFeed({ fetchImpl: impl, minIntervalMs: 0 });
    await feed.candles({
      token: TOKEN,
      fromMs: T0 - 500 * 24 * HOUR,
      toMs: T0,
      resolution: { timeframe: "hour", aggregate: 1 },
    });
    // One pool lookup plus a bounded number of candle pages.
    expect(calls.filter((c) => c.includes("ohlcv")).length).toBeLessThanOrEqual(6);
  });
});

describe("building a path for a trader", () => {
  const trade = (tsMs: number): LeaderTrade => ({
    id: `t${tsMs}`,
    chain: "solana",
    leader: "L",
    ts: tsMs,
    side: "buy",
    asset: TOKEN,
    quote: { chain: "solana", address: "USDC", decimals: 6 },
    assetAmount: 1,
    quoteAmount: 10,
    usdValue: 10,
    fillPxUsd: 10,
  });

  test("reports coverage, and names the tokens it could not price", async () => {
    const feed = {
      name: "stub",
      candles: async () => [candle(T0, 1, 2, 1, 2)],
    };
    const built = await candlePathFor([trade(T0), trade(T0 + HOUR)], feed);
    expect(built).not.toBeNull();
    expect(built!.coverage.feed).toBe("stub");
    expect(built!.coverage.tokensRequested).toBe(1);
    expect(built!.coverage.tokensCovered).toBe(1);
    expect(built!.coverage.uncovered).toEqual([]);
  });

  test("one token the feed cannot serve does not fail the profile", async () => {
    const feed = {
      name: "stub",
      candles: async () => {
        throw new Error("upstream down");
      },
    };
    const built = await candlePathFor([trade(T0)], feed);
    expect(built!.coverage.tokensCovered).toBe(0);
    expect(built!.coverage.uncovered).toEqual(["MintAAA"]);
  });

  test("no trades means no path to build", async () => {
    const feed = { name: "stub", candles: async () => [] };
    expect(await candlePathFor([], feed)).toBeNull();
  });
});
