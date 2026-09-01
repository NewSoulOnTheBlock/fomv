import type {
  ExecutionResult,
  LeaderTrade,
  MarketInfo,
  MirrorIntent,
  PortfolioSnapshot,
  TokenRef,
} from "../types.js";

/**
 * Watches one chain for a leader's swaps.
 *
 * `cursor` is opaque to callers and must be derived from immutable chain data
 * (a signature, a slot) so that a restart resumes exactly where it left off
 * without replaying trades the vault has already mirrored.
 */
export interface LeaderWatcher {
  readonly chain: string;
  poll(cursor: string | null): Promise<{ trades: LeaderTrade[]; cursor: string | null }>;
}

export interface MarketDataSource {
  /** Value an account's whole tradable book, including idle quote balances. */
  portfolio(owner: string): Promise<PortfolioSnapshot>;
  /** Safety and liquidity context for one asset, or null when unknown. */
  market(token: TokenRef): Promise<MarketInfo | null>;
}

export interface ExecutionContext {
  /** Vault's holding of the asset, in human units. Needed to size a sell. */
  positionAmount: number;
  maxSlippageBps: number;
  maxPriorityFeeUsd: number;
  /** When true, quote and simulate but never sign or send. */
  dryRun: boolean;
}

export interface Executor {
  readonly chain: string;
  execute(intent: MirrorIntent, ctx: ExecutionContext): Promise<ExecutionResult>;
}

/** Everything the engine needs for one chain, bundled. */
export interface ChainAdapter {
  readonly chain: string;
  watcher: LeaderWatcher;
  data: MarketDataSource;
  executor: Executor;
}

export type { LeaderTrade, MarketInfo, PortfolioSnapshot, ExecutionResult, MirrorIntent, TokenRef };
