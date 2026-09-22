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
 */

export interface FeeTerms {
  /** Cut of each mirrored trade's notional, in bps. */
  tradeFeeBps: number;
  /**
   * Trades below this notional are free.
   *
   * A percentage of a small trade rounds to dust that costs more in fees and
   * account rent to collect than it is worth. Charging it would be theatre.
   */
  minChargeableUsd: number;
  /** Address that receives fees. */
  treasury: string;
}

/**
 * Hard ceiling on the trade fee.
 *
 * The pooled design put its equivalent in a Rust constant so a depositor could
 * verify it without trusting anyone. There is no program here, so this bound
 * is only as good as the code running -- which is exactly why the number is
 * low enough to be unattractive to move, and why the honest framing on the
 * site is "we could change this" rather than "this is enforced".
 */
export const MAX_TRADE_FEE_BPS = 100;

export const DEFAULT_FEE_TERMS: Omit<FeeTerms, "treasury"> = {
  tradeFeeBps: 25,
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
  if (!Number.isFinite(terms.minChargeableUsd) || terms.minChargeableUsd < 0) {
    errs.push(`minChargeableUsd must be >= 0, got ${terms.minChargeableUsd}`);
  }
  if (errs.length) throw new Error(`Invalid fee terms:\n  - ${errs.join("\n  - ")}`);
}

export interface TradeFee {
  /** USD owed on this trade. */
  feeUsd: number;
  /** Notional the fee was computed against. */
  notionalUsd: number;
  bps: number;
  /** Why nothing is owed, when nothing is. */
  waived: "below-minimum" | "zero-rate" | null;
}

/**
 * Fee on one mirrored trade.
 *
 * Computed from the **filled** notional rather than the intended size, because
 * a trade that partially filled or was repriced by the route should be charged
 * for what it actually did. Billing the intent would charge for slippage the
 * subscriber already paid for once.
 */
export function feeForTrade(filledUsd: number, terms: FeeTerms): TradeFee {
  const base = { notionalUsd: filledUsd, bps: terms.tradeFeeBps };
  if (terms.tradeFeeBps === 0) return { ...base, feeUsd: 0, waived: "zero-rate" };
  if (filledUsd < terms.minChargeableUsd) return { ...base, feeUsd: 0, waived: "below-minimum" };
  return { ...base, feeUsd: (filledUsd * terms.tradeFeeBps) / 10_000, waived: null };
}

/**
 * Fees accrued but not yet collected, per subscriber.
 *
 * Accrue-then-sweep rather than charging inside each swap. Appending a
 * transfer to a Jupiter route means a second instruction that can fail on its
 * own, and a failed fee transfer that reverts the whole transaction would cost
 * the subscriber their trade over our invoice. Fees are owed by the account
 * and settled separately, so collection can never break execution.
 */
export interface FeeLedger {
  /** address -> USD accrued and unpaid. */
  owed: Map<string, number>;
  /** address -> USD collected to date, for reporting. */
  collected: Map<string, number>;
}

export function createFeeLedger(): FeeLedger {
  return { owed: new Map(), collected: new Map() };
}

export function accrue(ledger: FeeLedger, address: string, fee: TradeFee): void {
  if (fee.feeUsd <= 0) return;
  ledger.owed.set(address, (ledger.owed.get(address) ?? 0) + fee.feeUsd);
}

export function settle(ledger: FeeLedger, address: string, amountUsd: number): void {
  if (amountUsd <= 0) return;
  const owed = ledger.owed.get(address) ?? 0;
  const paid = Math.min(owed, amountUsd);
  ledger.owed.set(address, owed - paid);
  ledger.collected.set(address, (ledger.collected.get(address) ?? 0) + paid);
}

export function totalOwed(ledger: FeeLedger): number {
  let sum = 0;
  for (const v of ledger.owed.values()) sum += v;
  return sum;
}
