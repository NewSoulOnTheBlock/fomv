import type { VaultPolicy } from "../policy.js";
import type { CopyabilityScore } from "../scoring/score.js";
import { MAX_WITHDRAW_FEE_BPS, type PlatformConfig } from "./config.js";

/**
 * The FOMV roster: which leaders are listed, and what state each listing is in.
 *
 * # Why this is the listing fee's enforcement point
 *
 * The withdrawal fee is charged by the program, because withdrawals are
 * permissionless and an app-side skim on them would simply be bypassed by
 * calling the program directly.
 *
 * The listing fee is the opposite. A vault is inert without a crank: only the
 * `manager` key may post NAV, and without a fresh NAV no deposit can settle.
 * So the platform does not need to charge for listing on-chain -- it needs only
 * to decline to crank a vault that has not paid. `shouldCrank` is that
 * decision, and it is the whole enforcement mechanism.
 *
 * The consequence worth stating plainly: refusing to crank stops *deposits*,
 * never *exits*. In-kind withdrawal needs no NAV and no manager.
 */

export type ListingStatus =
  /** Leader applied or was sourced; not yet vetted. */
  | "applied"
  /** Passed vetting. May pay to list. */
  | "approved"
  /** Vault exists on-chain and the listing fee is paid. Not yet cranked. */
  | "listed"
  /** Cranked, priced, accepting deposits. */
  | "live"
  /** Crank halted. Deposits stop; in-kind withdrawal is unaffected. */
  | "suspended"
  /** Terminal: never listed. */
  | "rejected"
  /** Terminal: was listed, now wound down. */
  | "delisted";

export interface VaultListing {
  /** Leader's wallet address. Also the vault PDA's seed on-chain. */
  leader: string;
  /** Display handle for the vault page. */
  handle: string;
  status: ListingStatus;

  /** Set once the vault account exists on-chain. */
  vaultAddress?: string;

  /**
   * The vault's own withdrawal fee, snapshotted at listing.
   *
   * Held here as well as on-chain so the app can render a vault page without
   * an RPC round trip. The chain is authoritative; this is a cache, and
   * `reconcile` exists to say so out loud.
   */
  withdrawFeeBps?: number;

  /** Lamports actually paid to list. Absent until the listing transaction lands. */
  listingFeePaidLamports?: bigint;
  listedAtMs?: number;

  /** Guardrails this vault publishes to depositors. */
  policy?: VaultPolicy;
  /** Most recent copyability grade from `src/scoring`. */
  score?: CopyabilityScore;

  /** Why the listing is in its current state, for the status page. */
  note?: string;
}

export interface Registry {
  config: PlatformConfig;
  listings: Map<string, VaultListing>;
}

export function createRegistry(config: PlatformConfig): Registry {
  return { config, listings: new Map() };
}

/**
 * Legal moves. Everything not listed here is rejected, so a listing cannot
 * reach `live` without having passed through paying to list.
 */
const TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  applied: ["approved", "rejected"],
  approved: ["listed", "rejected"],
  listed: ["live", "delisted"],
  live: ["suspended", "delisted"],
  suspended: ["live", "delisted"],
  rejected: [],
  delisted: [],
};

export function canTransition(from: ListingStatus, to: ListingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function apply(reg: Registry, args: { leader: string; handle: string }): VaultListing {
  const { leader, handle } = args;
  if (!leader.trim()) throw new Error("apply: leader must not be empty");
  if (reg.listings.has(leader)) throw new Error(`apply: ${leader} has already applied`);

  const listing: VaultListing = { leader, handle, status: "applied" };
  reg.listings.set(leader, listing);
  return listing;
}

export function get(reg: Registry, leader: string): VaultListing {
  const l = reg.listings.get(leader);
  if (!l) throw new Error(`unknown listing: ${leader}`);
  return l;
}

export function approve(
  reg: Registry,
  args: { leader: string; policy: VaultPolicy; score?: CopyabilityScore; note?: string },
): VaultListing {
  const l = get(reg, args.leader);
  transition(l, "approved");
  l.policy = args.policy;
  l.score = args.score;
  l.note = args.note;
  return l;
}

export function reject(reg: Registry, leader: string, note: string): VaultListing {
  const l = get(reg, leader);
  transition(l, "rejected");
  l.note = note;
  return l;
}

/**
 * Record that a vault was created on-chain and the listing fee was paid.
 *
 * Takes the fee actually paid rather than the configured one, because the two
 * can legitimately differ: the transaction was signed against whatever the
 * platform charged at that slot. Recording the configured figure would quietly
 * rewrite history the next time fees changed.
 */
export function recordListed(
  reg: Registry,
  args: {
    leader: string;
    vaultAddress: string;
    withdrawFeeBps: number;
    listingFeePaidLamports: bigint;
    nowMs: number;
  },
): VaultListing {
  const l = get(reg, args.leader);
  if (args.withdrawFeeBps > MAX_WITHDRAW_FEE_BPS) {
    throw new Error(
      `recordListed: on-chain withdrawFeeBps ${args.withdrawFeeBps} exceeds the protocol ceiling ` +
        `${MAX_WITHDRAW_FEE_BPS}; refusing to record a state the program cannot have produced`,
    );
  }
  transition(l, "listed");
  l.vaultAddress = args.vaultAddress;
  l.withdrawFeeBps = args.withdrawFeeBps;
  l.listingFeePaidLamports = args.listingFeePaidLamports;
  l.listedAtMs = args.nowMs;
  return l;
}

export function liveCount(reg: Registry): number {
  let n = 0;
  for (const l of reg.listings.values()) if (l.status === "live") n++;
  return n;
}

/** Vaults currently on the roster, oldest listing first. */
export function roster(reg: Registry): VaultListing[] {
  return [...reg.listings.values()]
    .filter((l) => l.status === "live" || l.status === "suspended")
    .sort((a, b) => (a.listedAtMs ?? 0) - (b.listedAtMs ?? 0));
}

export function goLive(reg: Registry, leader: string): VaultListing {
  const l = get(reg, leader);
  if (l.status !== "suspended" && liveCount(reg) >= reg.config.maxLiveVaults) {
    throw new Error(
      `goLive: roster is full at ${reg.config.maxLiveVaults} live vaults; delist one or raise maxLiveVaults`,
    );
  }
  transition(l, "live");
  l.note = undefined;
  return l;
}

export function suspend(reg: Registry, leader: string, note: string): VaultListing {
  const l = get(reg, leader);
  transition(l, "suspended");
  l.note = note;
  return l;
}

export function delist(reg: Registry, leader: string, note: string): VaultListing {
  const l = get(reg, leader);
  transition(l, "delisted");
  l.note = note;
  return l;
}

/**
 * Whether the crank should run this vault right now.
 *
 * The single gate on unpaid listings, and deliberately the only thing that
 * reads `status` at runtime. Everything else about a vault -- its holdings, its
 * shares, the right of its depositors to leave -- lives on-chain and keeps
 * working whatever this returns.
 */
export function shouldCrank(l: VaultListing): boolean {
  return l.status === "live" && l.vaultAddress !== undefined;
}

/**
 * Compare the cached fee against what the chain says.
 *
 * The authority can ratchet a vault's fee down on-chain at any time, so the
 * cache goes stale in exactly one direction. Returning the drift rather than
 * silently overwriting means an *upward* difference -- which the program cannot
 * produce -- surfaces as the anomaly it would be.
 */
export function reconcile(
  l: VaultListing,
  onChainWithdrawFeeBps: number,
): { changed: boolean; suspicious: boolean; from?: number; to: number } {
  const from = l.withdrawFeeBps;
  l.withdrawFeeBps = onChainWithdrawFeeBps;
  if (from === undefined) return { changed: true, suspicious: false, to: onChainWithdrawFeeBps };
  return {
    changed: from !== onChainWithdrawFeeBps,
    suspicious: onChainWithdrawFeeBps > from,
    from,
    to: onChainWithdrawFeeBps,
  };
}

function transition(l: VaultListing, to: ListingStatus): void {
  if (!canTransition(l.status, to)) {
    throw new Error(`illegal listing transition for ${l.leader}: ${l.status} -> ${to}`);
  }
  l.status = to;
}
