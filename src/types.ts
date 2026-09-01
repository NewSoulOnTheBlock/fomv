/** Chains fomo trades on. Solana carries the bulk of fomo's volume. */
export type ChainId = "solana" | "base" | "bnb" | "ethereum" | "monad" | "robinhood";

export interface TokenRef {
  chain: ChainId;
  /** Mint address (Solana) or contract address (EVM), lowercased for EVM. */
  address: string;
  symbol?: string;
  decimals: number;
}

export function tokenKey(t: TokenRef): string {
  return `${t.chain}:${t.address}`;
}

export function sameToken(a: TokenRef, b: TokenRef): boolean {
  return tokenKey(a) === tokenKey(b);
}

/**
 * A leader swap, normalised across chains.
 *
 * `id` is the idempotency key and must be derived from immutable chain data
 * (signature / tx hash plus an in-transaction index), never from wall time.
 */
export interface LeaderTrade {
  id: string;
  chain: ChainId;
  leader: string;
  /** Block/slot time in ms, not the time we noticed it. */
  ts: number;
  side: "buy" | "sell";
  /** The token being accumulated (buy) or disposed (sell). */
  asset: TokenRef;
  /** The token paid with (buy) or received (sell): SOL, USDC, WETH... */
  quote: TokenRef;
  /** Human units of `asset` acquired (buy) or sold (sell). */
  assetAmount: number;
  /** Human units of `quote` spent (buy) or received (sell). */
  quoteAmount: number;
  /** USD notional of the swap at the leader's fill. */
  usdValue: number;
  /** Leader's realised price in USD per unit of `asset`. */
  fillPxUsd: number;
}

export interface Holding {
  token: TokenRef;
  amount: number;
  usdValue: number;
}

/**
 * Point-in-time valuation of an account's tradable book.
 *
 * For a leader this is what we divide by to get portfolio weights, so it must
 * include their idle quote balances — otherwise a leader sitting 90% in USDC
 * looks maximally levered on their one open position.
 */
export interface PortfolioSnapshot {
  owner: string;
  ts: number;
  totalUsd: number;
  holdings: Holding[];
}

export function holdingOf(p: PortfolioSnapshot, token: TokenRef): Holding | undefined {
  return p.holdings.find((h) => sameToken(h.token, token));
}

/** Market context for one asset, used by the safety and impact guardrails. */
export interface MarketInfo {
  token: TokenRef;
  priceUsd: number;
  /** Total USD liquidity in the routable pools. */
  liquidityUsd: number;
  /** Seconds since the token's first liquidity. */
  ageSec: number;
  /** True when the mint/ownership authority is renounced or burned. */
  mintAuthorityRenounced: boolean;
  /** True when no freeze/blacklist authority can strand the vault's balance. */
  freezeAuthorityRenounced: boolean;
  /**
   * Fraction of supply held by the top 10 non-pool holders, 0..1.
   *
   * `null` means "could not be determined", which is deliberately a different
   * state from "zero" or "one". Collapsing an unavailable measurement into a
   * risk value makes an RPC outage indistinguishable from a genuinely
   * dangerous token, and the operator never finds out which they are looking at.
   */
  topHolderConcentration: number | null;
  /** Fee-on-transfer / token-2022 transfer fee, in bps. 0 when none. */
  transferFeeBps: number;
  /** Set when a sell simulation failed, i.e. probable honeypot. */
  sellSimulationFailed: boolean;
}

export type MirrorIntent =
  | {
      kind: "buy";
      sourceTradeId: string;
      asset: TokenRef;
      quote: TokenRef;
      usdSize: number;
      rationale: string;
    }
  | {
      kind: "sell";
      sourceTradeId: string;
      asset: TokenRef;
      quote: TokenRef;
      /** Fraction of the vault's current position to dispose, 0..1. */
      fraction: number;
      rationale: string;
    }
  | {
      kind: "skip";
      sourceTradeId: string;
      /** Machine-readable guardrail name, for metrics and depositor reporting. */
      code: string;
      reason: string;
    };

export interface ExecutionResult {
  intentId: string;
  ok: boolean;
  txSignature?: string;
  /** Realised USD notional actually filled. */
  filledUsd: number;
  /** Vault's realised price in USD per unit of asset. */
  fillPxUsd?: number;
  error?: string;
}
