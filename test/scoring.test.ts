import { describe, expect, test } from "bun:test";
import type { LeaderTrade, TokenRef } from "../src/types.js";
import { buildEpisodes, fomoFeeUsd } from "../src/scoring/episodes.js";
import { capacity, latencyDecay, performance, process as proc, type MarketLookup } from "../src/scoring/metrics.js";
import { scoreTrader, DEFAULT_SCORING } from "../src/scoring/score.js";

const T0 = 1_700_000_000_000;
const USDC: TokenRef = { chain: "solana", address: "EPjF", symbol: "USDC", decimals: 6 };

const tok = (a: string): TokenRef => ({ chain: "solana", address: a, decimals: 6 });

function buy(id: string, asset: string, usd: number, px: number, ts: number): LeaderTrade {
  return {
    id, chain: "solana", leader: "L", ts, side: "buy",
    asset: tok(asset), quote: USDC,
    assetAmount: usd / px, quoteAmount: usd, usdValue: usd, fillPxUsd: px,
  };
}

function sell(id: string, asset: string, qty: number, px: number, ts: number): LeaderTrade {
  return {
    id, chain: "solana", leader: "L", ts, side: "sell",
    asset: tok(asset), quote: USDC,
    assetAmount: qty, quoteAmount: qty * px, usdValue: qty * px, fillPxUsd: px,
  };
}

/** Fixed market: every token has the same liquidity and a flat price. */
function flatMarket(liquidityUsd: number, priceUsd: number): MarketLookup {
  return {
    liquidityUsdAt: () => liquidityUsd,
    priceUsdAt: () => priceUsd,
  };
}

describe("fomo fee model", () => {
  test("the $0.95 floor dominates small tickets", () => {
    expect(fomoFeeUsd(100)).toBe(0.95); // 0.5% would be $0.50
    expect(fomoFeeUsd(1000)).toBe(5); // 0.5% clears the floor
  });

  test("the floor binds below a ~$190 ticket, and bites hard there", () => {
    // At $190 the percentage fee equals the floor; below that the floor rules.
    expect(fomoFeeUsd(190)).toBeCloseTo(0.95, 9);
    expect(fomoFeeUsd(200)).toBeCloseTo(1.0, 9);

    // A $100 round trip pays $1.90 — 1.9% of the position, before slippage.
    const roundTrip = fomoFeeUsd(100) + fomoFeeUsd(100);
    expect(roundTrip).toBeCloseTo(1.9, 9);
    expect(roundTrip / 100).toBeCloseTo(0.019, 9);
  });
});

describe("episode building", () => {
  test("scaling in and out is one episode, not four trades", () => {
    const eps = buildEpisodes([
      buy("1", "AAA", 1000, 1, T0),
      buy("2", "AAA", 1000, 1.2, T0 + 10_000),
      sell("3", "AAA", 900, 2, T0 + 60_000),
      sell("4", "AAA", 933.4, 2.1, T0 + 90_000),
    ]);
    expect(eps).toHaveLength(1);
    const ep = eps[0]!;
    expect(ep.closed).toBe(true);
    expect(ep.buys).toBe(2);
    expect(ep.sells).toBe(2);
    expect(ep.holdSec).toBe(90);
  });

  test("a still-open position is reported but contributes no P&L", () => {
    const eps = buildEpisodes([buy("1", "AAA", 1000, 1, T0)]);
    expect(eps).toHaveLength(1);
    expect(eps[0]!.closed).toBe(false);
    // Marking it would turn paper gains into a track record.
    expect(eps[0]!.netPnlUsd).toBe(0);
  });

  test("a sell with no observed entry is dropped rather than booked as pure profit", () => {
    const eps = buildEpisodes([sell("1", "AAA", 500, 2, T0)]);
    expect(eps).toHaveLength(0);
  });

  test("records the peak weight of the trader's book", () => {
    const eps = buildEpisodes([buy("1", "AAA", 4000, 1, T0)], () => 100_000);
    expect(eps[0]!.peakWeight).toBeCloseTo(0.04, 6);
  });
});

describe("fee-adjusted performance", () => {
  test("a gross-profitable churner is exposed as net-negative", () => {
    // 40 round trips of $150, each making 1% gross. Gross +$60,
    // but 80 fills x $0.95 = $76 of fees.
    const trades: LeaderTrade[] = [];
    for (let i = 0; i < 40; i++) {
      const t = T0 + i * 600_000;
      trades.push(buy(`b${i}`, `T${i}`, 150, 1, t));
      trades.push(sell(`s${i}`, `T${i}`, 150, 1.01, t + 120_000));
    }
    const p = performance(buildEpisodes(trades));

    expect(p.grossPnlUsd).toBeCloseTo(60, 6);
    expect(p.feesUsd).toBeCloseTo(76, 6);
    expect(p.netPnlUsd).toBeLessThan(0);
    // The leaderboard shows a 100% win rate on the same history.
    expect(p.winRate).toBe(0);
  });
});

describe("capacity", () => {
  test("derives the largest vault that could hold the trader's weights", () => {
    // 4% of book into a $1m pool, 1% impact cap => $10k deployable
    // => any vault above $250k cannot express the trade.
    const eps = buildEpisodes(
      [buy("1", "AAA", 4000, 1, T0), sell("2", "AAA", 4000, 1.5, T0 + 60_000)],
      () => 100_000,
    );
    const c = capacity(eps, flatMarket(1_000_000, 1), 0.01);
    expect(c.capacityUsd).toBeCloseTo(250_000, 0);
  });

  test("a thin pool collapses capacity even for a great trade", () => {
    const eps = buildEpisodes(
      [buy("1", "AAA", 4000, 1, T0), sell("2", "AAA", 4000, 10, T0 + 60_000)],
      () => 100_000,
    );
    const c = capacity(eps, flatMarket(30_000, 1), 0.01);
    expect(c.capacityUsd).toBeCloseTo(7_500, 0);
  });

  test("reports null rather than guessing when liquidity is unknown", () => {
    const eps = buildEpisodes([buy("1", "AAA", 4000, 1, T0)], () => 100_000);
    const c = capacity(eps, { liquidityUsdAt: () => undefined, priceUsdAt: () => 1 }, 0.01);
    expect(c.capacityUsd).toBeNull();
    expect(c.sampleSize).toBe(0);
  });
});

describe("latency decay", () => {
  test("an edge that evaporates in seconds is measured, not assumed away", () => {
    // Bought at 1.00, sold at 2.00. By +10s the price is already 1.95, so a
    // vault arriving late captures almost none of the move.
    const eps = buildEpisodes([buy("1", "AAA", 1000, 1, T0), sell("2", "AAA", 1000, 2, T0 + 300_000)]);
    const lookup: MarketLookup = {
      liquidityUsdAt: () => 1_000_000,
      priceUsdAt: (_t, ts) => (ts <= T0 ? 1 : 1.95),
    };
    const l = latencyDecay(eps, lookup, [10]);
    const r = l.retention.get(10)!;
    expect(r).not.toBeNull();
    expect(r!).toBeLessThan(0.1);
    expect(l.halfLifeSec).toBe(10);
  });

  test("a slow-moving position survives the delay intact", () => {
    const eps = buildEpisodes([buy("1", "AAA", 1000, 1, T0), sell("2", "AAA", 1000, 2, T0 + 86_400_000)]);
    const lookup: MarketLookup = {
      liquidityUsdAt: () => 1_000_000,
      priceUsdAt: (_t, ts) => (ts <= T0 + 60_000 ? 1.001 : 2),
    };
    const l = latencyDecay(eps, lookup, [10]);
    expect(l.retention.get(10)!).toBeGreaterThan(0.95);
    expect(l.halfLifeSec).toBeNull();
  });
});

describe("process quality", () => {
  test("one lucky trade carrying the record is surfaced", () => {
    const trades: LeaderTrade[] = [];
    for (let i = 0; i < 9; i++) {
      const t = T0 + i * 600_000;
      trades.push(buy(`b${i}`, `T${i}`, 1000, 1, t));
      trades.push(sell(`s${i}`, `T${i}`, 1000, 1.02, t + 120_000));
    }
    // One 50x that dwarfs everything else.
    trades.push(buy("bx", "MOON", 1000, 1, T0 + 9_000_000));
    trades.push(sell("sx", "MOON", 1000, 50, T0 + 9_600_000));

    const p = proc(buildEpisodes(trades));
    expect(p.topEpisodeShare).toBeGreaterThan(0.9);
    expect(p.distinctTokens).toBe(10);
  });
});

describe("composite score", () => {
  function history(count: number, priceMult: number, weight: number) {
    const trades: LeaderTrade[] = [];
    for (let i = 0; i < count; i++) {
      const t = T0 + i * 3_600_000;
      trades.push(buy(`b${i}`, `T${i}`, 10_000 * weight, 1, t));
      trades.push(sell(`s${i}`, `T${i}`, 10_000 * weight, priceMult, t + 1_800_000));
    }
    return trades;
  }

  test("refuses to score a trader with too little closed history", () => {
    const s = scoreTrader("L", history(3, 1.5, 0.4), flatMarket(5_000_000, 1), () => 100_000);
    expect(s.composite).toBeNull();
    expect(s.grade).toBe("insufficient-data");
    expect(s.flags.join(" ")).toMatch(/closed positions/);
  });

  test("a profitable, high-capacity, latency-tolerant trader grades well", () => {
    const s = scoreTrader("L", history(30, 1.4, 0.02), flatMarket(50_000_000, 1), () => 10_000_000);
    expect(s.composite).not.toBeNull();
    expect(s.capacityUsd).toBeGreaterThan(DEFAULT_SCORING.minViableVaultUsd);
    expect(["A", "B"]).toContain(s.grade);
  });

  test("low capacity caps the score however good the returns are", () => {
    // 10x returns, but every entry is 40% of the book into a $20k pool.
    const s = scoreTrader("L", history(30, 10, 0.4), flatMarket(20_000, 1), () => 10_000);
    expect(s.capacityUsd).toBeLessThan(DEFAULT_SCORING.minViableVaultUsd);
    // Gated, not averaged: spectacular P&L must not hide uninvestability.
    expect(s.composite!).toBeLessThanOrEqual(40);
    expect(s.flags.join(" ")).toMatch(/Capacity is about/);
  });

  test("a net-negative trader cannot grade above D", () => {
    const trades: LeaderTrade[] = [];
    for (let i = 0; i < 30; i++) {
      const t = T0 + i * 600_000;
      trades.push(buy(`b${i}`, `T${i}`, 150, 1, t));
      trades.push(sell(`s${i}`, `T${i}`, 150, 1.01, t + 120_000));
    }
    const s = scoreTrader("L", trades, flatMarket(5_000_000, 1), () => 100_000);
    expect(s.composite!).toBeLessThanOrEqual(30);
    expect(s.flags.join(" ")).toMatch(/Net loss|Profitable gross/);
  });

  test("every published number carries its own reason", () => {
    const s = scoreTrader("L", history(30, 10, 0.4), flatMarket(20_000, 1), () => 10_000);
    // A depositor should never see a bare number with no explanation.
    expect(s.flags.length).toBeGreaterThan(0);
    expect(s.raw.performance.closedEpisodes).toBe(30);
  });
});
