import * as Fx from "../num.js";
import type { Fx as Amount } from "../num.js";
import type { VaultPolicy } from "../policy.js";

const SECONDS_PER_YEAR = 31_536_000n; // 365d, matching the stated annual rate

/**
 * One deposit, kept as its own lot with its own high-water mark.
 *
 * Lots exist to defeat the classic hedge-fund equalisation bug. If a member's
 * high-water mark were a single share-weighted average, they could top up after
 * a drawdown to drag their own HWM down, then be charged performance fees on
 * gains that merely recovered earlier losses. Per-lot HWMs make each deposit
 * accountable only to its own entry price.
 */
export interface Lot {
  shares: Amount;
  /** NAV per share at the moment this lot was created. */
  hwmNav: Amount;
  depositedAtMs: number;
}

export interface Member {
  id: string;
  lots: Lot[];
}

/**
 * The platform's cut, as this ledger sees it.
 *
 * Fixed when the vault is listed, mirroring `Vault.withdraw_fee_bps` on-chain,
 * because a fee a depositor can be repriced into is not a fee they agreed to.
 * `null` is a vault with no platform attached, which is how every ledger
 * predating FOMV keeps working unchanged.
 */
export interface PlatformTerms {
  /** Member id that accumulates withdrawal-fee shares. */
  treasuryId: string;
  /** Skim on withdrawals, in bps. */
  withdrawFeeBps: number;
}

export interface LedgerState {
  totalShares: Amount;
  members: Map<string, Member>;
  /** Member id that receives performance and management fees. */
  leaderId: string;
  /** Last time the management fee was accrued. */
  lastAccrualMs: number;
  platform: PlatformTerms | null;
}

export function createLedger(leaderId: string, nowMs: number, platform: PlatformTerms | null = null): LedgerState {
  if (platform) assertFeeBps(platform.withdrawFeeBps);
  const members = new Map([[leaderId, { id: leaderId, lots: [] as Lot[] }]]);
  if (platform && !members.has(platform.treasuryId)) {
    members.set(platform.treasuryId, { id: platform.treasuryId, lots: [] });
  }
  return {
    totalShares: Fx.ZERO,
    members,
    leaderId,
    lastAccrualMs: nowMs,
    platform,
  };
}

/**
 * Lower the platform fee on this vault. A one-way ratchet, matching
 * `set_vault_withdraw_fee` in the program.
 *
 * Enforcing the direction in both places is not redundancy for its own sake:
 * the on-chain rule is what a depositor can verify, and this one is what stops
 * the app from building a transaction that would revert.
 */
export function lowerPlatformFee(state: LedgerState, withdrawFeeBps: number): void {
  if (!state.platform) throw new Error("lowerPlatformFee: vault has no platform terms");
  assertFeeBps(withdrawFeeBps);
  if (withdrawFeeBps > state.platform.withdrawFeeBps) {
    throw new Error(
      `lowerPlatformFee: ${withdrawFeeBps}bps is above the current ${state.platform.withdrawFeeBps}bps; ` +
        `the fee may only be lowered`,
    );
  }
  state.platform.withdrawFeeBps = withdrawFeeBps;
}

function assertFeeBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`withdrawFeeBps must be an integer within 0..10000, got ${bps}`);
  }
}

function member(state: LedgerState, id: string): Member {
  let m = state.members.get(id);
  if (!m) {
    m = { id, lots: [] };
    state.members.set(id, m);
  }
  return m;
}

export function sharesOf(state: LedgerState, id: string): Amount {
  return (state.members.get(id)?.lots ?? []).reduce((a, l) => a + l.shares, Fx.ZERO);
}

/**
 * NAV per share. Seeds at exactly 1.0 for an empty vault so the first
 * depositor's share count equals their dollars, which makes every later number
 * legible to a human reading a statement.
 */
export function navPerShare(state: LedgerState, equityUsd: Amount): Amount {
  if (state.totalShares === Fx.ZERO) return Fx.ONE;
  return Fx.div(equityUsd, state.totalShares);
}

/**
 * Anti-dilution levy, in bps, charged on deposits and withdrawals.
 *
 * Why this exists: a deposit into a fully-invested vault forces the vault to go
 * buy the whole book at market. Without a levy, the incoming member gets shares
 * at yesterday's clean NAV while every existing member silently pays the
 * slippage on their behalf. The levy prices that cost, is paid by the member
 * causing it, and stays in the vault for the members who bore it.
 *
 * It scales with how invested the vault actually is: depositing into a vault
 * sitting entirely in USDC forces no trading and is charged nothing.
 */
export function levyBps(args: { equityUsd: Amount; investedUsd: Amount; policy: VaultPolicy }): number {
  const { equityUsd, investedUsd, policy } = args;
  if (equityUsd <= Fx.ZERO) return 0;
  const exposure = Fx.toNumber(Fx.div(investedUsd, equityUsd));
  const raw = Math.round(policy.economics.halfSpreadBps * Math.max(0, exposure));
  return Math.min(policy.economics.maxLevyBps, raw);
}

export interface DepositResult {
  sharesIssued: Amount;
  levyUsd: Amount;
  navPerShare: Amount;
  /** Vault equity after the deposit, including the retained levy. */
  equityAfterUsd: Amount;
}

export function deposit(
  state: LedgerState,
  args: {
    memberId: string;
    amountUsd: Amount;
    equityUsd: Amount;
    investedUsd: Amount;
    policy: VaultPolicy;
    nowMs: number;
  },
): DepositResult {
  const { memberId, amountUsd, equityUsd, investedUsd, policy, nowMs } = args;
  if (amountUsd <= Fx.ZERO) throw new Error("deposit: amount must be positive");

  const nav = navPerShare(state, equityUsd);
  const levyUsd = Fx.bps(amountUsd, levyBps({ equityUsd, investedUsd, policy }));
  const credited = amountUsd - levyUsd;

  // Round issuance down: leftover dust stays in the pool for everyone rather
  // than being handed to the incoming member.
  const sharesIssued = Fx.mulDivFloor(credited, Fx.ONE, nav);
  if (sharesIssued <= Fx.ZERO) throw new Error("deposit: amount too small to issue any shares");

  member(state, memberId).lots.push({ shares: sharesIssued, hwmNav: nav, depositedAtMs: nowMs });
  state.totalShares += sharesIssued;

  // The full amount lands in the vault; only `credited` was share-backed, so
  // the levy shows up as a small uplift in NAV per share for existing members.
  return { sharesIssued, levyUsd, navPerShare: nav, equityAfterUsd: equityUsd + amountUsd };
}

export interface WithdrawResult {
  sharesBurned: Amount;
  /** Shares transferred to the leader as crystallised performance fee. */
  feeShares: Amount;
  performanceFeeUsd: Amount;
  /** Shares skimmed to the platform treasury. */
  platformFeeShares: Amount;
  platformFeeUsd: Amount;
  levyUsd: Amount;
  payoutUsd: Amount;
  navPerShare: Amount;
  equityAfterUsd: Amount;
}

/** Shares a member may withdraw right now, given the lockup. */
export function unlockedShares(state: LedgerState, memberId: string, policy: VaultPolicy, nowMs: number): Amount {
  const cutoff = nowMs - policy.economics.lockupSec * 1000;
  return (state.members.get(memberId)?.lots ?? [])
    .filter((l) => l.depositedAtMs <= cutoff)
    .reduce((a, l) => a + l.shares, Fx.ZERO);
}

/**
 * Redeem shares for USD, FIFO across lots.
 *
 * The performance fee is crystallised as a *share transfer* to the leader
 * rather than a cash payment. Nothing leaves the vault, no position has to be
 * liquidated to pay it, and NAV per share does not jump on the fee event —
 * the leader simply ends up owning more of the same pool.
 */
export function withdraw(
  state: LedgerState,
  args: {
    memberId: string;
    shares: Amount;
    equityUsd: Amount;
    investedUsd: Amount;
    policy: VaultPolicy;
    nowMs: number;
  },
): WithdrawResult {
  const { memberId, shares, equityUsd, investedUsd, policy, nowMs } = args;
  if (shares <= Fx.ZERO) throw new Error("withdraw: shares must be positive");

  const m = state.members.get(memberId);
  if (!m) throw new Error(`withdraw: unknown member ${memberId}`);

  const available = unlockedShares(state, memberId, policy, nowMs);
  if (shares > available) {
    throw new Error(
      `withdraw: ${Fx.toString(shares)} shares requested but only ${Fx.toString(available)} are past lockup`,
    );
  }

  const nav = navPerShare(state, equityUsd);

  // The platform fee comes off the top, before anything else touches the
  // shares, because that is where the program takes it: `initiate_withdrawal`
  // skims it from the presented amount and burns only the remainder. Charging
  // it anywhere else in this sequence would make the statement disagree with
  // the chain.
  //
  // Floored, matching `mul_div_floor` in the program: the house rounds down,
  // so a dust exit is never swallowed whole by its own fee.
  const platformFeeBps =
    state.platform && memberId !== state.platform.treasuryId ? state.platform.withdrawFeeBps : 0;
  const platformFeeShares =
    platformFeeBps > 0 ? Fx.mulDivFloor(shares, BigInt(platformFeeBps) * Fx.ONE, 10_000n * Fx.ONE) : Fx.ZERO;
  const redeemable = shares - platformFeeShares;
  if (redeemable <= Fx.ZERO) {
    throw new Error(
      `withdraw: ${Fx.toString(shares)} shares at ${platformFeeBps}bps leaves nothing after the platform fee`,
    );
  }

  // Consume lots oldest-first, charging the performance fee per lot against
  // that lot's own high-water mark.
  let remaining = shares;
  let performanceFeeUsd = Fx.ZERO;
  const lots = m.lots.slice().sort((a, b) => a.depositedAtMs - b.depositedAtMs);
  const kept: Lot[] = [];

  for (const lot of lots) {
    if (remaining === Fx.ZERO) {
      kept.push(lot);
      continue;
    }
    const take = Fx.min(remaining, lot.shares);
    const gainPerShare = Fx.max(Fx.ZERO, nav - lot.hwmNav);
    if (gainPerShare > Fx.ZERO) {
      const profit = Fx.mul(take, gainPerShare);
      performanceFeeUsd += Fx.bps(profit, policy.economics.performanceFeeBps);
    }
    remaining -= take;
    const leftover = lot.shares - take;
    if (leftover > Fx.ZERO) kept.push({ ...lot, shares: leftover });
  }
  if (remaining !== Fx.ZERO) throw new Error("withdraw: internal error, lots did not cover requested shares");
  m.lots = kept.sort((a, b) => a.depositedAtMs - b.depositedAtMs);

  // Round the fee's share count up so the pool is never short-changed.
  const feeShares = performanceFeeUsd > Fx.ZERO ? Fx.mulDivCeil(performanceFeeUsd, Fx.ONE, nav) : Fx.ZERO;
  // Capped against what is left after the platform fee, not against the gross:
  // the two fees are claims on the same shares and must not jointly exceed them.
  const cappedFeeShares = Fx.min(feeShares, redeemable);

  if (cappedFeeShares > Fx.ZERO) {
    // The leader's fee shares carry the current NAV as their own high-water
    // mark, so the leader is not later charged a fee on their own fee.
    member(state, state.leaderId).lots.push({ shares: cappedFeeShares, hwmNav: nav, depositedAtMs: nowMs });
  }

  if (platformFeeShares > Fx.ZERO && state.platform) {
    // Same treatment as the performance fee: the treasury ends up owning more
    // of the pool rather than being paid out of it, so no position has to be
    // sold to settle a fee and NAV per share does not move on the fee event.
    member(state, state.platform.treasuryId).lots.push({
      shares: platformFeeShares,
      hwmNav: nav,
      depositedAtMs: nowMs,
    });
  }

  const redeemedShares = redeemable - cappedFeeShares;
  const grossUsd = Fx.mul(redeemedShares, nav);
  const levyUsd = Fx.bps(grossUsd, levyBps({ equityUsd, investedUsd, policy }));
  const payoutUsd = grossUsd - levyUsd;

  // Fee shares moved rather than vanished, so only the redeemed ones burn.
  state.totalShares -= redeemedShares;

  return {
    sharesBurned: redeemedShares,
    feeShares: cappedFeeShares,
    performanceFeeUsd,
    platformFeeShares,
    platformFeeUsd: Fx.mul(platformFeeShares, nav),
    levyUsd,
    payoutUsd,
    navPerShare: nav,
    equityAfterUsd: equityUsd - payoutUsd,
  };
}

/**
 * Accrue the management fee by minting shares to the leader.
 *
 * Minting dilutes every holder pro rata, which is exactly the intended effect,
 * and again avoids having to sell a position to pay a fee in cash.
 */
export function accrueManagementFee(
  state: LedgerState,
  args: { equityUsd: Amount; policy: VaultPolicy; nowMs: number },
): { feeShares: Amount; feeUsd: Amount } {
  const { equityUsd, policy, nowMs } = args;
  const rate = policy.economics.managementFeeBpsAnnual;
  const elapsedMs = nowMs - state.lastAccrualMs;
  if (rate <= 0 || elapsedMs <= 0 || state.totalShares === Fx.ZERO || equityUsd <= Fx.ZERO) {
    state.lastAccrualMs = nowMs;
    return { feeShares: Fx.ZERO, feeUsd: Fx.ZERO };
  }

  const elapsedSec = BigInt(Math.floor(elapsedMs / 1000));
  const annualFee = Fx.bps(equityUsd, rate);
  const feeUsd = Fx.mulDivFloor(annualFee, elapsedSec * Fx.ONE, SECONDS_PER_YEAR * Fx.ONE);
  if (feeUsd <= Fx.ZERO) {
    state.lastAccrualMs = nowMs;
    return { feeShares: Fx.ZERO, feeUsd: Fx.ZERO };
  }

  // Solve for s such that the leader's new shares are worth feeUsd once the
  // dilution from minting them is taken into account:
  //   s / (totalShares + s) * equity = feeUsd
  const denom = equityUsd - feeUsd;
  if (denom <= Fx.ZERO) {
    state.lastAccrualMs = nowMs;
    return { feeShares: Fx.ZERO, feeUsd: Fx.ZERO };
  }
  const feeShares = Fx.mulDivFloor(state.totalShares, feeUsd, denom);

  const nav = navPerShare(state, equityUsd);
  if (feeShares > Fx.ZERO) {
    member(state, state.leaderId).lots.push({ shares: feeShares, hwmNav: nav, depositedAtMs: nowMs });
    state.totalShares += feeShares;
  }
  state.lastAccrualMs = nowMs;
  return { feeShares, feeUsd };
}
