import type { Episode } from "./episodes.js";
import { EMPTY_PRICE_PATH, type PricePath } from "./pricepath.js";
import { median, percentile } from "./metrics.js";

/**
 * A trader ability profile, rather than a P&L leaderboard.
 *
 * # Why not just rank by profit
 *
 * P&L rewards whoever took the most risk and got away with it. Someone who
 * puts 40% of their book into one launch and doubles it outranks someone who
 * ground out the same dollars on controlled size, even though only one of them
 * has a repeatable process. Ranking on profit alone is a casino with extra
 * steps -- it selects for survivors of variance and calls it skill.
 *
 * So every dimension here is deliberately scale-free where it can be, and
 * where it cannot, the exposure that produced the return is reported next to
 * it. `skillVsExposure` exists to make that comparison impossible to skip.
 *
 * # What it refuses to do
 *
 * Any metric that cannot be measured from the data at hand reports `null`, and
 * a `null` never averages into a score as a zero or a default. A dimension
 * built entirely from unmeasurable parts is itself `null`, and the Edge Score
 * renormalises over what survived rather than pretending the gap was neutral.
 * A confident number computed from nothing is worse than a visible hole.
 */

export interface AbilityConfig {
  /** Horizons after entry at which the token is re-priced, in seconds. */
  entryHorizonsSec: number[];
  /** Multiples an entry is checked against, e.g. 0.25 = did it ever go +25%. */
  runupMultiples: number[];
  /** Closed episodes below which no composite is published. */
  minClosedEpisodes: number;
  /** Bucket width for consistency, in ms. Defaults to a week. */
  consistencyBucketMs: number;
  /** Minimum buckets before consistency is judged. */
  minConsistencyBuckets: number;
}

export const DEFAULT_ABILITY: AbilityConfig = {
  entryHorizonsSec: [3600, 6 * 3600, 24 * 3600],
  runupMultiples: [0.25, 0.5, 1.0],
  minClosedEpisodes: 20,
  consistencyBucketMs: 7 * 24 * 3600 * 1000,
  minConsistencyBuckets: 3,
};

// ---------------------------------------------------------------------------
// The ten core metrics
// ---------------------------------------------------------------------------

export interface CoreMetrics {
  /** 1. Realised P&L from closed episodes, net of fomo fees. */
  realizedPnlUsd: number;
  /** 2. Share of closed episodes that finished profitable, 0..1. */
  winRate: number | null;
  /** 3. Gross profit / gross loss. `null` when there are no losses to divide by. */
  profitFactor: number | null;
  /** 4. Mean return on capital committed per episode, as a fraction. */
  avgRoi: number | null;
  medianRoi: number | null;
  /**
   * 5. Risk-adjusted return: mean ROI over the standard deviation of ROI.
   *
   * Sharpe-*style*, not Sharpe. A real Sharpe ratio is computed on a periodic
   * return series against a risk-free rate; this is per-episode dispersion
   * with no time normalisation, because episodes are irregular events rather
   * than periods. It answers "how much of this return is repeatable versus
   * scatter", which is the question that matters here, and it is named
   * separately so nobody annualises it by mistake.
   *
   * `null` means fewer than two closed episodes, i.e. genuinely unmeasured.
   * Perfectly identical returns -- dispersion of exactly zero, which real data
   * never produces -- are reported at the top of the scale rather than as
   * `null`, because "flawlessly repeatable" and "unknown" must not share a
   * representation.
   */
  roiStability: number | null;
  roiStdev: number | null;
  /** 6. Largest peak-to-trough fall of the realised equity curve, 0..1. */
  maxDrawdown: number | null;
  maxDrawdownUsd: number | null;
  /** 7. Average win over average loss. */
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  rewardToRisk: number | null;
  /** 8 and 9 live in their own structures below. */
  /** 10. Dispersion of bucketed performance. Lower is steadier. */
  consistency: ConsistencyMetrics;

  closedEpisodes: number;
  openEpisodes: number;
  totalEpisodes: number;
  /**
   * Closed episodes discarded because they straddled the start of the history
   * window, so their cost basis was never observed.
   */
  straddlingEpisodes: number;
}

export interface EntryQualityMetrics {
  /** Mean return from entry to each horizon, keyed by horizon in seconds. */
  roiByHorizon: Record<number, number | null>;
  /** Share of entries whose token later reached each multiple, keyed by multiple. */
  hitRateByMultiple: Record<number, number | null>;
  /** Median time from entry to the best observed price, in seconds. */
  medianTimeToPeakSec: number | null;
  /** Entries with enough price observations after them to judge. */
  sampleSize: number;
  /** Entries examined, judged or not. Lets the UI show coverage honestly. */
  population: number;
}

export interface ExitQualityMetrics {
  /**
   * Share of the move actually captured. Median, clamped per episode.
   *
   * `(exit - entry) / (peakAfterEntry - entry)`. A trader who sold the exact
   * top scores 1. Selling into further upside scores below 1, which is the
   * honest reading: the upside existed and they did not take it.
   *
   * Two guards, both learned from real data. The ratio is unbounded below --
   * an exit far under entry while the peak barely cleared it yields an
   * arbitrarily large negative -- so each episode is clamped to
   * [MIN_CAPTURE, MAX_CAPTURE] before aggregation, and the aggregate is a
   * **median** rather than a mean. Without both, one catastrophic position
   * defines the dimension for every other trade the trader ever made.
   */
  captureRatio: number | null;
  /** Mean of the same clamped series, for anyone who wants to see the skew. */
  captureRatioMean: number | null;
  /** Mean return the token delivered *after* the exit. Positive means they left money behind. */
  avgReturnAfterExit: number | null;
  /** Share of exits followed by a further rise -- sold too early. */
  prematureExitRate: number | null;
  sampleSize: number;
  population: number;
}

export interface ConsistencyMetrics {
  /** Per-bucket realised P&L, oldest first. */
  bucketPnlUsd: number[];
  /** Share of buckets that were profitable. */
  profitableBucketRate: number | null;
  /** Coefficient of variation of bucket P&L. Lower is steadier. */
  bucketVariation: number | null;
  /** Share of distinct tokens that were profitable. */
  profitableTokenRate: number | null;
  buckets: number;
}

/**
 * Skill separated from exposure.
 *
 * The distinction the whole dashboard exists to make. Two traders return the
 * same dollars; one did it on 4% position sizes and the other on 40%. Without
 * this block they look identical, and the second one is a different product
 * entirely -- for a pooled vault, a worse one, because their drawdowns arrive
 * in sizes a depositor did not agree to.
 */
export interface SkillVsExposure {
  /** Mean peak fraction of book committed per episode, 0..1. */
  avgPeakWeight: number | null;
  maxPeakWeight: number | null;
  /**
   * Realised P&L per whole unit of book committed, cumulative across episodes.
   *
   * Return divided by the risk budget that produced it, so the trader who got
   * there on small size scores higher. The unit is deliberately odd -- dollars
   * per unit of book-fraction -- and the figure is large whenever positions
   * are small, so exposureUnits is published beside it rather than leaving a
   * bare ratio to be misread as a per-trade number.
   */
  pnlPerExposureUsd: number | null;
  /** Sum of peak weights across closed episodes: the denominator above. */
  exposureUnits: number;
  /** Share of total profit that came from the single best episode. */
  topEpisodeShare: number | null;
  /**
   * True when the record depends on one or two outcomes.
   *
   * Not a judgement about the trader, a statement about what the sample can
   * support: a track record carried by one position has not demonstrated
   * repeatability whatever its total.
   */
  concentrated: boolean;
}

export type DimensionName = "entry" | "profitability" | "risk" | "exit" | "consistency";

export interface AbilityProfile {
  address: string;
  /** 0-100, or null when there is not enough closed history. */
  edgeScore: number | null;
  grade: "S" | "A" | "B" | "C" | "D" | "F" | "insufficient-data";
  dimensions: Record<DimensionName, number | null>;
  core: CoreMetrics;
  entry: EntryQualityMetrics;
  exit: ExitQualityMetrics;
  skillVsExposure: SkillVsExposure;
  /** Plain-language cautions for a depositor. */
  flags: string[];
  /** Dimensions that could not be measured, and why. */
  gaps: string[];
}

// ---------------------------------------------------------------------------

/**
 * Tolerance on quantity balance before an episode is called straddling.
 *
 * Small overshoots are ordinary: airdrops, dust, rounding across decimals.
 * Selling meaningfully more than was bought is not.
 */
const QTY_BALANCE_TOLERANCE = 0.05;

/**
 * Whether the whole of an episode was observed.
 *
 * A history window has an edge, and positions opened before it get sold
 * inside it. Those episodes arrive with a cost basis that was never seen: a
 * few late top-up buys stand in for the real entry, so the entry price is far
 * too high while the realised P&L still looks fine. On a real 18-hour sample
 * of a high-frequency trader this affected 15 of 24 closed episodes, and it
 * pushed median capture ratio *negative* for a trader with a 79% win rate --
 * the two numbers were describing different things.
 *
 * Selling materially more than was bought is the signature, and it is the only
 * reliable one available: quantities balance for a complete round trip and
 * cannot for a straddling one. Such episodes are excluded from every metric
 * rather than corrected, because the missing entry price is genuinely unknown.
 */
export function isSelfContained(ep: Episode, tolerance = QTY_BALANCE_TOLERANCE): boolean {
  if (ep.qtyBought <= 0) return false;
  return ep.qtySold <= ep.qtyBought * (1 + tolerance);
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

/** Piecewise-linear map through [input, score] points. */
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

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Mean ROI over its own dispersion, guarded at both ends.
 *
 * Capped rather than left unbounded: with only a handful of episodes a tiny
 * denominator produces a spectacular ratio that says more about the sample
 * size than the trader, and an uncapped value would dominate any score it
 * feeds into.
 */
const MAX_ROI_STABILITY = 10;

function roiStabilityOf(avgRoi: number | null, sd: number | null): number | null {
  if (avgRoi === null || sd === null) return null;
  if (sd === 0) return avgRoi > 0 ? MAX_ROI_STABILITY : avgRoi < 0 ? -MAX_ROI_STABILITY : 0;
  return Math.max(-MAX_ROI_STABILITY, Math.min(MAX_ROI_STABILITY, avgRoi / sd));
}

/**
 * Bounds on a single episode's capture ratio.
 *
 * -1 is "lost as much as the run-up offered"; 2 is "captured twice the
 * observed peak move", which happens when the true peak fell between
 * observations. Clamping keeps a sparse price path from producing a number
 * that swamps the median it feeds.
 */
const MIN_CAPTURE = -1;
const MAX_CAPTURE = 2;

/** Return on capital committed, for one closed episode. */
function episodeRoi(ep: Episode): number | null {
  return ep.costUsd > 0 ? ep.netPnlUsd / ep.costUsd : null;
}

// ---------------------------------------------------------------------------
// 1-7 and 10
// ---------------------------------------------------------------------------

export function coreMetrics(episodes: Episode[], config: AbilityConfig = DEFAULT_ABILITY): CoreMetrics {
  const allClosed = episodes.filter((e) => e.closed);
  const closed = allClosed.filter((e) => isSelfContained(e));
  const straddling = allClosed.length - closed.length;
  const rois = closed.map(episodeRoi).filter((r): r is number => r !== null);

  const wins = closed.filter((e) => e.netPnlUsd > 0);
  const losses = closed.filter((e) => e.netPnlUsd < 0);
  const grossProfit = wins.reduce((a, e) => a + e.netPnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, e) => a + e.netPnlUsd, 0));

  const avgWinUsd = wins.length ? grossProfit / wins.length : null;
  const avgLossUsd = losses.length ? grossLoss / losses.length : null;

  const sd = stdev(rois);
  const avgRoi = mean(rois);

  return {
    realizedPnlUsd: closed.reduce((a, e) => a + e.netPnlUsd, 0),
    winRate: closed.length ? wins.length / closed.length : null,
    // No losses at all is not an infinite profit factor, it is an unmeasured
    // one: the denominator has not been tested yet.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgRoi,
    medianRoi: median(rois),
    roiStability: roiStabilityOf(avgRoi, sd),
    roiStdev: sd,
    ...drawdown(closed),
    avgWinUsd,
    avgLossUsd,
    rewardToRisk: avgWinUsd !== null && avgLossUsd !== null && avgLossUsd > 0 ? avgWinUsd / avgLossUsd : null,
    consistency: consistencyMetrics(closed, config),
    closedEpisodes: closed.length,
    openEpisodes: episodes.length - allClosed.length,
    totalEpisodes: episodes.length,
    straddlingEpisodes: straddling,
  };
}

/**
 * Maximum peak-to-trough fall of the realised equity curve.
 *
 * Built from closed episodes in the order they *closed*, which is when the P&L
 * became real. This is a realised-P&L drawdown, not a mark-to-market one: it
 * cannot see the paper pain of an open position that later recovered, so it is
 * a floor on the true drawdown rather than the whole of it. Stated here
 * because an under-reported drawdown is the one error in this file that would
 * flatter a trader.
 */
function drawdown(closed: Episode[]): { maxDrawdown: number | null; maxDrawdownUsd: number | null } {
  if (closed.length === 0) return { maxDrawdown: null, maxDrawdownUsd: null };

  const ordered = [...closed].sort((a, b) => (a.closedAtMs ?? 0) - (b.closedAtMs ?? 0));
  let equity = 0;
  let peak = 0;
  let worstUsd = 0;
  let worstFrac = 0;

  for (const ep of ordered) {
    equity += ep.netPnlUsd;
    if (equity > peak) peak = equity;
    const declineUsd = peak - equity;
    if (declineUsd > worstUsd) worstUsd = declineUsd;
    // Only meaningful once the curve has been above water; a drawdown from a
    // peak of zero has no denominator.
    if (peak > 0 && declineUsd / peak > worstFrac) worstFrac = declineUsd / peak;
  }

  return { maxDrawdown: peak > 0 ? worstFrac : null, maxDrawdownUsd: worstUsd };
}

function consistencyMetrics(closed: Episode[], config: AbilityConfig): ConsistencyMetrics {
  if (closed.length === 0) {
    return { bucketPnlUsd: [], profitableBucketRate: null, bucketVariation: null, profitableTokenRate: null, buckets: 0 };
  }

  const times = closed.map((e) => e.closedAtMs ?? e.openedAtMs);
  const start = Math.min(...times);
  const bucketOf = (ts: number) => Math.floor((ts - start) / config.consistencyBucketMs);

  const buckets = new Map<number, number>();
  for (const ep of closed) {
    const b = bucketOf(ep.closedAtMs ?? ep.openedAtMs);
    buckets.set(b, (buckets.get(b) ?? 0) + ep.netPnlUsd);
  }
  const bucketPnlUsd = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

  const byToken = new Map<string, number>();
  for (const ep of closed) {
    const k = `${ep.token.chain}:${ep.token.address}`;
    byToken.set(k, (byToken.get(k) ?? 0) + ep.netPnlUsd);
  }
  const tokenPnls = [...byToken.values()];

  const m = mean(bucketPnlUsd);
  const sd = stdev(bucketPnlUsd);

  return {
    bucketPnlUsd,
    profitableBucketRate: bucketPnlUsd.length ? bucketPnlUsd.filter((v) => v > 0).length / bucketPnlUsd.length : null,
    // Coefficient of variation against the *magnitude* of the mean, so a
    // trader whose average bucket is a loss does not get a flattering sign.
    bucketVariation:
      bucketPnlUsd.length >= config.minConsistencyBuckets && m !== null && sd !== null && Math.abs(m) > 0
        ? sd / Math.abs(m)
        : null,
    profitableTokenRate: tokenPnls.length ? tokenPnls.filter((v) => v > 0).length / tokenPnls.length : null,
    buckets: bucketPnlUsd.length,
  };
}

// ---------------------------------------------------------------------------
// 8. Entry quality
// ---------------------------------------------------------------------------

export function entryQuality(
  episodes: Episode[],
  path: PricePath,
  config: AbilityConfig = DEFAULT_ABILITY,
): EntryQualityMetrics {
  const roiByHorizon: Record<number, number | null> = {};
  const hitRateByMultiple: Record<number, number | null> = {};
  const horizonSamples = new Map<number, number[]>(config.entryHorizonsSec.map((h) => [h, []]));
  const multipleHits = new Map<number, { hit: number; seen: number }>(
    config.runupMultiples.map((m) => [m, { hit: 0, seen: 0 }]),
  );
  const timesToPeak: number[] = [];

  let sampleSize = 0;

  // Same exclusion as the core metrics: an entry price averaged over late
  // top-up buys is not the price they entered at.
  const judged = episodes.filter((e) => !e.closed || isSelfContained(e));

  for (const ep of judged) {
    const entryPx = entryPrice(ep);
    if (entryPx === null || entryPx <= 0) continue;

    let ok = false;

    for (const h of config.entryHorizonsSec) {
      const at = path.priceAt(ep.token, ep.openedAtMs + h * 1000);
      if (at === undefined) continue;
      horizonSamples.get(h)!.push(at / entryPx - 1);
      ok = true;
    }

    // Run-ups are measured over the longest horizon so the multiples and the
    // ROI figures describe the same window.
    const windowMs = Math.max(...config.entryHorizonsSec) * 1000;
    const peak = path.maxBetween(ep.token, ep.openedAtMs, ep.openedAtMs + windowMs);
    if (peak) {
      const runup = peak.priceUsd / entryPx - 1;
      for (const m of config.runupMultiples) {
        const rec = multipleHits.get(m)!;
        rec.seen++;
        if (runup >= m) rec.hit++;
      }
      timesToPeak.push((peak.tsMs - ep.openedAtMs) / 1000);
      ok = true;
    }

    if (ok) sampleSize++;
  }

  for (const h of config.entryHorizonsSec) roiByHorizon[h] = mean(horizonSamples.get(h)!);
  for (const m of config.runupMultiples) {
    const rec = multipleHits.get(m)!;
    hitRateByMultiple[m] = rec.seen > 0 ? rec.hit / rec.seen : null;
  }

  return {
    roiByHorizon,
    hitRateByMultiple,
    medianTimeToPeakSec: median(timesToPeak),
    sampleSize,
    population: judged.length,
  };
}

/** Volume-weighted entry price for an episode. */
function entryPrice(ep: Episode): number | null {
  const buys = ep.fills.filter((f) => f.side === "buy" && f.qty > 0);
  if (buys.length === 0) return null;
  const qty = buys.reduce((a, f) => a + f.qty, 0);
  const usd = buys.reduce((a, f) => a + f.usdValue, 0);
  return qty > 0 ? usd / qty : null;
}

/** Volume-weighted exit price for an episode. */
function exitPrice(ep: Episode): number | null {
  const sells = ep.fills.filter((f) => f.side === "sell" && f.qty > 0);
  if (sells.length === 0) return null;
  const qty = sells.reduce((a, f) => a + f.qty, 0);
  const usd = sells.reduce((a, f) => a + f.usdValue, 0);
  return qty > 0 ? usd / qty : null;
}

// ---------------------------------------------------------------------------
// 9. Exit quality
// ---------------------------------------------------------------------------

export function exitQuality(
  episodes: Episode[],
  path: PricePath,
  config: AbilityConfig = DEFAULT_ABILITY,
): ExitQualityMetrics {
  const closed = episodes.filter((e) => e.closed && e.closedAtMs !== null && isSelfContained(e));
  const captures: number[] = [];
  const afterExit: number[] = [];
  let premature = 0;
  let afterSeen = 0;
  let sampleSize = 0;

  const windowMs = Math.max(...config.entryHorizonsSec) * 1000;

  for (const ep of closed) {
    const entryPx = entryPrice(ep);
    const exitPx = exitPrice(ep);
    const closedAt = ep.closedAtMs!;
    if (entryPx === null || exitPx === null || entryPx <= 0) continue;

    let ok = false;

    // How much of the move from entry to the best price was taken.
    const peak = path.maxBetween(ep.token, ep.openedAtMs, closedAt + windowMs);
    if (peak && peak.priceUsd > entryPx) {
      const raw = (exitPx - entryPx) / (peak.priceUsd - entryPx);
      captures.push(Math.max(MIN_CAPTURE, Math.min(MAX_CAPTURE, raw)));
      ok = true;
    }

    // What the token did after they left.
    const after = path.maxBetween(ep.token, closedAt, closedAt + windowMs);
    if (after && exitPx > 0) {
      const ret = after.priceUsd / exitPx - 1;
      afterExit.push(ret);
      afterSeen++;
      if (ret > 0) premature++;
      ok = true;
    }

    if (ok) sampleSize++;
  }

  return {
    captureRatio: median(captures),
    captureRatioMean: mean(captures),
    avgReturnAfterExit: median(afterExit),
    prematureExitRate: afterSeen > 0 ? premature / afterSeen : null,
    sampleSize,
    population: closed.length,
  };
}

// ---------------------------------------------------------------------------
// Skill versus exposure
// ---------------------------------------------------------------------------

export function skillVsExposure(episodes: Episode[]): SkillVsExposure {
  const closed = episodes.filter((e) => e.closed && isSelfContained(e));
  const weights = episodes.map((e) => e.peakWeight).filter((w) => w > 0);
  const avgPeakWeight = mean(weights);

  const pnl = closed.reduce((a, e) => a + e.netPnlUsd, 0);
  const profits = closed.filter((e) => e.netPnlUsd > 0).map((e) => e.netPnlUsd);
  const totalProfit = profits.reduce((a, b) => a + b, 0);
  const best = profits.length ? Math.max(...profits) : 0;
  const topEpisodeShare = totalProfit > 0 ? best / totalProfit : null;

  // Sum of exposure taken, as a proxy for the risk budget spent earning it.
  const exposureUnits = closed.reduce((a, e) => a + Math.max(0, e.peakWeight), 0);

  return {
    avgPeakWeight,
    maxPeakWeight: weights.length ? Math.max(...weights) : null,
    pnlPerExposureUsd: exposureUnits > 0 ? pnl / exposureUnits : null,
    exposureUnits,
    topEpisodeShare,
    concentrated: topEpisodeShare !== null && topEpisodeShare > 0.5,
  };
}

// ---------------------------------------------------------------------------
// The five dimensions, and the Edge Score
// ---------------------------------------------------------------------------

/** Weights must sum to 1 across whatever dimensions are measurable. */
const DIMENSION_WEIGHTS: Record<DimensionName, number> = {
  profitability: 0.3,
  risk: 0.25,
  entry: 0.15,
  exit: 0.15,
  consistency: 0.15,
};

export function buildProfile(
  address: string,
  episodes: Episode[],
  path: PricePath = EMPTY_PRICE_PATH,
  config: AbilityConfig = DEFAULT_ABILITY,
): AbilityProfile {
  const core = coreMetrics(episodes, config);
  const entry = entryQuality(episodes, path, config);
  const exit = exitQuality(episodes, path, config);
  const exposure = skillVsExposure(episodes);

  const flags: string[] = [];
  const gaps: string[] = [];

  if (core.closedEpisodes < config.minClosedEpisodes) {
    return {
      address,
      edgeScore: null,
      grade: "insufficient-data",
      dimensions: { entry: null, profitability: null, risk: null, exit: null, consistency: null },
      core,
      entry,
      exit,
      skillVsExposure: exposure,
      flags: [
        `Only ${core.closedEpisodes} closed positions; ${config.minClosedEpisodes} needed before a profile means anything`,
      ],
      gaps,
    };
  }

  // --- Profitability -------------------------------------------------------
  let profitability: number | null;
  if (core.realizedPnlUsd <= 0) {
    profitability = clamp(curve(core.winRate ?? 0, [[0, 0], [0.5, 12], [1, 25]]));
    flags.push(`Net loss of $${Math.abs(core.realizedPnlUsd).toFixed(0)} across closed positions`);
  } else {
    const pf = core.profitFactor;
    // Median, not mean. On memecoins the mean ROI is one moonshot on a tiny
    // position: this trader's mean is 1352% against a median of 172%. Scoring
    // the mean would rank a lottery ticket above a repeatable process, which
    // is the exact failure this dashboard exists to avoid.
    const roi = core.medianRoi;
    const parts: number[] = [];
    if (pf !== null) parts.push(clamp(curve(pf, [[1, 40], [1.5, 60], [2, 75], [3, 90], [5, 100]])));
    if (roi !== null) parts.push(clamp(curve(roi, [[0, 35], [0.1, 55], [0.25, 72], [0.5, 88], [1, 100]])));
    profitability = parts.length ? mean(parts) : null;
    if (pf === null) gaps.push("Profit factor undefined: no losing positions in the sample yet");
  }

  // --- Risk management -----------------------------------------------------
  const riskParts: number[] = [];
  if (core.maxDrawdown !== null) {
    riskParts.push(clamp(curve(core.maxDrawdown, [[0, 100], [0.1, 88], [0.2, 72], [0.35, 50], [0.6, 20], [1, 0]])));
  }
  if (core.rewardToRisk !== null) {
    riskParts.push(clamp(curve(core.rewardToRisk, [[0.5, 15], [1, 45], [1.5, 68], [2.5, 88], [4, 100]])));
  }
  if (exposure.avgPeakWeight !== null) {
    // Smaller typical position is better risk control, sharply penalised past
    // the point where one position can materially dent the book.
    riskParts.push(clamp(curve(exposure.avgPeakWeight, [[0, 100], [0.05, 90], [0.1, 75], [0.25, 45], [0.5, 10]])));
  }
  if (core.roiStability !== null) {
    // Return that survives its own scatter. A trader whose average ROI is
    // small relative to how wildly it varies has not shown an edge, only a
    // wide distribution that happened to settle above zero.
    riskParts.push(clamp(curve(core.roiStability, [[-1, 0], [0, 25], [0.3, 50], [0.75, 75], [1.5, 92], [3, 100]])));
  }
  const risk = riskParts.length ? mean(riskParts) : null;
  if (core.maxDrawdown === null) gaps.push("Max drawdown unmeasured: the realised equity curve never went above water");
  if (exposure.avgPeakWeight === null) {
    gaps.push("Position sizing unmeasured: no book value was available to compute weights");
  }

  // --- Entry skill ---------------------------------------------------------
  let entrySkill: number | null = null;
  if (entry.sampleSize > 0) {
    const parts: number[] = [];
    const longest = Math.max(...config.entryHorizonsSec);
    const r = entry.roiByHorizon[longest];
    if (r !== null && r !== undefined) parts.push(clamp(curve(r, [[-0.5, 0], [0, 40], [0.25, 65], [0.5, 82], [1.5, 100]])));
    const hit50 = entry.hitRateByMultiple[0.5];
    if (hit50 !== null && hit50 !== undefined) parts.push(clamp(curve(hit50, [[0, 20], [0.2, 50], [0.4, 75], [0.7, 100]])));
    entrySkill = parts.length ? mean(parts) : null;
  }
  if (entrySkill === null) {
    gaps.push(
      `Entry quality unmeasured: ${entry.sampleSize} of ${entry.population} entries had observable prices afterwards`,
    );
  }

  // --- Exit skill ----------------------------------------------------------
  let exitSkill: number | null = null;
  if (exit.sampleSize > 0) {
    const parts: number[] = [];
    if (exit.captureRatio !== null) {
      parts.push(clamp(curve(exit.captureRatio, [[0, 10], [0.3, 40], [0.5, 62], [0.75, 85], [1, 100]])));
    }
    if (exit.prematureExitRate !== null) {
      parts.push(clamp(curve(exit.prematureExitRate, [[0, 100], [0.3, 78], [0.5, 58], [0.8, 25], [1, 5]])));
    }
    exitSkill = parts.length ? mean(parts) : null;
  }
  if (exitSkill === null) {
    gaps.push(`Exit quality unmeasured: ${exit.sampleSize} of ${exit.population} exits had observable prices afterwards`);
  }

  // --- Consistency ---------------------------------------------------------
  // Consistency is a statement about *time*. A history too short to bucket
  // cannot support one, and scoring it from token spread alone would publish a
  // high number for a trader observed over a single afternoon -- which is
  // exactly the claim the metric is supposed to test.
  const c = core.consistency;
  let consistency: number | null = null;
  if (c.buckets >= config.minConsistencyBuckets) {
    const consParts: number[] = [];
    if (c.profitableBucketRate !== null) {
      consParts.push(clamp(curve(c.profitableBucketRate, [[0, 0], [0.4, 40], [0.6, 65], [0.8, 88], [1, 100]])));
    }
    if (c.bucketVariation !== null) {
      consParts.push(clamp(curve(c.bucketVariation, [[0, 100], [0.5, 85], [1, 65], [2, 38], [4, 10]])));
    }
    if (c.profitableTokenRate !== null) {
      consParts.push(clamp(curve(c.profitableTokenRate, [[0, 0], [0.3, 35], [0.5, 60], [0.7, 85], [0.9, 100]])));
    }
    consistency = consParts.length ? mean(consParts) : null;
  }
  if (consistency === null) {
    const tokenNote =
      c.profitableTokenRate === null
        ? ""
        : ` Across tokens, ${(c.profitableTokenRate * 100).toFixed(0)}% were profitable.`;
    gaps.push(
      `Consistency unmeasured: the history covers ${c.buckets} time bucket(s) and ` +
        `${config.minConsistencyBuckets} are needed.` +
        tokenNote,
    );
  }

  const dimensions: Record<DimensionName, number | null> = {
    entry: entrySkill,
    profitability,
    risk,
    exit: exitSkill,
    consistency,
  };

  // Renormalise over the dimensions that could actually be measured, so a
  // missing feed lowers confidence rather than silently scoring zero.
  let weighted = 0;
  let weightUsed = 0;
  for (const [name, w] of Object.entries(DIMENSION_WEIGHTS) as [DimensionName, number][]) {
    const v = dimensions[name];
    if (v === null) continue;
    weighted += v * w;
    weightUsed += w;
  }
  const edgeScore = weightUsed > 0 ? weighted / weightUsed : null;

  if (exposure.concentrated) {
    flags.push(
      `${((exposure.topEpisodeShare ?? 0) * 100).toFixed(0)}% of all profit came from a single position; ` +
        `the record depends on one outcome`,
    );
  }
  if (exposure.avgPeakWeight !== null && exposure.avgPeakWeight > 0.25) {
    flags.push(
      `Typical position is ${(exposure.avgPeakWeight * 100).toFixed(0)}% of book: returns are driven by size as much as selection`,
    );
  }
  if (core.maxDrawdown !== null && core.maxDrawdown > 0.4) {
    flags.push(`Realised drawdown reached ${(core.maxDrawdown * 100).toFixed(0)}% of peak profit`);
  }
  if (core.straddlingEpisodes > 0) {
    gaps.push(
      `${core.straddlingEpisodes} closed position${core.straddlingEpisodes === 1 ? " was" : "s were"} ` +
        `excluded: more was sold than was bought inside the history window, so the entry price ` +
        `was never observed. Widen the window to include them.`,
    );
  }
  if (weightUsed < 0.75) {
    flags.push(`Edge Score computed from ${(weightUsed * 100).toFixed(0)}% of the dimensions; treat it as provisional`);
  }

  return { address, edgeScore, grade: gradeOf(edgeScore), dimensions, core, entry, exit, skillVsExposure: exposure, flags, gaps };
}

function gradeOf(score: number | null): AbilityProfile["grade"] {
  if (score === null) return "insufficient-data";
  if (score >= 90) return "S";
  if (score >= 80) return "A";
  if (score >= 68) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export { percentile };
