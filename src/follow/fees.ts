/**
 * FOMV's fee model without custody.
 *
 * # Why the withdrawal fee had to go
 *
 * The pooled design charged on exit, taken in shares. Both halves of that
 * depend on custody: there is no withdrawal event when funds never left the
 * subscriber's wallet, and no shares to skim when nothing was ever pooled.
 * Keeping the old fee would have meant inventing an exit to charge for.
 *
 * What is left is the thing FOMV actually provides: each mirrored trade. So
 * the fee attaches there, and a subscriber who never trades never pays.
 *
 * # Charged on notional, not on profit
 *
 * A performance fee is the fairer instrument and it is unavailable here for a
 * structural reason worth recording: measuring profit requires a cost basis,
 * and a wallet the subscriber also trades themselves has no cost basis we can
 * defend. They can buy the same token by hand an hour later, and any profit
 * figure we computed would be partly theirs and partly ours with no way to
 * separate them.
 *
 * Notional is observable, attributable, and cannot be gamed by anything the
 * subscriber does outside the bot. It is also worse for them in a losing
 * month, which is the honest trade and should be stated on the pricing page
 * rather than discovered.
 *
 * # The fee is shared with the leader
 *
 * Half of every fee goes to the trader being copied. That is a revenue share,
 * not a courtesy: the leader supplies the only thing subscribers are paying
 * for, and paying them per mirrored trade aligns the roster with the product.
 * It also gives a leader a reason to stay listed that does not depend on FOMV
 * being generous later.
 *
 * The split is one number (`leaderShareBps`) so it can be renegotiated without
 * touching the arithmetic.
 */

export interface FeeTerms {
  /** Cut of each mirrored trade's notional, in bps. */
  tradeFeeBps: number;
  /**
   * Share of that fee paid to the leader being copied, in bps of the fee.
   *
   * 5000 is an even split. Expressed against the fee rather than against the
   * trade so that changing the headline rate does not silently change who gets
   * what.
   */
  leaderShareBps: number;
  /**
   * Trades below this notional are free.
   *
   * A percentage of a small trade rounds to dust that costs more in fees and
   * account rent to collect than it is worth. Charging it would be theatre.
   */
  minChargeableUsd: number;
  /** Address that receives FOMV's half. */
  treasury: string;
}

/**
 * Hard ceiling on the trade fee.
 *
 * The pooled design put its equivalent in a Rust constant so a depositor could
 * verify it without trusting anyone. There is no program here, so this bound
 * is only as good as the code running -- which is why the honest framing on
 * the site is "we could change this" rather than "this is enforced".
 *
 * Note that the default now sits *at* the ceiling. That is deliberate: it
 * means the published rate cannot be raised without a code change and a
 * release, which is a weaker guarantee than a program but not nothing.
 */
export const MAX_TRADE_FEE_BPS = 100;

export const DEFAULT_FEE_TERMS: Omit<FeeTerms, "treasury"> = {
  tradeFeeBps: 100,
  leaderShareBps: 5_000,
  minChargeableUsd: 20,
};

export function makeFeeTerms(treasury: string, overrides: Partial<Omit<FeeTerms, "treasury">> = {}): FeeTerms {
  const terms: FeeTerms = { ...DEFAULT_FEE_TERMS, ...overrides, treasury };
  validateFeeTerms(terms);
  return terms;
}

export function validateFeeTerms(terms: FeeTerms): void {
  const errs: string[] = [];
  if (!terms.treasury.trim()) errs.push("treasury must be set before any fee can be collected");

  if (!Number.isInteger(terms.tradeFeeBps) || terms.tradeFeeBps < 0) {
    errs.push(`tradeFeeBps must be a non-negative integer, got ${terms.tradeFeeBps}`);
  } else if (terms.tradeFeeBps > MAX_TRADE_FEE_BPS) {
    errs.push(`tradeFeeBps (${terms.tradeFeeBps}) exceeds the ceiling of ${MAX_TRADE_FEE_BPS}`);
  }

  if (!Number.isInteger(terms.leaderShareBps) || terms.leaderShareBps < 0 || terms.leaderShareBps > 10_000) {
    errs.push(`leaderShareBps must be an integer within 0..10000, got ${terms.leaderShareBps}`);
  }

  if (!Number.isFinite(terms.minChargeableUsd) || terms.minChargeableUsd < 0) {
    errs.push(`minChargeableUsd must be >= 0, got ${terms.minChargeableUsd}`);
  }

  if (errs.length) throw new Error(`Invalid fee terms:\n  - ${errs.join("\n  - ")}`);
}

export interface TradeFee {
  /** Total USD owed on this trade. */
  feeUsd: number;
  /** FOMV's share. */
  platformUsd: number;
  /** The copied trader's share. */
  leaderUsd: number;
  /** Notional the fee was computed against. */
  notionalUsd: number;
  bps: number;
  /** Why nothing is owed, when nothing is. */
  waived: "below-minimum" | "zero-rate" | null;
}

/**
 * Fee on one mirrored trade, already split.
 *
 * Computed from the **filled** notional rather than the intended size, because
 * a trade that partially filled or was repriced by the route should be charged
 * for what it actually did. Billing the intent would charge for slippage the
 * subscriber already paid for once.
 *
 * The platform's share is the remainder rather than its own multiplication, so
 * the two halves always sum to exactly what the subscriber was charged. Two
 * independent roundings would leave a residue that belongs to nobody and shows
 * up later as a ledger that will not reconcile.
 */
export function feeForTrade(filledUsd: number, terms: FeeTerms): TradeFee {
  const base = { notionalUsd: filledUsd, bps: terms.tradeFeeBps };
  const nothing = { ...base, feeUsd: 0, platformUsd: 0, leaderUsd: 0 };

  if (terms.tradeFeeBps === 0) return { ...nothing, waived: "zero-rate" };
  if (filledUsd < terms.minChargeableUsd) return { ...nothing, waived: "below-minimum" };

  const feeUsd = (filledUsd * terms.tradeFeeBps) / 10_000;
  const leaderUsd = (feeUsd * terms.leaderShareBps) / 10_000;
  return { ...base, feeUsd, leaderUsd, platformUsd: feeUsd - leaderUsd, waived: null };
}

/**
 * Who owes what, and who is owed what.
 *
 * Two views of the same money, because they answer different questions.
 * `owedBySubscriber` is what an account page must show and what collection
 * chases; `payableTo` is what the payout run needs. Deriving one from the
 * other would mean storing every fee event forever.
 *
 * Accrue-then-sweep rather than charging inside each swap. Appending a
 * transfer to a Jupiter route means a second instruction that can fail on its
 * own, and a failed fee transfer that reverts the whole transaction would cost
 * the subscriber their trade over our invoice. Fees are owed by the account
 * and settled separately, so collection can never break execution.
 */
export interface FeeLedger {
  /** subscriber address -> USD accrued and unpaid. */
  owed: Map<string, number>;
  /** subscriber address -> USD collected to date. */
  collected: Map<string, number>;
  /** payee address -> USD owed to them, across all subscribers. */
  payableTo: Map<string, number>;
  /** payee address -> USD already paid out. */
  paidTo: Map<string, number>;
}

export function createFeeLedger(): FeeLedger {
  return { owed: new Map(), collected: new Map(), payableTo: new Map(), paidTo: new Map() };
}

const bump = (m: Map<string, number>, key: string, amount: number) => {
  if (amount <= 0) return;
  m.set(key, (m.get(key) ?? 0) + amount);
};

/**
 * Record a fee against the subscriber who incurred it and the two payees.
 *
 * `leaderPayout` is passed in rather than read from the leader's trading
 * address, because paying fees into the wallet being watched would move the
 * very balances the strategy sizes against.
 */
export function accrue(ledger: FeeLedger, address: string, fee: TradeFee, payees: { treasury: string; leaderPayout: string }): void {
  if (fee.feeUsd <= 0) return;
  bump(ledger.owed, address, fee.feeUsd);
  bump(ledger.payableTo, payees.treasury, fee.platformUsd);
  bump(ledger.payableTo, payees.leaderPayout, fee.leaderUsd);
}

/** Record collection from a subscriber. Never credits more than was owed. */
export function settle(ledger: FeeLedger, address: string, amountUsd: number): void {
  if (amountUsd <= 0) return;
  const owed = ledger.owed.get(address) ?? 0;
  const paid = Math.min(owed, amountUsd);
  ledger.owed.set(address, owed - paid);
  bump(ledger.collected, address, paid);
}

/** Record a payout to a payee. Never credits more than was payable. */
export function payout(ledger: FeeLedger, payee: string, amountUsd: number): void {
  if (amountUsd <= 0) return;
  const payable = ledger.payableTo.get(payee) ?? 0;
  const sent = Math.min(payable, amountUsd);
  ledger.payableTo.set(payee, payable - sent);
  bump(ledger.paidTo, payee, sent);
}

export function totalOwed(ledger: FeeLedger): number {
  let sum = 0;
  for (const v of ledger.owed.values()) sum += v;
  return sum;
}

export function totalPayable(ledger: FeeLedger): number {
  let sum = 0;
  for (const v of ledger.payableTo.values()) sum += v;
  return sum;
}
