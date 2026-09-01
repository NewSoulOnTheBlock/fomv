import type { LeaderTrade } from "../types.js";
import { buildEpisodes, type Episode } from "./episodes.js";
import {
  capacity,
  hygiene,
  latencyDecay,
  performance,
  process as processMetrics,
  type CapacityMetrics,
  type HygieneMetrics,
  type LatencyMetrics,
  type MarketLookup,
  type PerformanceMetrics,
  type ProcessMetrics,
} from "./metrics.js";

export interface ScoringConfig {
  /** Impact cap the vault would trade under; drives the capacity calculation. */
  maxPctOfLiquidity: number;
  /** Below this capacity a vault is not worth launching. */
  minViableVaultUsd: number;
  /** Delay at which copyability is judged, in seconds. */
  judgeLatencySec: number;
  /** Closed episodes needed before a composite is published at all. */
  minClosedEpisodes: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  maxPctOfLiquidity: 0.01,
  minViableVaultUsd: 50_000,
  judgeLatencySec: 10,
  minClosedEpisodes: 20,
};

export interface CopyabilityScore {
  address: string;
  /** 0-100, or null when there is not enough closed history to judge. */
  composite: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | "insufficient-data";
  components: {
    performance: number | null;
    capacity: number | null;
    latency: number | null;
    process: number | null;
    hygiene: number | null;
  };
  /** Largest vault that could realistically follow this trader. */
  capacityUsd: number | null;
  /** Plain-language reasons a depositor should hesitate. */
  flags: string[];
  raw: {
    performance: PerformanceMetrics;
    capacity: CapacityMetrics;
    latency: LatencyMetrics;
    process: ProcessMetrics;
    hygiene: HygieneMetrics;
    episodes: number;
  };
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

/** Map a value through a piecewise-linear curve of [input, score] points. */
function curve(x: number, points: [number, number][]): number {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
}

export function scoreTrader(
  address: string,
  trades: LeaderTrade[],
  lookup: MarketLookup,
  equityAt?: (tsMs: number) => number | undefined,
  config: ScoringConfig = DEFAULT_SCORING,
): CopyabilityScore {
  const episodes = buildEpisodes(trades, equityAt);
  return scoreEpisodes(address, episodes, lookup, config);
}

export function scoreEpisodes(
  address: string,
  episodes: Episode[],
  lookup: MarketLookup,
  config: ScoringConfig = DEFAULT_SCORING,
): CopyabilityScore {
  const perf = performance(episodes);
  const cap = capacity(episodes, lookup, config.maxPctOfLiquidity);
  const lat = latencyDecay(episodes, lookup, [3, config.judgeLatencySec, 30]);
  const proc = processMetrics(episodes);
  const hyg = hygiene(episodes, lookup);
  const flags: string[] = [];

  const raw = { performance: perf, capacity: cap, latency: lat, process: proc, hygiene: hyg, episodes: episodes.length };

  if (perf.closedEpisodes < config.minClosedEpisodes) {
    flags.push(
      `Only ${perf.closedEpisodes} closed positions; ${config.minClosedEpisodes} needed before a score means anything`,
    );
    return {
      address,
      composite: null,
      grade: "insufficient-data",
      components: { performance: null, capacity: null, latency: null, process: null, hygiene: null },
      capacityUsd: cap.capacityUsd,
      flags,
      raw,
    };
  }

  // --- Performance, judged net of fees ---------------------------------------
  let performanceScore: number;
  if (perf.netPnlUsd <= 0) {
    performanceScore = clamp(curve(perf.winRate, [[0, 0], [0.5, 15], [1, 30]]));
    flags.push(`Net loss of $${Math.abs(perf.netPnlUsd).toFixed(0)} after fomo fees`);
  } else {
    performanceScore = clamp(curve(perf.profitFactor ?? 3, [[1, 45], [1.5, 65], [2, 80], [3, 92], [5, 100]]));
  }
  if (perf.grossPnlUsd > 0 && perf.netPnlUsd <= 0) {
    // The signature failure of a high-frequency small-ticket trader.
    flags.push(`Profitable gross, unprofitable net: fees cost ${perf.feeDragBps.toFixed(0)}bps of volume`);
  }

  // --- Capacity --------------------------------------------------------------
  const capacityScore =
    cap.capacityUsd === null
      ? null
      : clamp(
          curve(Math.log10(Math.max(1, cap.capacityUsd)), [
            [3, 0], // $1k
            [4, 20], // $10k
            [5, 55], // $100k
            [6, 85], // $1m
            [7, 100], // $10m
          ]),
        );
  if (cap.capacityUsd !== null && cap.capacityUsd < config.minViableVaultUsd) {
    flags.push(
      `Capacity is about $${Math.round(cap.capacityUsd).toLocaleString()}; a larger vault cannot hold their weights`,
    );
  }
  if (cap.sampleSize < Math.max(5, perf.closedEpisodes * 0.25)) {
    flags.push(`Capacity estimated from only ${cap.sampleSize} episodes with known liquidity`);
  }

  // --- Latency ---------------------------------------------------------------
  const retention = lat.retention.get(config.judgeLatencySec) ?? null;
  const latencyScore =
    retention === null ? null : clamp(curve(retention, [[0, 0], [0.3, 25], [0.6, 60], [0.85, 90], [1, 100]]));
  if (retention !== null && retention < 0.5) {
    flags.push(
      `Edge halves within ${config.judgeLatencySec}s: only ${(retention * 100).toFixed(0)}% of P&L survives the delay a vault cannot avoid`,
    );
  }
  if (retention === null) {
    flags.push("Latency sensitivity could not be measured; no historical prices for these tokens");
  }

  // --- Process ---------------------------------------------------------------
  let processScore = 60;
  if (proc.topEpisodeShare !== null) {
    processScore = clamp(curve(proc.topEpisodeShare, [[0.1, 100], [0.3, 80], [0.5, 55], [0.8, 25], [1, 10]]));
    if (proc.topEpisodeShare > 0.5) {
      flags.push(
        `One position produced ${(proc.topEpisodeShare * 100).toFixed(0)}% of all profit; this may be luck rather than process`,
      );
    }
  }
  if (proc.medianHoldSec !== null && proc.medianHoldSec < 60) {
    flags.push(`Median hold is ${proc.medianHoldSec.toFixed(0)}s; a vault will not reliably keep up`);
    processScore = Math.min(processScore, 40);
  }
  if (proc.distinctTokens < 10) {
    flags.push(`Only ${proc.distinctTokens} distinct tokens traded; a narrow sample`);
  }

  // --- Hygiene ---------------------------------------------------------------
  let hygieneScore: number | null = null;
  if (hyg.rugRate !== null) {
    hygieneScore = clamp(curve(hyg.rugRate, [[0, 100], [0.05, 85], [0.15, 55], [0.3, 25], [0.5, 0]]));
    if (hyg.rugRate > 0.15) {
      flags.push(`${(hyg.rugRate * 100).toFixed(0)}% of entries fell 80%+ within an hour`);
    }
  }
  if (hyg.thinPoolRate !== null && hyg.thinPoolRate > 0.4) {
    flags.push(`${(hyg.thinPoolRate * 100).toFixed(0)}% of entries were into pools under $25k`);
  }

  // --- Composite -------------------------------------------------------------
  const weighted: [number | null, number][] = [
    [performanceScore, 0.3],
    [capacityScore, 0.25],
    [latencyScore, 0.25],
    [processScore, 0.12],
    [hygieneScore, 0.08],
  ];
  let sum = 0;
  let weight = 0;
  for (const [score, w] of weighted) {
    if (score === null) continue;
    sum += score * w;
    weight += w;
  }
  let composite = weight > 0 ? sum / weight : 0;

  // Gates, not weights.
  //
  // Capacity and latency are not qualities a great return can compensate for.
  // A trader with $8k capacity and spectacular P&L is still not something a
  // vault can be built on, and averaging would let the P&L hide that.
  if (cap.capacityUsd !== null && cap.capacityUsd < config.minViableVaultUsd) {
    composite = Math.min(composite, 40);
  }
  if (retention !== null && retention < 0.3) {
    composite = Math.min(composite, 35);
  }
  if (perf.netPnlUsd <= 0) {
    composite = Math.min(composite, 30);
  }

  return {
    address,
    composite: Math.round(composite),
    grade: gradeFor(composite),
    components: {
      performance: Math.round(performanceScore),
      capacity: capacityScore === null ? null : Math.round(capacityScore),
      latency: latencyScore === null ? null : Math.round(latencyScore),
      process: Math.round(processScore),
      hygiene: hygieneScore === null ? null : Math.round(hygieneScore),
    },
    capacityUsd: cap.capacityUsd,
    flags,
    raw,
  };
}

function gradeFor(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}
