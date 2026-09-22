import { MAX_WITHDRAW_FEE_BPS, LAMPORTS_PER_SOL, type PlatformConfig } from "./config.js";

/**
 * FOMV's two revenue lines, and the arithmetic behind each.
 *
 * The withdrawal fee is the one that has to be exactly right. It is charged
 * on-chain in `initiate_withdrawal`, so anything this module quotes is a
 * *prediction* of what the program will do. Predicting it wrong is worse than
 * not quoting at all: the user signs for one number and the chain charges
 * another. Every rounding decision here therefore mirrors the Rust, including
 * the direction it rounds.
 */

/** Shares are u64 on-chain; keep the whole calculation in bigint. */
export type Shares = bigint;

export interface WithdrawalQuote {
  /** What the member asked to redeem. */
  sharesPresented: Shares;
  /** Skimmed to the treasury, still outstanding against the book. */
  feeShares: Shares;
  /** Actually burned; this is what the in-kind claim pays out against. */
  sharesBurned: Shares;
  feeBps: number;
  /** Fraction of the vault this withdrawal draws, 0..1, for display only. */
  payoutFraction: number;
}

/**
 * Exactly `mul_div_floor(shares, fee_bps, 10_000)` from the program.
 *
 * Floored, not rounded up, and that asymmetry is deliberate. Fees elsewhere in
 * this codebase round toward the pool (see `Fx.bps`) because the counterparty
 * is the pool itself and dust should stay with the members. Here the
 * counterparty is FOMV, and rounding a one-share exit up would hand the
 * platform 100% of it. The house rounds down.
 */
export function withdrawalFeeShares(shares: Shares, feeBps: number): Shares {
  assertBps(feeBps);
  if (shares < 0n) throw new Error(`withdrawalFeeShares: shares must be non-negative, got ${shares}`);
  return (shares * BigInt(feeBps)) / 10_000n;
}

export interface WithdrawalQuoteArgs {
  shares: Shares;
  /** The vault's snapshotted fee, not the platform's current one. */
  vaultWithdrawFeeBps: number;
  /** Total share supply before the burn, for the payout fraction. */
  totalSharesBefore: Shares;
  /**
   * True when the treasury is redeeming its own accumulated fee shares.
   * Charging itself would be a no-op transfer that still costs a CPI, and it
   * would make the platform's realised revenue depend on its own exit timing.
   */
  isTreasury?: boolean;
}

export function quoteWithdrawal(args: WithdrawalQuoteArgs): WithdrawalQuote {
  const { shares, vaultWithdrawFeeBps, totalSharesBefore, isTreasury = false } = args;
  if (shares <= 0n) throw new Error("quoteWithdrawal: shares must be positive");
  if (totalSharesBefore < shares) {
    throw new Error(
      `quoteWithdrawal: cannot redeem ${shares} shares against a supply of ${totalSharesBefore}`,
    );
  }

  const feeBps = isTreasury ? 0 : vaultWithdrawFeeBps;
  const feeShares = withdrawalFeeShares(shares, feeBps);
  const sharesBurned = shares - feeShares;

  // The program rejects this rather than burning nothing and opening an empty
  // claim, so refuse to build the transaction in the first place.
  if (sharesBurned <= 0n) {
    throw new Error(
      `quoteWithdrawal: ${shares} shares at ${feeBps}bps leaves nothing after the protocol fee`,
    );
  }

  return {
    sharesPresented: shares,
    feeShares,
    sharesBurned,
    feeBps,
    payoutFraction: Number(sharesBurned) / Number(totalSharesBefore),
  };
}

/**
 * The most a depositor can lose to the protocol fee, whatever FOMV later does.
 *
 * This is the number worth publishing on a vault page, because it is the one
 * backed by the program rather than by intent: the vault's fee is fixed at
 * listing and the authority can only ratchet it down.
 */
export function maxWithdrawalCostBps(vaultWithdrawFeeBps: number): number {
  assertBps(vaultWithdrawFeeBps);
  return Math.min(vaultWithdrawFeeBps, MAX_WITHDRAW_FEE_BPS);
}

export interface ListingQuote {
  lamports: bigint;
  sol: number;
  usd: number | null;
  /** What to pass as `max_listing_fee_lamports` when signing. */
  maxLamports: bigint;
}

/**
 * Price a listing, with the slippage guard the program expects.
 *
 * `maxLamports` exists because the fee is read from platform state at
 * execution time, not from the transaction. Without a stated ceiling, a
 * repricing that lands between quote and signature silently charges the new
 * figure. The guard defaults to the quote itself: the lister pays what they
 * were shown or the transaction fails.
 */
export function quoteListing(cfg: PlatformConfig, opts: { solPriceUsd?: number; tolerancePct?: number } = {}): ListingQuote {
  const { solPriceUsd, tolerancePct = 0 } = opts;
  if (tolerancePct < 0) throw new Error(`quoteListing: tolerancePct must be >= 0, got ${tolerancePct}`);

  const lamports = cfg.listingFeeLamports;
  const sol = Number(lamports) / Number(LAMPORTS_PER_SOL);
  const slack = (lamports * BigInt(Math.round(tolerancePct * 100))) / 10_000n;

  return {
    lamports,
    sol,
    usd: solPriceUsd === undefined ? null : sol * solPriceUsd,
    maxLamports: lamports + slack,
  };
}

/**
 * Revenue the platform has accrued in one vault, valued at the current NAV.
 *
 * Fee shares are a claim on the book, not cash: until the treasury cranks its
 * own in-kind withdrawal this number moves with the vault's P&L, and a vault
 * that halves takes the platform's unrealised revenue with it. Reporting it as
 * booked revenue would be wrong.
 */
export function unrealisedFeeValue(args: { feeShares: Shares; navPerShareUsd: number }): number {
  const { feeShares, navPerShareUsd } = args;
  if (!Number.isFinite(navPerShareUsd) || navPerShareUsd < 0) {
    throw new Error(`unrealisedFeeValue: navPerShareUsd must be finite and non-negative, got ${navPerShareUsd}`);
  }
  return Number(feeShares) * navPerShareUsd;
}

function assertBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`fee bps must be an integer within 0..10000, got ${bps}`);
  }
}
