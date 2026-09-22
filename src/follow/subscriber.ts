import type { VaultPolicy } from "../policy.js";
import { emptyMemory, type FollowMemory } from "./wallet-state.js";

/**
 * Someone following a leader with their own wallet.
 *
 * # What replaced the vault
 *
 * A pooled vault needed shares, a NAV, a custody model and a program to make
 * any of it trustworthy. None of that survives here, and the reason is worth
 * keeping written down: **funds are never commingled**, so there is nothing to
 * apportion. A subscriber's position is their own balance. Their P&L is the
 * change in it. There is no unit to price, no high-water mark to track, and
 * no pot for anyone to run off with.
 *
 * What replaced custody is delegation: the subscriber authorises this server
 * to sign trades for their wallet and can withdraw that permission at any
 * moment without asking. `status` is our belief about that permission; Privy
 * holds the truth, and `WalletSigner.isActive` is what actually decides.
 */

export type SubscriberStatus =
  /** Signed up, delegation not yet granted. Nothing can be signed. */
  | "pending"
  /** Delegation granted and confirmed. Trades are mirrored. */
  | "active"
  /** Temporarily stopped by the subscriber. Delegation may still exist. */
  | "paused"
  /** Delegation withdrawn. Terminal until they grant it again. */
  | "revoked";

export interface Subscriber {
  /** Privy user id. */
  userId: string;
  /** Privy's id for the embedded wallet, needed to request a signature. */
  walletId: string;
  /** On-chain address. Balances are read from here. */
  address: string;
  /** Leader being mirrored. One leader per subscriber: one wallet, one book. */
  leader: string;
  status: SubscriberStatus;
  /** Guardrails this subscriber trades under. */
  policy: VaultPolicy;
  /** Facts the chain cannot report back. */
  memory: FollowMemory;
  /** Opaque watcher cursor, so a restart resumes rather than replays. */
  cursor: string | null;
  /**
   * Leader trade ids already acted on for this subscriber.
   *
   * Per subscriber rather than global: two people following the same leader
   * must each mirror the same trade, and one of them having done so says
   * nothing about the other.
   */
  processed: Set<string>;
  subscribedAtMs: number;
  /** Why the subscriber is in its current state, for the account page. */
  note?: string;
}

export function createSubscriber(args: {
  userId: string;
  walletId: string;
  address: string;
  leader: string;
  policy: VaultPolicy;
  nowMs: number;
}): Subscriber {
  return {
    userId: args.userId,
    walletId: args.walletId,
    address: args.address,
    leader: args.leader,
    status: "pending",
    policy: args.policy,
    memory: emptyMemory(),
    cursor: null,
    processed: new Set(),
    subscribedAtMs: args.nowMs,
  };
}

const TRANSITIONS: Record<SubscriberStatus, readonly SubscriberStatus[]> = {
  pending: ["active", "revoked"],
  active: ["paused", "revoked"],
  paused: ["active", "revoked"],
  // Re-granting delegation produces a fresh consent, so it re-enters at
  // pending rather than silently resuming a permission that was withdrawn.
  revoked: ["pending"],
};

export function canTransition(from: SubscriberStatus, to: SubscriberStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(sub: Subscriber, to: SubscriberStatus, note?: string): Subscriber {
  if (!canTransition(sub.status, to)) {
    throw new Error(`illegal subscriber transition for ${sub.address}: ${sub.status} -> ${to}`);
  }
  sub.status = to;
  sub.note = note;
  return sub;
}

/**
 * Whether we should attempt to trade for this subscriber right now.
 *
 * Deliberately not the only gate. This is our local belief; the signer asks
 * Privy whether the delegation still exists before every signature, because
 * revocation happens in the app and never tells this server.
 */
export function shouldMirror(sub: Subscriber): boolean {
  return sub.status === "active";
}

/**
 * Mark a subscriber as revoked after the signer refused.
 *
 * Idempotent, because several concurrent cycles can each discover the same
 * revocation and none of them should throw over it.
 */
export function markRevoked(sub: Subscriber, note = "delegation withdrawn"): Subscriber {
  if (sub.status === "revoked") return sub;
  sub.status = "revoked";
  sub.note = note;
  return sub;
}

export interface Registry {
  subscribers: Map<string, Subscriber>;
}

export function createRegistry(): Registry {
  return { subscribers: new Map() };
}

/** Keyed by wallet address: one followed book per wallet. */
export function add(reg: Registry, sub: Subscriber): Subscriber {
  if (reg.subscribers.has(sub.address)) {
    throw new Error(`add: ${sub.address} is already subscribed`);
  }
  reg.subscribers.set(sub.address, sub);
  return sub;
}

export function get(reg: Registry, address: string): Subscriber {
  const s = reg.subscribers.get(address);
  if (!s) throw new Error(`unknown subscriber: ${address}`);
  return s;
}

/** Everyone currently being mirrored, grouped by the leader they follow. */
export function activeByLeader(reg: Registry): Map<string, Subscriber[]> {
  const out = new Map<string, Subscriber[]>();
  for (const s of reg.subscribers.values()) {
    if (!shouldMirror(s)) continue;
    const list = out.get(s.leader);
    if (list) list.push(s);
    else out.set(s.leader, [s]);
  }
  return out;
}
