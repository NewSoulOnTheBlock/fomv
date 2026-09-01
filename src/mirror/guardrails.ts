import type { LeaderTrade, MarketInfo, PortfolioSnapshot } from "../types.js";
import { tokenKey } from "../types.js";
import type { VaultPolicy } from "../policy.js";
import type { VaultState } from "./sizing.js";

export type Verdict =
  | { pass: true; warnings: string[] }
  | { pass: false; code: string; reason: string };

const PASS = (warnings: string[] = []): Verdict => ({ pass: true, warnings });
const FAIL = (code: string, reason: string): Verdict => ({ pass: false, code, reason });

export interface BreakerContext {
  policy: VaultPolicy;
  vault: VaultState;
  /** Highest equity the vault has ever marked, in USD. */
  equityHighWaterUsd: number;
  /** Vault equity at 00:00 UTC today, in USD. */
  startOfDayEquityUsd: number;
  /** Leader portfolio value at 00:00 UTC today, in USD. */
  leaderStartOfDayUsd: number;
  leader: PortfolioSnapshot;
  /** When the pricing feed backing these numbers was last refreshed. */
  priceAsOfMs: number;
  nowMs: number;
}

/**
 * Vault-wide circuit breakers, evaluated once per cycle before any trade is
 * considered. A failure here stops all new risk; it does not stop exits.
 */
export function checkBreakers(ctx: BreakerContext): Verdict {
  const { policy, vault, nowMs } = ctx;
  const b = policy.breakers;

  if (b.paused) return FAIL("paused", "Operator kill switch is engaged");

  const staleness = nowMs - ctx.priceAsOfMs;
  if (staleness > b.maxPriceStalenessMs) {
    return FAIL(
      "price-stale",
      `Pricing feed is ${Math.round(staleness / 1000)}s old, limit is ${Math.round(b.maxPriceStalenessMs / 1000)}s`,
    );
  }

  if (ctx.equityHighWaterUsd > 0) {
    const drawdown = 1 - vault.equityUsd / ctx.equityHighWaterUsd;
    if (drawdown > b.maxDrawdownPct) {
      return FAIL(
        "max-drawdown",
        `Vault is ${pct(drawdown)} below its high-water mark, limit is ${pct(b.maxDrawdownPct)}`,
      );
    }
  }

  if (ctx.startOfDayEquityUsd > 0) {
    const dayLoss = 1 - vault.equityUsd / ctx.startOfDayEquityUsd;
    if (dayLoss > b.dailyLossLimitPct) {
      return FAIL("daily-loss-limit", `Vault is down ${pct(dayLoss)} today, limit is ${pct(b.dailyLossLimitPct)}`);
    }
  }

  // A leader whose own book just halved is either being liquidated, tilting or
  // compromised. None of those are states to follow into new positions.
  if (ctx.leaderStartOfDayUsd > 0) {
    const leaderLoss = 1 - ctx.leader.totalUsd / ctx.leaderStartOfDayUsd;
    if (leaderLoss > b.leaderCollapsePct) {
      return FAIL(
        "leader-collapse",
        `Leader portfolio is down ${pct(leaderLoss)} today, limit is ${pct(b.leaderCollapsePct)}`,
      );
    }
  }

  return PASS();
}

export interface TradeContext {
  trade: LeaderTrade;
  market: MarketInfo | null;
  policy: VaultPolicy;
  vault: VaultState;
  /** Idempotency set of leader trade ids already acted on. */
  processed: ReadonlySet<string>;
  nowMs: number;
}

/**
 * Checks that apply to any mirrored trade, entry or exit.
 *
 * Guiding principle throughout this file: guardrails restrict *risk-taking*,
 * never *risk-reduction*. Anything that would block an exit has to justify
 * itself against the alternative of leaving depositors stuck in a position the
 * leader has already abandoned.
 */
function checkCommon(ctx: TradeContext): Verdict {
  const { trade, policy, processed, nowMs } = ctx;

  if (processed.has(trade.id)) {
    return FAIL("duplicate", `Leader trade ${trade.id} was already mirrored`);
  }
  if (!policy.chains.includes(trade.chain)) {
    return FAIL("chain-not-enabled", `Chain ${trade.chain} is not enabled for this vault`);
  }
  const key = tokenKey(trade.asset);
  if (policy.safety.denyTokens.includes(key) || policy.safety.denyTokens.includes(trade.asset.address)) {
    return FAIL("token-denied", `${trade.asset.symbol ?? key} is on the vault deny list`);
  }
  if (policy.safety.allowTokens.length > 0) {
    const allowed =
      policy.safety.allowTokens.includes(key) || policy.safety.allowTokens.includes(trade.asset.address);
    if (!allowed) return FAIL("token-not-allowed", `${trade.asset.symbol ?? key} is not on the vault allow list`);
  }
  return PASS();
}

/** Full guardrail stack for opening or increasing a position. */
export function checkEntry(ctx: TradeContext): Verdict {
  const common = checkCommon(ctx);
  if (!common.pass) return common;
  const warnings = [...common.warnings];

  const { trade, market, policy, vault, nowMs } = ctx;
  const { safety, execution, sizing } = policy;

  const age = nowMs - trade.ts;
  if (age > execution.maxTradeAgeMs) {
    return FAIL(
      "trade-stale",
      `Leader trade is ${(age / 1000).toFixed(1)}s old, limit is ${(execution.maxTradeAgeMs / 1000).toFixed(1)}s`,
    );
  }

  if (!market) return FAIL("no-market-data", `No market data for ${trade.asset.symbol ?? trade.asset.address}`);

  // --- Token safety. A pooled vehicle has a higher bar than an individual ----
  if (safety.requireSellSimulation && market.sellSimulationFailed) {
    return FAIL("honeypot", "Sell simulation failed: the vault could buy but not sell");
  }
  if (safety.requireFreezeAuthorityRenounced && !market.freezeAuthorityRenounced) {
    // A live freeze authority can strand every depositor's share at once.
    return FAIL("freeze-authority", "Token retains a freeze/blacklist authority");
  }
  if (safety.requireMintAuthorityRenounced && !market.mintAuthorityRenounced) {
    return FAIL("mint-authority", "Token retains a live mint authority");
  }
  if (market.transferFeeBps > safety.maxTransferFeeBps) {
    return FAIL(
      "transfer-fee",
      `Token charges ${market.transferFeeBps}bps on transfer, limit is ${safety.maxTransferFeeBps}bps`,
    );
  }
  if (market.liquidityUsd < safety.minLiquidityUsd) {
    return FAIL(
      "low-liquidity",
      `Pool liquidity ${usd(market.liquidityUsd)} is below the ${usd(safety.minLiquidityUsd)} floor`,
    );
  }
  if (market.ageSec < safety.minTokenAgeSec) {
    return FAIL("token-too-new", `Token is ${Math.round(market.ageSec)}s old, floor is ${safety.minTokenAgeSec}s`);
  }
  if (market.topHolderConcentration === null) {
    // Fail closed by default, but say so honestly. `getTokenLargestAccounts` is
    // an indexed RPC call that free endpoints refuse outright, and an operator
    // who sees "holder concentration too high" on every single token will
    // conclude the market is unsafe rather than that their node is inadequate.
    if (safety.requireHolderData) {
      return FAIL("holder-data-unavailable", "Could not measure holder concentration; the RPC did not answer");
    }
    warnings.push("Holder concentration unmeasured; safety.requireHolderData is off");
  } else if (market.topHolderConcentration > safety.maxTopHolderConcentration) {
    return FAIL(
      "holder-concentration",
      `Top holders control ${pct(market.topHolderConcentration)}, limit is ${pct(safety.maxTopHolderConcentration)}`,
    );
  }

  // --- Portfolio construction ----------------------------------------------
  const key = tokenKey(trade.asset);
  const held = vault.positions.has(key);
  if (!held && vault.positions.size >= sizing.maxPositions) {
    return FAIL("max-positions", `Vault already holds ${vault.positions.size} positions, the cap`);
  }

  const lastExit = vault.lastExitAtMs.get(key);
  if (lastExit !== undefined) {
    const since = (nowMs - lastExit) / 1000;
    if (since < execution.reentryCooldownSec) {
      return FAIL(
        "reentry-cooldown",
        `Exited this asset ${since.toFixed(0)}s ago, cooldown is ${execution.reentryCooldownSec}s`,
      );
    }
  }

  // --- The speed guardrail --------------------------------------------------
  // We cannot promise to be as fast as the leader. What we can promise is that
  // we will not buy their exit liquidity: if the price already ran past their
  // fill by more than the drift cap, the edge is gone and we stand down.
  if (trade.fillPxUsd > 0) {
    const driftBps = ((market.priceUsd - trade.fillPxUsd) / trade.fillPxUsd) * 10_000;
    if (driftBps > execution.maxLeaderPriceDriftBps) {
      return FAIL(
        "leader-price-drift",
        `Price ran ${driftBps.toFixed(0)}bps past the leader's fill, cap is ${execution.maxLeaderPriceDriftBps}bps`,
      );
    }
    if (driftBps < -execution.maxLeaderPriceDriftBps) {
      warnings.push(`Entering ${Math.abs(driftBps).toFixed(0)}bps below the leader's fill`);
    }
  }

  return PASS(warnings);
}

/**
 * Guardrail stack for reducing or closing a position. Intentionally short:
 * almost nothing should stop the vault getting out.
 */
export function checkExit(ctx: TradeContext): Verdict {
  const common = checkCommon(ctx);
  if (!common.pass) {
    // A deny-listed or non-allow-listed asset must still be sellable, otherwise
    // adding a token to the deny list would trap depositors in it forever.
    if (common.code === "token-denied" || common.code === "token-not-allowed") {
      return PASS([`${common.code}: exiting anyway, deny/allow lists never block exits`]);
    }
    return common;
  }

  const { trade, vault } = ctx;
  if (!vault.positions.has(tokenKey(trade.asset))) {
    return FAIL("no-position", `Vault holds no ${trade.asset.symbol ?? trade.asset.address} to sell`);
  }

  // Deliberately absent: staleness, drift, liquidity and token-safety checks.
  // Exiting late at a worse price still beats not exiting at all.
  return PASS(common.warnings);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
