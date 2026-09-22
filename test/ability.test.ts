import { describe, expect, test } from "bun:test";

import {
  buildProfile,
  coreMetrics,
  entryQuality,
  exitQuality,
  isSelfContained,
  skillVsExposure,
  DEFAULT_ABILITY,
} from "../src/scoring/ability.js";
import type { Episode, Fill } from "../src/scoring/episodes.js";
import { ObservedPricePath, EMPTY_PRICE_PATH } from "../src/scoring/pricepath.js";
import type { TokenRef } from "../src/types.js";

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const tok = (name: string): TokenRef => ({ chain: "solana", address: name, decimals: 6, symbol: name });

function fill(side: "buy" | "sell", ts: number, qty: number, pxUsd: number): Fill {
  return { ts, side, qty, pxUsd, usdValue: qty * pxUsd };
}

/** An episode with sane defaults; override what the test is about. */
function ep(over: Partial<Episode> & { token?: TokenRef } = {}): Episode {
  const token = over.token ?? tok("AAA");
  const openedAtMs = over.openedAtMs ?? T0;
  const closedAtMs = over.closedAtMs === undefined ? openedAtMs + HOUR : over.closedAtMs;
  const costUsd = over.costUsd ?? 100;
  const proceedsUsd = over.proceedsUsd ?? 120;
  const feesUsd = over.feesUsd ?? 0;
  return {
    token,
    openedAtMs,
    closedAtMs,
    buys: 1,
    sells: 1,
    qtyBought: 100,
    qtySold: 100,
    costUsd,
    proceedsUsd,
    feesUsd,
    peakWeight: over.peakWeight ?? 0.04,
    netPnlUsd: over.netPnlUsd ?? proceedsUsd - costUsd - feesUsd,
    grossPnlUsd: over.grossPnlUsd ?? proceedsUsd - costUsd,
    holdSec: 3600,
    closed: over.closed ?? true,
    fills: over.fills ?? [fill("buy", openedAtMs, 100, costUsd / 100), fill("sell", closedAtMs ?? openedAtMs, 100, proceedsUsd / 100)],
    ...over,
  } as Episode;
}

describe("core metrics", () => {
  test("profit factor divides gross profit by gross loss", () => {
    const m = coreMetrics([
      ep({ netPnlUsd: 300 }),
      ep({ netPnlUsd: 100 }),
      ep({ netPnlUsd: -200 }),
    ]);
    expect(m.profitFactor).toBeCloseTo(400 / 200, 9);
    expect(m.winRate).toBeCloseTo(2 / 3, 9);
    expect(m.realizedPnlUsd).toBeCloseTo(200, 9);
  });

  test("a sample with no losses reports profit factor as unmeasured, not infinite", () => {
    // The denominator has not been tested yet. Infinity would rank this trader
    // above every trader who has actually been tested and survived.
    const m = coreMetrics([ep({ netPnlUsd: 100 }), ep({ netPnlUsd: 50 })]);
    expect(m.profitFactor).toBeNull();
  });

  test("reward-to-risk compares the average win against the average loss", () => {
    const m = coreMetrics([
      ep({ netPnlUsd: 300 }),
      ep({ netPnlUsd: 100 }),
      ep({ netPnlUsd: -100 }),
      ep({ netPnlUsd: -100 }),
    ]);
    expect(m.avgWinUsd).toBeCloseTo(200, 9);
    expect(m.avgLossUsd).toBeCloseTo(100, 9);
    expect(m.rewardToRisk).toBeCloseTo(2, 9);
  });

  test("identical returns read as maximally stable, never as unmeasured", () => {
    // Zero dispersion is flawless repeatability. Reporting it as null would
    // put it in the same bucket as "we could not tell".
    const m = coreMetrics([ep({ costUsd: 100, netPnlUsd: 20 }), ep({ costUsd: 100, netPnlUsd: 20 })]);
    expect(m.roiStdev).toBe(0);
    expect(m.roiStability).not.toBeNull();
    expect(m.roiStability!).toBeGreaterThan(0);
  });

  test("a single episode leaves stability genuinely unmeasured", () => {
    const m = coreMetrics([ep({ netPnlUsd: 20 })]);
    expect(m.roiStability).toBeNull();
  });

  test("open positions never count toward realised P&L", () => {
    const m = coreMetrics([ep({ netPnlUsd: 100 }), ep({ closed: false, closedAtMs: null, netPnlUsd: 9_999 })]);
    expect(m.realizedPnlUsd).toBeCloseTo(100, 9);
    expect(m.closedEpisodes).toBe(1);
    expect(m.openEpisodes).toBe(1);
  });

  test("ROI stability falls as results scatter, at identical total profit", () => {
    // Same P&L, same win rate, very different repeatability.
    const steady = coreMetrics([
      ep({ costUsd: 100, netPnlUsd: 19 }),
      ep({ costUsd: 100, netPnlUsd: 21 }),
      ep({ costUsd: 100, netPnlUsd: 20 }),
      ep({ costUsd: 100, netPnlUsd: 20 }),
    ]);
    const wild = coreMetrics([
      ep({ costUsd: 100, netPnlUsd: 200 }),
      ep({ costUsd: 100, netPnlUsd: -60 }),
      ep({ costUsd: 100, netPnlUsd: -60 }),
      ep({ costUsd: 100, netPnlUsd: 0 }),
    ]);
    expect(steady.realizedPnlUsd).toBeCloseTo(wild.realizedPnlUsd, 9);
    expect(steady.roiStability).not.toBeNull();
    expect(wild.roiStability).not.toBeNull();
    expect(steady.roiStability!).toBeGreaterThan(wild.roiStability!);
  });
});

describe("max drawdown", () => {
  test("measures the worst peak-to-trough fall of realised equity", () => {
    // +100 -> peak 100, then -40 -> equity 60. Drawdown 40 of 100 = 40%.
    const m = coreMetrics([
      ep({ closedAtMs: T0 + 1 * HOUR, netPnlUsd: 100 }),
      ep({ closedAtMs: T0 + 2 * HOUR, netPnlUsd: -40 }),
      ep({ closedAtMs: T0 + 3 * HOUR, netPnlUsd: 10 }),
    ]);
    expect(m.maxDrawdownUsd).toBeCloseTo(40, 9);
    expect(m.maxDrawdown).toBeCloseTo(0.4, 9);
  });

  test("orders by close time, not by the order episodes were supplied", () => {
    const outOfOrder = coreMetrics([
      ep({ closedAtMs: T0 + 3 * HOUR, netPnlUsd: 10 }),
      ep({ closedAtMs: T0 + 1 * HOUR, netPnlUsd: 100 }),
      ep({ closedAtMs: T0 + 2 * HOUR, netPnlUsd: -40 }),
    ]);
    expect(outOfOrder.maxDrawdown).toBeCloseTo(0.4, 9);
  });

  test("a curve that never goes above water reports no drawdown rather than 100%", () => {
    const m = coreMetrics([ep({ netPnlUsd: -50 }), ep({ netPnlUsd: -20 })]);
    expect(m.maxDrawdown).toBeNull();
  });
});

describe("entry and exit quality", () => {
  const token = tok("MOON");

  test("entry ROI is measured against prices actually observed after entry", () => {
    const path = new ObservedPricePath(HOUR);
    path.add(token, T0, 1);
    path.add(token, T0 + 1 * HOUR, 1.5);
    path.add(token, T0 + 6 * HOUR, 2);
    path.add(token, T0 + 24 * HOUR, 3);

    const e = entryQuality(
      [ep({ token, openedAtMs: T0, fills: [fill("buy", T0, 100, 1)] })],
      path,
    );
    expect(e.roiByHorizon[3600]).toBeCloseTo(0.5, 9);
    expect(e.roiByHorizon[6 * 3600]).toBeCloseTo(1.0, 9);
    expect(e.roiByHorizon[24 * 3600]).toBeCloseTo(2.0, 9);
    expect(e.sampleSize).toBe(1);
  });

  test("run-up hit rates say whether the token ever reached each multiple", () => {
    const path = new ObservedPricePath(HOUR);
    path.add(token, T0, 1);
    path.add(token, T0 + 2 * HOUR, 1.6); // +60%: clears +25 and +50, not +100
    const e = entryQuality([ep({ token, openedAtMs: T0, fills: [fill("buy", T0, 100, 1)] })], path);
    expect(e.hitRateByMultiple[0.25]).toBe(1);
    expect(e.hitRateByMultiple[0.5]).toBe(1);
    expect(e.hitRateByMultiple[1.0]).toBe(0);
  });

  test("with no price data every entry metric is null and the sample is zero", () => {
    const e = entryQuality([ep({ token })], EMPTY_PRICE_PATH);
    expect(e.sampleSize).toBe(0);
    expect(e.roiByHorizon[3600]).toBeNull();
    expect(e.hitRateByMultiple[0.5]).toBeNull();
    // Population is still reported, so the gap is visible rather than implied.
    expect(e.population).toBe(1);
  });

  test("capture ratio scores selling the top at 1 and selling early below it", () => {
    const path = new ObservedPricePath(HOUR);
    path.add(token, T0, 1);
    path.add(token, T0 + 2 * HOUR, 3); // the peak

    const soldTop = exitQuality(
      [ep({ token, openedAtMs: T0, closedAtMs: T0 + 2 * HOUR, fills: [fill("buy", T0, 100, 1), fill("sell", T0 + 2 * HOUR, 100, 3)] })],
      path,
    );
    expect(soldTop.captureRatio).toBeCloseTo(1, 6);

    const soldEarly = exitQuality(
      [ep({ token, openedAtMs: T0, closedAtMs: T0 + 1 * HOUR, fills: [fill("buy", T0, 100, 1), fill("sell", T0 + HOUR, 100, 2)] })],
      path,
    );
    // Took 1 of the 2 available: half the move.
    expect(soldEarly.captureRatio).toBeCloseTo(0.5, 6);
  });

  test("a rise after the exit counts as a premature exit", () => {
    const path = new ObservedPricePath(HOUR);
    path.add(token, T0, 1);
    path.add(token, T0 + HOUR, 2);
    path.add(token, T0 + 3 * HOUR, 4);

    const x = exitQuality(
      [ep({ token, openedAtMs: T0, closedAtMs: T0 + HOUR, fills: [fill("buy", T0, 100, 1), fill("sell", T0 + HOUR, 100, 2)] })],
      path,
    );
    expect(x.prematureExitRate).toBe(1);
    expect(x.avgReturnAfterExit).toBeCloseTo(1.0, 6);
  });
});

describe("observed price path", () => {
  const token = tok("AAA");

  test("refuses a price too far from the moment asked about", () => {
    const path = new ObservedPricePath(HOUR);
    path.add(token, T0, 5);
    expect(path.priceAt(token, T0 + 30 * 60 * 1000)).toBe(5);
    // Three hours away is a different market, not a stale quote.
    expect(path.priceAt(token, T0 + 3 * HOUR)).toBeUndefined();
  });

  test("builds a real series from the trader's own fills", () => {
    const path = ObservedPricePath.from([
      { id: "1", chain: "solana", leader: "L", ts: T0, side: "buy", asset: token, quote: tok("USDC"), assetAmount: 10, quoteAmount: 10, usdValue: 10, fillPxUsd: 1 },
      { id: "2", chain: "solana", leader: "L", ts: T0 + HOUR, side: "sell", asset: token, quote: tok("USDC"), assetAmount: 10, quoteAmount: 30, usdValue: 30, fillPxUsd: 3 },
    ]);
    expect(path.observationCount(token)).toBe(2);
    expect(path.maxBetween(token, T0, T0 + DAY)?.priceUsd).toBe(3);
  });
});

describe("episodes that straddle the history window", () => {
  test("selling more than was bought means the entry was never seen", () => {
    // The real signature, from live data: a position opened before the window
    // opened, topped up once inside it, then sold in full.
    const straddling = ep({ qtyBought: 100, qtySold: 3_400, netPnlUsd: 2_604 });
    expect(isSelfContained(straddling)).toBe(false);

    // A complete round trip balances, allowing for dust.
    expect(isSelfContained(ep({ qtyBought: 100, qtySold: 100 }))).toBe(true);
    expect(isSelfContained(ep({ qtyBought: 100, qtySold: 102 }))).toBe(true);
  });

  test("straddling episodes are excluded from every metric and counted", () => {
    const good = Array.from({ length: 4 }, (_, i) =>
      ep({ openedAtMs: T0 + i * HOUR, closedAtMs: T0 + (i + 1) * HOUR, qtyBought: 100, qtySold: 100, netPnlUsd: 10 }),
    );
    // A huge fake profit that would dominate if it were counted.
    const bad = ep({ qtyBought: 1, qtySold: 10_000, netPnlUsd: 100_000 });

    const m = coreMetrics([...good, bad]);
    expect(m.closedEpisodes).toBe(4);
    expect(m.straddlingEpisodes).toBe(1);
    expect(m.realizedPnlUsd).toBeCloseTo(40, 9);
  });

  test("open positions are not mistaken for straddling ones", () => {
    const m = coreMetrics([
      ep({ qtyBought: 100, qtySold: 100, netPnlUsd: 10 }),
      ep({ closed: false, closedAtMs: null, qtyBought: 100, qtySold: 0, netPnlUsd: 0 }),
    ]);
    expect(m.openEpisodes).toBe(1);
    expect(m.straddlingEpisodes).toBe(0);
  });

  test("the exclusion is reported as a gap so the window can be widened", () => {
    const good = Array.from({ length: 22 }, (_, i) =>
      ep({ openedAtMs: T0 + i * HOUR, closedAtMs: T0 + (i + 1) * HOUR, qtyBought: 100, qtySold: 100, netPnlUsd: 10 }),
    );
    const p = buildProfile("T", [...good, ep({ qtyBought: 1, qtySold: 9_999, netPnlUsd: 5_000 })]);
    expect(p.gaps.join(" ")).toMatch(/more was sold than was bought/);
  });
});

describe("outlier robustness", () => {
  const token = tok("MOON");

  test("one catastrophic exit cannot define the capture ratio", () => {
    const path = new ObservedPricePath(HOUR);
    path.add(token, T0, 1);
    path.add(token, T0 + HOUR, 1.1);

    // Sold at 0.1 against an entry of 1 and a peak of 1.1: the raw ratio is
    // about -9. Clamped and medianed, it cannot swamp the other episodes.
    const disaster = ep({
      token, openedAtMs: T0, closedAtMs: T0 + HOUR,
      fills: [fill("buy", T0, 100, 1), fill("sell", T0 + HOUR, 100, 0.1)],
    });
    const fine = ep({
      token, openedAtMs: T0, closedAtMs: T0 + HOUR,
      fills: [fill("buy", T0, 100, 1), fill("sell", T0 + HOUR, 100, 1.1)],
    });

    const x = exitQuality([disaster, fine, fine], path);
    expect(x.captureRatio).not.toBeNull();
    expect(x.captureRatio!).toBeGreaterThanOrEqual(-1);
    expect(x.captureRatio!).toBeLessThanOrEqual(2);
    // The two good exits are the majority, so the median follows them.
    expect(x.captureRatio!).toBeGreaterThan(0.5);
  });

  test("profitability follows the median return, not one moonshot", () => {
    const many = (n: number, over: Partial<Episode>) =>
      Array.from({ length: n }, (_, i) =>
        ep({ openedAtMs: T0 + i * HOUR, closedAtMs: T0 + (i + 1) * HOUR, ...over }),
      );

    // 24 modest trades plus one 200x. Mean ROI is enormous; median is not.
    const withMoonshot = [
      ...many(24, { costUsd: 100, netPnlUsd: 5 }),
      ep({ openedAtMs: T0 + 99 * HOUR, closedAtMs: T0 + 100 * HOUR, costUsd: 100, netPnlUsd: 20_000 }),
    ];
    const m = coreMetrics(withMoonshot);
    expect(m.avgRoi!).toBeGreaterThan(5);
    expect(m.medianRoi!).toBeLessThan(0.2);

    const p = buildProfile("T", withMoonshot);
    // Scoring the mean would peg profitability at the top of the curve.
    expect(p.dimensions.profitability!).toBeLessThan(95);
    expect(p.flags.join(" ")).toMatch(/single position/);
  });
});

describe("consistency needs time", () => {
  test("a single time bucket is a gap, not a high score", () => {
    // Everything inside one afternoon: no time dimension exists to judge.
    const sameDay = Array.from({ length: 25 }, (_, i) =>
      ep({ openedAtMs: T0 + i * 60_000, closedAtMs: T0 + (i + 1) * 60_000, netPnlUsd: 20 }),
    );
    const p = buildProfile("T", sameDay);
    expect(p.core.consistency.buckets).toBe(1);
    expect(p.dimensions.consistency).toBeNull();
    expect(p.gaps.join(" ")).toMatch(/Consistency unmeasured/);
  });

  test("enough weeks and it is scored normally", () => {
    const overWeeks = Array.from({ length: 25 }, (_, i) =>
      ep({ openedAtMs: T0 + i * 2 * DAY, closedAtMs: T0 + i * 2 * DAY + HOUR, netPnlUsd: 20 }),
    );
    const p = buildProfile("T", overWeeks);
    expect(p.core.consistency.buckets).toBeGreaterThanOrEqual(3);
    expect(p.dimensions.consistency).not.toBeNull();
  });
});

describe("skill versus exposure", () => {
  test("separates two traders with identical P&L but different position sizing", () => {
    const careful = skillVsExposure([
      ep({ netPnlUsd: 50, peakWeight: 0.04 }),
      ep({ netPnlUsd: 50, peakWeight: 0.04 }),
    ]);
    const reckless = skillVsExposure([
      ep({ netPnlUsd: 50, peakWeight: 0.4 }),
      ep({ netPnlUsd: 50, peakWeight: 0.4 }),
    ]);
    expect(careful.avgPeakWeight).toBeCloseTo(0.04, 9);
    expect(reckless.avgPeakWeight).toBeCloseTo(0.4, 9);
    // Same dollars, ten times the risk budget to get them.
    expect(careful.pnlPerExposureUsd!).toBeGreaterThan(reckless.pnlPerExposureUsd!);
  });

  test("flags a record carried by one position", () => {
    const s = skillVsExposure([
      ep({ netPnlUsd: 900 }),
      ep({ netPnlUsd: 50 }),
      ep({ netPnlUsd: 50 }),
    ]);
    expect(s.topEpisodeShare).toBeCloseTo(0.9, 9);
    expect(s.concentrated).toBe(true);
  });
});

describe("edge score", () => {
  const many = (n: number, over: Partial<Episode> = {}) =>
    Array.from({ length: n }, (_, i) =>
      ep({ closedAtMs: T0 + (i + 1) * HOUR, openedAtMs: T0 + i * HOUR, ...over }),
    );

  test("withholds a score until there is enough closed history", () => {
    const p = buildProfile("T", many(5));
    expect(p.edgeScore).toBeNull();
    expect(p.grade).toBe("insufficient-data");
    expect(p.flags.join(" ")).toMatch(/closed positions/);
  });

  test("renormalises over measurable dimensions instead of scoring gaps as zero", () => {
    // No price path, so entry and exit cannot be judged at all.
    const p = buildProfile("T", many(25));
    expect(p.dimensions.entry).toBeNull();
    expect(p.dimensions.exit).toBeNull();
    expect(p.edgeScore).not.toBeNull();
    // Scoring the two gaps as zero would drag a solid trader under 70.
    expect(p.edgeScore!).toBeGreaterThan(50);
    expect(p.gaps.join(" ")).toMatch(/Entry quality unmeasured/);
    expect(p.flags.join(" ")).toMatch(/provisional/);
  });

  test("the reckless trader scores below the careful one at equal profit", () => {
    const careful = buildProfile("CAREFUL", many(25, { peakWeight: 0.03, netPnlUsd: 20 }));
    const reckless = buildProfile("RECKLESS", many(25, { peakWeight: 0.45, netPnlUsd: 20 }));
    expect(careful.edgeScore!).toBeGreaterThan(reckless.edgeScore!);
    expect(reckless.flags.join(" ")).toMatch(/% of book/);
  });

  test("a losing trader cannot reach a passing grade on style alone", () => {
    const p = buildProfile("LOSER", many(25, { netPnlUsd: -30, costUsd: 100, proceedsUsd: 70 }));
    expect(p.dimensions.profitability!).toBeLessThan(30);
    expect(p.flags.join(" ")).toMatch(/Net loss/);
  });

  test("every dimension stays within 0..100 and the score tracks them", () => {
    const p = buildProfile("T", many(30, { netPnlUsd: 40 }));
    for (const v of Object.values(p.dimensions)) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(p.edgeScore!).toBeGreaterThanOrEqual(0);
    expect(p.edgeScore!).toBeLessThanOrEqual(100);
  });

  test("config is honoured rather than hardcoded", () => {
    const p = buildProfile("T", many(10), EMPTY_PRICE_PATH, { ...DEFAULT_ABILITY, minClosedEpisodes: 5 });
    expect(p.edgeScore).not.toBeNull();
  });
});
