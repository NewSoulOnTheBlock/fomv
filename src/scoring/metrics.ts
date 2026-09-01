import type { TokenRef } from "../types.js";
import type { Episode } from "./episodes.js";

/**
 * Historical market context. Every method may return undefined; the metrics
 * below then report `null` rather than substituting a guess, because a scoring
 * system that silently invents inputs is worse than one that admits gaps.
 */
export interface MarketLookup {
  liquidityUsdAt(token: TokenRef, tsMs: number): number | undefined;
  priceUsdAt(token: TokenRef, tsMs: number): number | undefined;
}

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}

export function median(xs: number[]): number | null {
  return percentile(xs, 50);
}

// ---------------------------------------------------------------------------
// Performance, net of what fomo actually charges
// ---------------------------------------------------------------------------

export interface PerformanceMetrics {
  closedEpisodes: number;
  volumeUsd: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  /** Fees as bps of traded volume. The gap between gross and net skill. */
  feeDragBps: number;
  winRate: number;
  /** Gross profit of winners / gross loss of losers. >1 is profitable. */
  profitFactor: number | null;
}

export function performance(episodes: Episode[]): PerformanceMetrics {
  const closed = episodes.filter((e) => e.closed);
  const volumeUsd = closed.reduce((a, e) => a + e.costUsd + e.proceedsUsd, 0);
  const grossPnlUsd = closed.reduce((a, e) => a + e.grossPnlUsd, 0);
  const feesUsd = closed.reduce((a, e) => a + e.feesUsd, 0);
  const netPnlUsd = grossPnlUsd - feesUsd;

  const wins = closed.filter((e) => e.netPnlUsd > 0);
  const losses = closed.filter((e) => e.netPnlUsd < 0);
  const grossWin = wins.reduce((a, e) => a + e.netPnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, e) => a + e.netPnlUsd, 0));

  return {
    closedEpisodes: closed.length,
    volumeUsd,
    grossPnlUsd,
    feesUsd,
    netPnlUsd,
    feeDragBps: volumeUsd > 0 ? (feesUsd / volumeUsd) * 10_000 : 0,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
  };
}

// ---------------------------------------------------------------------------
// Capacity: the number that decides how large a vault may follow this trader
// ---------------------------------------------------------------------------

export interface CapacityMetrics {
  /** Conservative capacity: the 25th percentile across episodes, in USD. */
  capacityUsd: number | null;
  medianCapacityUsd: number | null;
  /** Episodes where liquidity was known and a weight was recorded. */
  sampleSize: number;
  medianLiquidityUsd: number | null;
}

/**
 * Largest vault that could actually run this strategy.
 *
 * The derivation is the useful part. If the trader committed 4% of their book
 * to a token, and the impact cap allows a vault to deploy at most $400 into
 * that token's pool, then any vault larger than $400 / 0.04 = $10,000 cannot
 * express that trade at the intended weight. Capacity is the binding case
 * across their episodes.
 *
 * This is the single metric a returns-based leaderboard cannot give you, and
 * the one that decides whether a great track record is investable or a
 * curiosity. Plenty of spectacular fomo traders have four-figure capacity.
 */
export function capacity(
  episodes: Episode[],
  lookup: MarketLookup,
  maxPctOfLiquidity: number,
): CapacityMetrics {
  const implied: number[] = [];
  const liquidities: number[] = [];

  for (const ep of episodes) {
    if (ep.peakWeight <= 0) continue;
    const liq = lookup.liquidityUsdAt(ep.token, ep.openedAtMs);
    if (liq === undefined || liq <= 0) continue;
    liquidities.push(liq);
    implied.push((maxPctOfLiquidity * liq) / ep.peakWeight);
  }

  return {
    capacityUsd: percentile(implied, 25),
    medianCapacityUsd: median(implied),
    sampleSize: implied.length,
    medianLiquidityUsd: median(liquidities),
  };
}

// ---------------------------------------------------------------------------
// Latency decay: does the edge survive being a few seconds late?
// ---------------------------------------------------------------------------

export interface LatencyMetrics {
  /** Delay in seconds -> fraction of the original net P&L retained. */
  retention: Map<number, number | null>;
  /** Fastest delay at which retention drops below half. null if it never does. */
  halfLifeSec: number | null;
  pricedEpisodes: number;
  totalEpisodes: number;
}

/**
 * Re-price every entry as if the vault had been `delay` seconds late.
 *
 * A vault is structurally behind its leader: detection, quoting and landing all
 * take time. If a trader's edge is gone by five seconds, no amount of
 * engineering makes them copyable, and the honest thing is to say so before
 * anyone deposits rather than after.
 */
export function latencyDecay(
  episodes: Episode[],
  lookup: MarketLookup,
  delaysSec: number[] = [3, 10, 30],
): LatencyMetrics {
  const closed = episodes.filter((e) => e.closed);
  const basePnl = closed.reduce((a, e) => a + e.netPnlUsd, 0);
  const retention = new Map<number, number | null>();
  let pricedEpisodes = 0;

  for (const delay of delaysSec) {
    let delayedPnl = 0;
    let priced = 0;
    let usable = true;

    for (const ep of closed) {
      let costDelayed = 0;
      let ok = true;
      for (const f of ep.fills) {
        if (f.side !== "buy") continue;
        const px = lookup.priceUsdAt(ep.token, f.ts + delay * 1000);
        if (px === undefined || px <= 0) {
          ok = false;
          break;
        }
        costDelayed += f.qty * px;
      }
      if (!ok) continue;
      priced += 1;
      delayedPnl += ep.proceedsUsd - costDelayed - ep.feesUsd;
    }

    pricedEpisodes = Math.max(pricedEpisodes, priced);
    if (priced === 0 || basePnl === 0) usable = false;
    retention.set(delay, usable ? delayedPnl / basePnl : null);
  }

  // Half-life is only meaningful for a trader who was profitable to begin with.
  let halfLifeSec: number | null = null;
  if (basePnl > 0) {
    for (const d of [...delaysSec].sort((a, b) => a - b)) {
      const r = retention.get(d);
      if (r !== null && r !== undefined && r < 0.5) {
        halfLifeSec = d;
        break;
      }
    }
  }

  return { retention, halfLifeSec, pricedEpisodes, totalEpisodes: closed.length };
}

// ---------------------------------------------------------------------------
// Process quality: is this repeatable, or was it one lucky trade?
// ---------------------------------------------------------------------------

export interface ProcessMetrics {
  medianHoldSec: number | null;
  p25HoldSec: number | null;
  maxPeakWeight: number;
  /** Share of total net profit contributed by the single best episode, 0..1. */
  topEpisodeShare: number | null;
  /** Deepest peak-to-trough decline of cumulative net P&L, in USD. */
  maxDrawdownUsd: number;
  distinctTokens: number;
}

export function process(episodes: Episode[]): ProcessMetrics {
  const closed = episodes.filter((e) => e.closed);
  const holds = closed.map((e) => e.holdSec).filter((h): h is number => h !== null);

  const profits = closed.map((e) => e.netPnlUsd).filter((p) => p > 0);
  const totalProfit = profits.reduce((a, b) => a + b, 0);
  const best = profits.length ? Math.max(...profits) : 0;

  // Equity curve drawdown over the realised sequence.
  let cum = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const ep of [...closed].sort((a, b) => (a.closedAtMs ?? 0) - (b.closedAtMs ?? 0))) {
    cum += ep.netPnlUsd;
    peak = Math.max(peak, cum);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - cum);
  }

  return {
    medianHoldSec: median(holds),
    p25HoldSec: percentile(holds, 25),
    maxPeakWeight: episodes.reduce((a, e) => Math.max(a, e.peakWeight), 0),
    topEpisodeShare: totalProfit > 0 ? best / totalProfit : null,
    maxDrawdownUsd,
    distinctTokens: new Set(episodes.map((e) => `${e.token.chain}:${e.token.address}`)).size,
  };
}

// ---------------------------------------------------------------------------
// Hygiene: what kind of assets does this trader walk the vault into?
// ---------------------------------------------------------------------------

export interface HygieneMetrics {
  /** Fraction of entries whose token fell 80%+ within an hour of the buy. */
  rugRate: number | null;
  medianEntryLiquidityUsd: number | null;
  /** Entries into pools below $25k, as a fraction. */
  thinPoolRate: number | null;
  sampleSize: number;
}

export function hygiene(episodes: Episode[], lookup: MarketLookup, thinPoolUsd = 25_000): HygieneMetrics {
  let rugs = 0;
  let thin = 0;
  let sample = 0;
  const liq: number[] = [];

  for (const ep of episodes) {
    const entryPx = lookup.priceUsdAt(ep.token, ep.openedAtMs);
    const laterPx = lookup.priceUsdAt(ep.token, ep.openedAtMs + 3_600_000);
    const l = lookup.liquidityUsdAt(ep.token, ep.openedAtMs);
    if (l !== undefined) {
      liq.push(l);
      if (l < thinPoolUsd) thin += 1;
    }
    if (entryPx === undefined || laterPx === undefined || entryPx <= 0) continue;
    sample += 1;
    if (laterPx / entryPx <= 0.2) rugs += 1;
  }

  return {
    rugRate: sample > 0 ? rugs / sample : null,
    medianEntryLiquidityUsd: median(liq),
    thinPoolRate: liq.length > 0 ? thin / liq.length : null,
    sampleSize: sample,
  };
}
