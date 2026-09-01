import type { ChainId } from "./types.js";

/**
 * Every knob a vault operator can set. These are the guardrails the vault
 * publishes to depositors before they deposit; they are the product.
 *
 * Grouped by the question each group answers:
 *   sizing     - how much of the vault does one leader trade move?
 *   safety     - is this token something a pooled vehicle may hold at all?
 *   execution  - what fill are we willing to accept?
 *   breakers   - when does the vault stop trading entirely?
 *   economics  - who pays what, and to whom?
 */
export interface VaultPolicy {
  name: string;
  leader: string;
  chains: ChainId[];

  sizing: {
    /**
     * Multiplier on the leader's portfolio weight. 1.0 means "same risk
     * appetite as the leader". Above 1.0 is leverage on their conviction and
     * should be capped hard by maxPositionPct.
     */
    exposureScalar: number;
    /** Max fraction of vault equity in any one asset, 0..1. */
    maxPositionPct: number;
    /** Max simultaneous open positions. Bounds the tail of illiquid dust. */
    maxPositions: number;
    /** Below this, a mirror is not worth its own gas and slippage. */
    minTradeUsd: number;
    /** Fraction of equity held back in quote for exits, fees and gas, 0..1. */
    quoteReservePct: number;
    /** Max fraction of equity deployable into new positions per UTC day, 0..1. */
    dailyDeployPct: number;
    /**
     * When the leader sells at least this fraction of their position, close
     * the vault's position entirely rather than leaving unsellable dust.
     */
    exitDustThreshold: number;
  };

  safety: {
    /** Reject assets whose routable liquidity is below this, in USD. */
    minLiquidityUsd: number;
    /**
     * Cap our order at this fraction of pool liquidity. The single most
     * important memecoin guardrail: a vault is large enough to be its own
     * adverse price move.
     */
    maxPctOfLiquidity: number;
    /** Reject assets younger than this. Set to 0 for an explicit sniper vault. */
    minTokenAgeSec: number;
    /** Reject when the top 10 non-pool holders exceed this fraction, 0..1. */
    maxTopHolderConcentration: number;
    /** Reject fee-on-transfer tokens above this rate. */
    maxTransferFeeBps: number;
    /** Require mint/ownership authority to be renounced. */
    requireMintAuthorityRenounced: boolean;
    /** Require no freeze/blacklist authority. A freeze traps depositor funds. */
    requireFreezeAuthorityRenounced: boolean;
    /** Require a successful sell simulation before ever buying. */
    requireSellSimulation: boolean;
    /**
     * Refuse to trade when holder concentration cannot be measured.
     *
     * Measuring it needs an indexed RPC method that free endpoints reject, so
     * an operator without a real provider must consciously turn this off and
     * accept trading blind on concentration, rather than the vault quietly
     * deciding for them.
     */
    requireHolderData: boolean;
    /** Never trade these, whatever the leader does. */
    denyTokens: string[];
    /** When non-empty, trade only these. */
    allowTokens: string[];
  };

  execution: {
    /** Max acceptable slippage vs the quoted mid, in bps. */
    maxSlippageBps: number;
    /**
     * Max adverse drift between the leader's fill price and ours before we
     * abandon the mirror. This is the honest answer to "how fast is the vault":
     * you cannot guarantee speed, so you bound the cost of being slow.
     */
    maxLeaderPriceDriftBps: number;
    /** Ignore leader trades older than this when we first see them. */
    maxTradeAgeMs: number;
    /** Refuse to re-enter an asset within this window of exiting it. */
    reentryCooldownSec: number;
    /** Priority fee ceiling per transaction, in USD. */
    maxPriorityFeeUsd: number;
  };

  breakers: {
    /** Halt and flatten when equity falls this far below the high-water mark. */
    maxDrawdownPct: number;
    /** Halt for the rest of the UTC day after this loss, as a fraction of SoD equity. */
    dailyLossLimitPct: number;
    /** Halt when the leader's portfolio value collapses by this fraction in a day. */
    leaderCollapsePct: number;
    /** Halt when the pricing feed is older than this. */
    maxPriceStalenessMs: number;
    /** Operator kill switch. */
    paused: boolean;
  };

  economics: {
    /** Leader's share of new profit above each lot's high-water mark, in bps. */
    performanceFeeBps: number;
    /** Annual management fee on NAV, in bps. Accrues per second. */
    managementFeeBpsAnnual: number;
    /**
     * Half-spread assumption used to price the anti-dilution levy charged on
     * deposits and withdrawals. See ledger.ts for why this exists.
     */
    halfSpreadBps: number;
    /** Hard ceiling on the levy however levered the book is, in bps. */
    maxLevyBps: number;
    /** Depositors cannot withdraw within this window of depositing. */
    lockupSec: number;
  };
}

export const DEFAULT_POLICY: Omit<VaultPolicy, "name" | "leader"> = {
  chains: ["solana"],
  sizing: {
    exposureScalar: 1.0,
    maxPositionPct: 0.15,
    maxPositions: 20,
    minTradeUsd: 25,
    quoteReservePct: 0.05,
    dailyDeployPct: 1.0,
    exitDustThreshold: 0.9,
  },
  safety: {
    minLiquidityUsd: 25_000,
    maxPctOfLiquidity: 0.01,
    minTokenAgeSec: 300,
    maxTopHolderConcentration: 0.5,
    maxTransferFeeBps: 0,
    requireMintAuthorityRenounced: true,
    requireFreezeAuthorityRenounced: true,
    requireSellSimulation: true,
    requireHolderData: true,
    denyTokens: [],
    allowTokens: [],
  },
  execution: {
    maxSlippageBps: 150,
    maxLeaderPriceDriftBps: 300,
    maxTradeAgeMs: 20_000,
    reentryCooldownSec: 60,
    maxPriorityFeeUsd: 2,
  },
  breakers: {
    maxDrawdownPct: 0.35,
    dailyLossLimitPct: 0.15,
    leaderCollapsePct: 0.5,
    maxPriceStalenessMs: 30_000,
    paused: false,
  },
  economics: {
    performanceFeeBps: 1000,
    managementFeeBpsAnnual: 0,
    halfSpreadBps: 30,
    maxLevyBps: 100,
    lockupSec: 3600,
  },
};

export function makePolicy(
  name: string,
  leader: string,
  overrides: DeepPartial<Omit<VaultPolicy, "name" | "leader">> = {},
): VaultPolicy {
  const p: VaultPolicy = {
    name,
    leader,
    chains: overrides.chains ?? DEFAULT_POLICY.chains,
    sizing: { ...DEFAULT_POLICY.sizing, ...overrides.sizing },
    safety: { ...DEFAULT_POLICY.safety, ...overrides.safety },
    execution: { ...DEFAULT_POLICY.execution, ...overrides.execution },
    breakers: { ...DEFAULT_POLICY.breakers, ...overrides.breakers },
    economics: { ...DEFAULT_POLICY.economics, ...overrides.economics },
  };
  validatePolicy(p);
  return p;
}

/** Partial one level into each policy group, but never inside an array. */
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? Partial<T[K]> : T[K];
};

/**
 * Reject incoherent policies at construction rather than mid-trade. A vault
 * that discovers its own misconfiguration while holding depositor money has
 * already failed.
 */
export function validatePolicy(p: VaultPolicy): void {
  const errs: string[] = [];
  const frac = (v: number, label: string, { max = 1 } = {}) => {
    if (!Number.isFinite(v) || v < 0 || v > max) errs.push(`${label} must be within 0..${max}, got ${v}`);
  };
  const pos = (v: number, label: string) => {
    if (!Number.isFinite(v) || v < 0) errs.push(`${label} must be >= 0, got ${v}`);
  };

  if (!p.name.trim()) errs.push("name must not be empty");
  if (!p.leader.trim()) errs.push("leader must not be empty");
  if (p.chains.length === 0) errs.push("chains must not be empty");

  frac(p.sizing.exposureScalar, "sizing.exposureScalar", { max: 10 });
  frac(p.sizing.maxPositionPct, "sizing.maxPositionPct");
  frac(p.sizing.quoteReservePct, "sizing.quoteReservePct");
  frac(p.sizing.dailyDeployPct, "sizing.dailyDeployPct", { max: 10 });
  frac(p.sizing.exitDustThreshold, "sizing.exitDustThreshold");
  pos(p.sizing.minTradeUsd, "sizing.minTradeUsd");
  if (!Number.isInteger(p.sizing.maxPositions) || p.sizing.maxPositions < 1) {
    errs.push(`sizing.maxPositions must be a positive integer, got ${p.sizing.maxPositions}`);
  }

  // A single position may not exceed what the reserve leaves investable.
  if (p.sizing.maxPositionPct > 1 - p.sizing.quoteReservePct) {
    errs.push(
      `sizing.maxPositionPct (${p.sizing.maxPositionPct}) exceeds the investable fraction ` +
        `left by sizing.quoteReservePct (${1 - p.sizing.quoteReservePct})`,
    );
  }

  frac(p.safety.maxPctOfLiquidity, "safety.maxPctOfLiquidity");
  frac(p.safety.maxTopHolderConcentration, "safety.maxTopHolderConcentration");
  pos(p.safety.minLiquidityUsd, "safety.minLiquidityUsd");
  pos(p.safety.minTokenAgeSec, "safety.minTokenAgeSec");
  pos(p.safety.maxTransferFeeBps, "safety.maxTransferFeeBps");

  pos(p.execution.maxSlippageBps, "execution.maxSlippageBps");
  pos(p.execution.maxLeaderPriceDriftBps, "execution.maxLeaderPriceDriftBps");
  pos(p.execution.maxTradeAgeMs, "execution.maxTradeAgeMs");
  pos(p.execution.reentryCooldownSec, "execution.reentryCooldownSec");

  frac(p.breakers.maxDrawdownPct, "breakers.maxDrawdownPct");
  frac(p.breakers.dailyLossLimitPct, "breakers.dailyLossLimitPct");
  frac(p.breakers.leaderCollapsePct, "breakers.leaderCollapsePct");

  if (!Number.isInteger(p.economics.performanceFeeBps) || p.economics.performanceFeeBps < 0 || p.economics.performanceFeeBps > 5000) {
    errs.push(`economics.performanceFeeBps must be an integer within 0..5000, got ${p.economics.performanceFeeBps}`);
  }
  if (!Number.isInteger(p.economics.halfSpreadBps) || p.economics.halfSpreadBps < 0) {
    errs.push(`economics.halfSpreadBps must be a non-negative integer, got ${p.economics.halfSpreadBps}`);
  }
  if (!Number.isInteger(p.economics.maxLevyBps) || p.economics.maxLevyBps < 0) {
    errs.push(`economics.maxLevyBps must be a non-negative integer, got ${p.economics.maxLevyBps}`);
  }

  if (errs.length) throw new Error(`Invalid vault policy:\n  - ${errs.join("\n  - ")}`);
}
