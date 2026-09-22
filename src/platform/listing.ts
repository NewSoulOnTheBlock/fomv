/**
 * What being listed involves, and what the roster promises in return.
 *
 * # Why there is no price in this file
 *
 * `config.ts` prices listing in SOL, enforced by declining to crank an unpaid
 * vault. Both halves of that belong to the pooled design: there is no vault to
 * crank in the follow model, so there is nothing to withhold.
 *
 * What replaced it is a conversation. The fee is quoted on the call, against
 * the book in front of us, and it is deliberately absent from the site --
 * a roster of eight hand-picked traders is not a self-serve product, and a
 * number on a pricing page invites the applicant to decide for themselves
 * whether they are worth it before anyone has looked at their history.
 *
 * So this module carries the terms and not the price. If a price ever appears
 * on the site it should be added here, once, rather than typed into a page.
 */

export interface ListingTerms {
  /** How many leaders the roster will carry. */
  maxRoster: number;
  /** What a listed trader receives. */
  includes: string[];
  /** What a listing explicitly is not, stated up front. */
  excludes: string[];
}

export const LISTING_TERMS: ListingTerms = {
  maxRoster: 8,
  includes: [
    "A full edge audit of your wallet — the same five-dimension grade the roster publishes, computed from your own on-chain history",
    "Your page on the roster, with the audit attached and your guardrails published",
    "A recorded interview, written up and published alongside your listing",
    "The mirror runner configured to your book: sizing, guardrails and circuit breakers reviewed with you before anyone follows",
  ],
  excludes: [
    "A grade. The audit runs on your real history and prints what it prints — a weak grade gets published, not withheld",
    "A guaranteed slot. The roster is capped and a listing can be declined after the audit",
    "Custody of anything. Followers keep their own wallets and their own keys; so do you",
  ],
};

/**
 * Whether an application is worth a call.
 *
 * Deliberately crude and deliberately not automatic. It exists so the funnel
 * can tell an applicant what the bar is before they book thirty minutes, not
 * so a form can reject a trader nobody has looked at.
 */
export const LISTING_BAR = {
  /** Below this, an edge audit measures noise rather than a trader. */
  minClosedTrades: 50,
  /** A book too small to have taken real risk cannot demonstrate risk management. */
  minBookUsd: 10_000,
  /** One chain has an adapter. Everything else is a waiting list, honestly labelled. */
  supportedChains: ["solana"] as const,
} as const;
