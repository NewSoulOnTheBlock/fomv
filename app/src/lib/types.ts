/**
 * Shapes the app reads from `public/data`, mirroring what `bun run src/cli.ts
 * profile` writes.
 *
 * Declared here rather than imported from the engine because these cross a
 * network boundary: the file on disk is the contract, and a type that silently
 * followed an engine refactor would let a stale JSON render as `undefined`
 * instead of failing loudly.
 */

export type DimensionName = "entry" | "profitability" | "risk" | "exit" | "consistency";

export interface ConsistencyMetrics {
  bucketPnlUsd: number[];
  profitableBucketRate: number | null;
  bucketVariation: number | null;
  profitableTokenRate: number | null;
  buckets: number;
}

export interface CoreMetrics {
  realizedPnlUsd: number;
  winRate: number | null;
  profitFactor: number | null;
  avgRoi: number | null;
  medianRoi: number | null;
  roiStability: number | null;
  roiStdev: number | null;
  maxDrawdown: number | null;
  maxDrawdownUsd: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  rewardToRisk: number | null;
  consistency: ConsistencyMetrics;
  closedEpisodes: number;
  openEpisodes: number;
  totalEpisodes: number;
  /** Closed positions discarded because their cost basis fell outside the window. */
  straddlingEpisodes: number;
}

export interface EntryQualityMetrics {
  roiByHorizon: Record<string, number | null>;
  hitRateByMultiple: Record<string, number | null>;
  medianTimeToPeakSec: number | null;
  sampleSize: number;
  population: number;
}

export interface ExitQualityMetrics {
  captureRatio: number | null;
  captureRatioMean: number | null;
  avgReturnAfterExit: number | null;
  prematureExitRate: number | null;
  sampleSize: number;
  population: number;
}

export interface SkillVsExposure {
  avgPeakWeight: number | null;
  maxPeakWeight: number | null;
  pnlPerExposureUsd: number | null;
  exposureUnits: number;
  topEpisodeShare: number | null;
  concentrated: boolean;
}

export interface AbilityProfile {
  address: string;
  edgeScore: number | null;
  grade: "S" | "A" | "B" | "C" | "D" | "F" | "insufficient-data";
  dimensions: Record<DimensionName, number | null>;
  core: CoreMetrics;
  entry: EntryQualityMetrics;
  exit: ExitQualityMetrics;
  skillVsExposure: SkillVsExposure;
  flags: string[];
  gaps: string[];
}

/**
 * Where the historical prices behind entry and exit quality came from.
 *
 * Mirrors `ProfileProvenance.priceSource` in the engine. Declared here rather
 * than imported because it crosses a network boundary: the JSON on disk is the
 * contract, and a type that silently followed an engine refactor would let a
 * stale profile render as `undefined` instead of failing loudly.
 */
export interface PriceSource {
  /** Feed name, or "observed-fills" when no feed answered. */
  feed: string;
  /** Candle width, e.g. "minute15". Null when no candles were used. */
  resolution: string | null;
  tokensRequested: number;
  tokensCovered: number;
  candles: number;
  /** True when the trader's own fills were the only prices available. */
  degraded: boolean;
}

export interface ProfileProvenance {
  trades: number;
  windowFromMs: number | null;
  windowToMs: number | null;
  tokensPriced: number;
  priceObservations: number;
  /**
   * Which source the entry and exit dimensions were measured against.
   *
   * Optional because profiles written before the price feed existed do not
   * carry it. The UI reports that absence as an absence rather than assuming
   * either answer -- guessing "observed fills" would be right today and wrong
   * the moment someone restores an old file from a run that did have a feed.
   */
  priceSource?: PriceSource;
  equityUsd: number | null;
  truncated: string | null;
  caveats: string[];
  computedAtMs: number;
}

export interface TraderProfile {
  address: string;
  handle?: string;
  profile: AbilityProfile;
  provenance: ProfileProvenance;
}

export interface RosterEntry {
  handle: string;
  leader: string;
  chain: string;
  /** Status of the FOMV listing. Only `live` vaults accept deposits. */
  status: "applied" | "approved" | "listed" | "live" | "suspended" | "rejected" | "delisted";
  vaultAddress: string | null;
  /** Withdrawal fee this vault was listed under, in bps. */
  withdrawFeeBps: number | null;
  /** Leader's cut of new profit, in bps. */
  performanceFeeBps: number;
  note?: string;
  elsewhere?: { address: string; note: string }[];
}

export interface PlatformInfo {
  name: string;
  withdrawFeeBps: number;
  maxWithdrawFeeBps: number;
  listingFeeLamports: string;
  listingFeeSol: number;
  maxLiveVaults: number;
  treasury: string | null;
  /**
   * Whether the on-chain program backing deposits and withdrawals is deployed.
   *
   * The single most important field in this file. While false, the app must
   * refuse to pretend a deposit happened: it can quote fees exactly, because
   * that arithmetic is the real thing, but there is no program to send a
   * transaction to.
   */
  programDeployed: boolean;
  programId: string | null;
  cluster: string;
}

export interface AppData {
  platform: PlatformInfo;
  roster: RosterEntry[];
  generatedAtMs: number;
}

/**
 * What the apply form posts.
 *
 * Every field is optional and every field is a string, because this is what a
 * half-filled form looks like on the way out. The server owns the rules; the
 * client's job is to send the answers as typed, not to decide which ones
 * count. Duplicating the validation here would mean two rulebooks and one of
 * them silently wrong.
 */
export interface ApplicationDraft {
  handle?: string;
  address?: string;
  chain?: string;
  email?: string;
  telegram?: string;
  twitter?: string;
  bookUsd?: string;
  strategy?: string;
  elsewhere?: string[];
}
