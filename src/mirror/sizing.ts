import type { LeaderTrade, MarketInfo, PortfolioSnapshot, TokenRef } from "../types.js";
import { tokenKey } from "../types.js";
import type { VaultPolicy } from "../policy.js";

export interface VaultPosition {
  token: TokenRef;
  amount: number;
  usdValue: number;
  /** ms timestamp of the first fill that opened the current position. */
  openedAtMs: number;
}

export interface VaultState {
  /** Total vault NAV in USD: quote balances plus marked positions. */
  equityUsd: number;
  /** Unencumbered quote balance in USD. */
  quoteUsd: number;
  positions: Map<string, VaultPosition>;
  /** USD deployed into new positions so far this UTC day. */
  deployedTodayUsd: number;
  /** tokenKey -> ms of the last full exit, for the re-entry cooldown. */
  lastExitAtMs: Map<string, number>;
}

export function emptyVaultState(equityUsd: number): VaultState {
  return {
    equityUsd,
    quoteUsd: equityUsd,
    positions: new Map(),
    deployedTodayUsd: 0,
    lastExitAtMs: new Map(),
  };
}

export interface SizingResult {
  usdSize: number;
  /** Which constraint set the final number, in the order they were applied. */
  clamps: string[];
  /** Uncapped size implied purely by the leader's conviction. */
  rawUsd: number;
}

/**
 * Size a mirrored entry from the leader's *portfolio weight*, not their
 * notional.
 *
 * This is the whole reason a vault differs from a copy bot. The vault's equity
 * moves independently of the leader's (deposits, withdrawals, divergent P&L),
 * so copying "$4,000 into BONK" is meaningless. Copying "3.7% of the book into
 * BONK" is scale-invariant, survives deposits mid-position, and means a $2k
 * depositor and a $2m depositor get the same strategy rather than the same
 * dollar amounts.
 */
export function sizeEntry(args: {
  trade: LeaderTrade;
  leader: PortfolioSnapshot;
  vault: VaultState;
  market: MarketInfo;
  policy: VaultPolicy;
}): SizingResult {
  const { trade, leader, vault, market, policy } = args;
  const { sizing, safety } = policy;
  const clamps: string[] = [];

  if (leader.totalUsd <= 0) {
    return { usdSize: 0, clamps: ["leader-portfolio-empty"], rawUsd: 0 };
  }

  const leaderWeight = trade.usdValue / leader.totalUsd;
  const rawUsd = leaderWeight * vault.equityUsd * sizing.exposureScalar;

  let size = rawUsd;
  const clampTo = (limit: number, label: string) => {
    if (limit < size) {
      size = Math.max(0, limit);
      clamps.push(label);
    }
  };

  // Concentration: how much room is left in this specific asset.
  const existing = vault.positions.get(tokenKey(trade.asset))?.usdValue ?? 0;
  clampTo(sizing.maxPositionPct * vault.equityUsd - existing, "maxPositionPct");

  // Liquidity impact. A vault is large enough to be its own adverse move, so
  // cap the order as a fraction of the pool rather than trusting slippage
  // settings to save us after the fact.
  clampTo(safety.maxPctOfLiquidity * market.liquidityUsd, "maxPctOfLiquidity");

  // Keep the quote reserve intact: exits, fees and gas must never depend on
  // being able to sell an illiquid position first.
  clampTo(vault.quoteUsd - sizing.quoteReservePct * vault.equityUsd, "quoteReserve");

  // Per-day deployment budget bounds how fast a hijacked or tilting leader can
  // rotate the entire book.
  clampTo(sizing.dailyDeployPct * vault.equityUsd - vault.deployedTodayUsd, "dailyDeployPct");

  // Below the floor there is no trade worth its own gas and spread.
  if (size < sizing.minTradeUsd) {
    return { usdSize: 0, clamps: [...clamps, "belowMinTradeUsd"], rawUsd };
  }

  return { usdSize: size, clamps, rawUsd };
}

export interface ExitSizing {
  fraction: number;
  clamps: string[];
  /** Fraction of their own position the leader disposed of. */
  leaderFraction: number;
}

/**
 * Size a mirrored exit from the *fraction of their position* the leader sold,
 * not from portfolio weight.
 *
 * The asymmetry with entries is deliberate and load-bearing. If the leader
 * sells half of a position that has since 10x'd, portfolio-weight logic would
 * compute a dollar amount unrelated to what the vault actually holds. Position
 * fraction always maps onto the vault's own holding, whatever it is worth.
 */
export function sizeExit(args: {
  trade: LeaderTrade;
  /** Leader's holding of the asset immediately *before* this sell, human units. */
  leaderPositionBefore: number;
  vaultPosition: VaultPosition | undefined;
  policy: VaultPolicy;
}): ExitSizing {
  const { trade, leaderPositionBefore, vaultPosition, policy } = args;
  const clamps: string[] = [];

  if (!vaultPosition || vaultPosition.amount <= 0) {
    return { fraction: 0, clamps: ["no-position"], leaderFraction: 0 };
  }
  if (leaderPositionBefore <= 0) {
    // We never saw them build it, so we cannot infer a fraction. Treat an
    // unexplained sell as a full exit: erring toward flat is the safe error.
    return { fraction: 1, clamps: ["unknown-leader-position:full-exit"], leaderFraction: 1 };
  }

  const leaderFraction = Math.min(1, Math.max(0, trade.assetAmount / leaderPositionBefore));
  let fraction = leaderFraction;

  // A near-total exit becomes a total exit. Leaving 4% of an illiquid position
  // behind creates dust that costs more to sell than it is worth, and that dust
  // then distorts NAV for every future depositor.
  if (fraction >= policy.sizing.exitDustThreshold) {
    fraction = 1;
    clamps.push("exitDustThreshold");
  }

  // Same argument on the residual's absolute value.
  const residualUsd = vaultPosition.usdValue * (1 - fraction);
  if (fraction < 1 && residualUsd < policy.sizing.minTradeUsd) {
    fraction = 1;
    clamps.push("residualBelowMinTradeUsd");
  }

  return { fraction, clamps, leaderFraction };
}

/**
 * Reconstruct the leader's pre-sell holding from a snapshot taken *after* the
 * trade landed. Watchers usually observe the swap and the resulting balance in
 * the same pass, so the pre-trade holding has to be added back.
 */
export function leaderPositionBefore(postTradeHolding: number, trade: LeaderTrade): number {
  return trade.side === "sell" ? postTradeHolding + trade.assetAmount : postTradeHolding;
}
