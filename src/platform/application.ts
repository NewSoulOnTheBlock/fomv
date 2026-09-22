import { LISTING_BAR } from "./listing.js";

/**
 * A trader asking to be listed.
 *
 * # Why the server keeps this rather than the scheduling tool
 *
 * The funnel ends in a booked call, and it would be less code to send people
 * straight to the calendar and read the answers there. That loses the two
 * things worth having: applications from traders who never booked (the
 * majority, and the list worth chasing), and an address that can be fed
 * straight into `src/cli.ts profile` before the call rather than retyped from
 * a booking form.
 *
 * So the form posts here first and the calendar is shown afterwards. A
 * scheduling tool going away must not take the pipeline with it.
 */

export type ApplicationStatus =
  /** Submitted through the site. Nobody has looked yet. */
  | "new"
  /** A call is on the calendar. */
  | "booked"
  /** An edge audit has been run against the address. */
  | "audited"
  /** Invoiced and paid; onboarding. */
  | "won"
  /** Declined, or went quiet. `note` says which. */
  | "lost";

export interface TraderApplication {
  /** Stable id, generated server-side. Never taken from the client. */
  id: string;
  createdAtMs: number;
  status: ApplicationStatus;

  /** Public handle the trader wants on the roster. */
  handle: string;
  /** The wallet whose history gets audited. One chain, because a listing mirrors one book. */
  address: string;
  chain: string;
  /** Where to reach them. At least one of these is required. */
  email: string | null;
  telegram: string | null;
  twitter: string | null;

  /** Self-reported. Treated as a claim to check, never as a measurement. */
  bookUsd: number | null;
  /** Free text: what they trade and why it should be copyable. */
  strategy: string;
  /** Other addresses they say are theirs, recorded rather than dropped. */
  elsewhere: string[];

  /** Set once the calendar confirms, so a booking is not inferred from a click. */
  bookedAtMs: number | null;
  note: string | null;
}

export interface ApplicationDraft {
  handle?: unknown;
  address?: unknown;
  chain?: unknown;
  email?: unknown;
  telegram?: unknown;
  twitter?: unknown;
  bookUsd?: unknown;
  strategy?: unknown;
  elsewhere?: unknown;
}

/** Longest a free-text field may be before it is a payload rather than an answer. */
const MAX_STRATEGY = 2_000;
const MAX_SHORT = 120;

/**
 * Base58 shape check for a Solana address.
 *
 * Shape only. Whether the address has ever traded is the audit's job, and
 * rejecting a well-formed address here because it looks inactive would turn a
 * lead form into a gatekeeper with none of the data to be one.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value?: Omit<TraderApplication, "id" | "createdAtMs" | "status" | "bookedAtMs" | "note">;
}

/**
 * Validate a submission.
 *
 * Returns every problem at once rather than the first. A form that reveals one
 * mistake per round trip is the single most reliable way to lose an applicant
 * who was willing to pay.
 */
export function validateApplication(draft: ApplicationDraft): ValidationResult {
  const errors: string[] = [];

  const handle = text(draft.handle, MAX_SHORT);
  const address = text(draft.address, MAX_SHORT);
  const chain = (text(draft.chain, 24) || "solana").toLowerCase();
  const email = text(draft.email, MAX_SHORT);
  const telegram = text(draft.telegram, MAX_SHORT);
  const twitter = text(draft.twitter, MAX_SHORT).replace(/^@/, "");
  const strategy = text(draft.strategy, MAX_STRATEGY);

  if (!handle) errors.push("A handle is required — it is what the roster page is titled.");
  else if (!/^[\w.\-]{2,32}$/.test(handle)) {
    errors.push("Handle may use letters, numbers, dots, dashes and underscores, 2-32 characters.");
  }

  if (!address) errors.push("A wallet address is required; there is nothing to audit without one.");
  else if (chain === "solana" && !BASE58_ADDRESS.test(address)) {
    errors.push("That does not look like a Solana address. Paste the account, not a transaction signature.");
  }

  if (!LISTING_BAR.supportedChains.includes(chain as "solana")) {
    errors.push(
      `Only ${LISTING_BAR.supportedChains.join(", ")} can be mirrored today. ` +
        "Applications on other chains are recorded, but there is no adapter to trade them yet.",
    );
  }

  if (!email && !telegram && !twitter) {
    errors.push("Leave at least one way to reach you: email, Telegram or X.");
  }
  if (email && !EMAIL.test(email)) errors.push("That email address does not parse.");

  if (strategy.length < 40) {
    errors.push("Describe the strategy in a sentence or two — 40 characters is the floor.");
  }

  const bookUsd = numberOrNull(draft.bookUsd);
  if (bookUsd !== null && (!Number.isFinite(bookUsd) || bookUsd < 0)) {
    errors.push("Book size must be a positive number of dollars, or left blank.");
  }

  const elsewhere = Array.isArray(draft.elsewhere)
    ? draft.elsewhere.map((a) => text(a, MAX_SHORT)).filter(Boolean).slice(0, 10)
    : [];

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    value: {
      handle,
      address,
      chain,
      email: email || null,
      telegram: telegram || null,
      twitter: twitter || null,
      bookUsd,
      strategy,
      elsewhere,
    },
  };
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

export function createApplication(
  value: NonNullable<ValidationResult["value"]>,
  nowMs: number,
): TraderApplication {
  return {
    id: crypto.randomUUID(),
    createdAtMs: nowMs,
    status: "new",
    bookedAtMs: null,
    note: null,
    ...value,
  };
}

/**
 * Whether the application clears the published bar.
 *
 * Advisory. It sorts the inbox; it does not reject anyone, because the inputs
 * are self-reported and the only figure that decides a listing comes from the
 * audit.
 */
export function meetsBar(app: TraderApplication): boolean {
  return (
    LISTING_BAR.supportedChains.includes(app.chain as "solana") &&
    (app.bookUsd === null || app.bookUsd >= LISTING_BAR.minBookUsd)
  );
}
