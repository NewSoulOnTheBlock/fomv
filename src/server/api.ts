import type { PrivyClient } from "@privy-io/server-auth";

import { makePolicy } from "../policy.js";
import { createSubscriber, markRevoked, transition, type Subscriber } from "../follow/subscriber.js";
import { DEFAULT_FEE_TERMS } from "../follow/fees.js";
import { LAUNCH_ROSTER } from "../platform/roster.js";
import { LISTING_BAR, LISTING_TERMS } from "../platform/listing.js";
import { createApplication, validateApplication } from "../platform/application.js";
import { verifyCaller } from "./privy.js";
import type { Store } from "./store.js";

/**
 * HTTP surface for the follow server.
 *
 * # The security property that matters
 *
 * Every endpoint that names a wallet verifies the caller's Privy access token
 * first and only ever acts on a wallet belonging to **that** user. Taking a
 * user id from the request body would let anyone enrol a stranger's wallet, or
 * unsubscribe a paying one. The token is the only identity claim trusted here.
 *
 * Granting delegation itself happens in the browser, not through this API --
 * Privy prompts the user directly. This server only records that it happened
 * and verifies it independently before trading.
 */

export interface ApiDeps {
  store: Store;
  privy: PrivyClient;
  /** Reject requests from unknown origins. Empty means same-origin only. */
  allowedOrigins: string[];
  /**
   * Bearer token guarding the applications inbox.
   *
   * Absent means the endpoint is not served at all. An admin route that falls
   * back to "open" when its secret is missing is how a lead list ends up
   * public the first time an environment variable is forgotten.
   */
  adminToken?: string;
}

/**
 * Applications accepted per hour, process-wide.
 *
 * Deliberately a blunt global rather than a per-IP bucket. Behind a proxy the
 * client IP is a header the client can set, so keying on it would be security
 * theatre; the honest version is a cap on how much junk one process will store
 * in an hour. A real trader who hits it during a flood can mail us, and the
 * page says so.
 */
const APPLICATIONS_PER_HOUR = 40;

/** Largest application body accepted, before parsing. */
const MAX_APPLICATION_BYTES = 8_192;

export function createHandler(deps: ApiDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const cors = corsHeaders(req, deps.allowedOrigins);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/health") return json({ ok: true }, 200, cors);
      if (url.pathname === "/leaders") return json({ leaders: LAUNCH_ROSTER.map(publicLeader) }, 200, cors);
      if (url.pathname === "/terms") {
        return json({ fees: DEFAULT_FEE_TERMS, listing: LISTING_TERMS, bar: LISTING_BAR }, 200, cors);
      }

      if (url.pathname === "/apply" && req.method === "POST") return apply(req, deps, cors);
      if (url.pathname === "/admin/applications" && req.method === "GET") {
        return applications(req, deps, cors);
      }

      if (url.pathname === "/subscribe" && req.method === "POST") return subscribe(req, deps, cors);
      if (url.pathname === "/unsubscribe" && req.method === "POST") return unsubscribe(req, deps, cors);
      if (url.pathname === "/me" && req.method === "GET") return me(req, deps, cors);

      return json({ error: "not found" }, 404, cors);
    } catch (err) {
      // Never echo an internal message to the caller: it leaks table names,
      // paths and library versions to anyone poking at the endpoint.
      console.error("[api]", err);
      return json({ error: "internal error" }, 500, cors);
    }
  };
}

function publicLeader(entry: (typeof LAUNCH_ROSTER)[number]) {
  return { handle: entry.handle, leader: entry.leader, chain: entry.chain };
}

/**
 * A trader asking to be listed.
 *
 * # Why this one endpoint is unauthenticated
 *
 * Every other route here refuses to act without a Privy token, because every
 * other route acts on somebody's wallet. This one writes a row in a table
 * nobody's money depends on, and requiring a sign-up before a trader can tell
 * us they exist would lose most of them at the door.
 *
 * What replaces the token is a narrow shape: the body is size-capped before it
 * is parsed, every field is validated and truncated, the id and timestamp are
 * generated here rather than taken from the caller, and the whole endpoint has
 * an hourly ceiling. The worst case is a table of junk rows, which is a
 * cleanup, not an incident.
 */
async function apply(req: Request, deps: ApiDeps, cors: Record<string, string>): Promise<Response> {
  const raw = await req.text();
  if (raw.length > MAX_APPLICATION_BYTES) {
    return json({ error: "That application is too long to be one." }, 413, cors);
  }

  const draft = safeParse(raw);
  if (!draft) return json({ error: "Malformed body." }, 400, cors);

  const result = validateApplication(draft);
  // Field errors are returned in full: the caller is a form that can show
  // them, and a generic 400 would make the applicant guess.
  if (!result.ok || !result.value) return json({ errors: result.errors }, 400, cors);

  if (deps.store.applicationsSince(Date.now() - 3_600_000) >= APPLICATIONS_PER_HOUR) {
    return json(
      { errors: ["We are taking more applications than we can store this hour. Try again shortly."] },
      429,
      cors,
    );
  }

  const stored = deps.store.upsertApplication(createApplication(result.value, Date.now()));

  // Only the id comes back. Echoing the stored row would let anyone confirm
  // whether a given address has applied by submitting it and reading the reply.
  return json({ id: stored.id, received: true }, 201, cors);
}

/** The applications inbox. Bearer-guarded, and absent when no token is set. */
function applications(req: Request, deps: ApiDeps, cors: Record<string, string>): Response {
  if (!deps.adminToken) return json({ error: "not found" }, 404, cors);

  const presented = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
  if (!timingSafeEqual(presented, deps.adminToken)) {
    return json({ error: "unauthorized" }, 401, cors);
  }

  return json({ applications: deps.store.listApplications() }, 200, cors);
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time string comparison.
 *
 * `===` on a secret leaks its prefix through timing. The cost of not caring is
 * low here and the cost of caring is four lines.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Enrol the caller's own wallet against a leader.
 *
 * Starts at `pending`, never `active`. Whether delegation actually exists is
 * not this endpoint's to assert -- the mirror loop asks Privy before it signs,
 * and a subscriber who claims delegation they never granted simply never gets
 * a signature. Recording intent and verifying permission are kept separate on
 * purpose.
 */
async function subscribe(req: Request, deps: ApiDeps, cors: Record<string, string>): Promise<Response> {
  const caller = await verifyCaller(deps.privy, req.headers.get("authorization"));
  if (!caller) return json({ error: "unauthorized" }, 401, cors);

  const body = (await req.json().catch(() => null)) as {
    address?: string;
    walletId?: string;
    leader?: string;
  } | null;

  if (!body?.address || !body.walletId || !body.leader) {
    return json({ error: "address, walletId and leader are required" }, 400, cors);
  }

  const rosterEntry = LAUNCH_ROSTER.find((r) => r.leader === body.leader);
  if (!rosterEntry) return json({ error: "unknown leader" }, 400, cors);

  // The wallet must belong to the authenticated user. Checked against Privy's
  // record rather than the request, which is the whole point of the token.
  const owns = await walletBelongsTo(deps, caller.userId, body.address);
  if (!owns) return json({ error: "wallet does not belong to this account" }, 403, cors);

  const existing = deps.store.getSubscriber(body.address);
  const now = Date.now();

  if (existing) {
    // Re-subscribing after revoking is a fresh consent, so it re-enters at
    // pending rather than resuming a permission that was withdrawn.
    if (existing.status === "revoked") transition(existing, "pending");
    existing.leader = body.leader;
    existing.walletId = body.walletId;
    deps.store.upsertSubscriber(existing);
    return json({ subscriber: publicSubscriber(existing) }, 200, cors);
  }

  const sub = createSubscriber({
    userId: caller.userId,
    walletId: body.walletId,
    address: body.address,
    leader: body.leader,
    policy: makePolicy(`follow-${rosterEntry.handle}`, body.leader),
    nowMs: now,
  });
  deps.store.upsertSubscriber(sub);
  return json({ subscriber: publicSubscriber(sub) }, 201, cors);
}

async function unsubscribe(req: Request, deps: ApiDeps, cors: Record<string, string>): Promise<Response> {
  const caller = await verifyCaller(deps.privy, req.headers.get("authorization"));
  if (!caller) return json({ error: "unauthorized" }, 401, cors);

  const body = (await req.json().catch(() => null)) as { address?: string } | null;
  if (!body?.address) return json({ error: "address is required" }, 400, cors);

  const sub = deps.store.getSubscriber(body.address);
  if (!sub) return json({ error: "not subscribed" }, 404, cors);
  // Only the owner may stop their own follow.
  if (sub.userId !== caller.userId) return json({ error: "forbidden" }, 403, cors);

  markRevoked(sub, "unsubscribed by user");
  deps.store.upsertSubscriber(sub);
  return json({ subscriber: publicSubscriber(sub) }, 200, cors);
}

async function me(req: Request, deps: ApiDeps, cors: Record<string, string>): Promise<Response> {
  const caller = await verifyCaller(deps.privy, req.headers.get("authorization"));
  if (!caller) return json({ error: "unauthorized" }, 401, cors);

  const mine = deps.store.allSubscribers().filter((s) => s.userId === caller.userId);
  const ledger = deps.store.loadFeeLedger();

  return json(
    {
      subscriptions: mine.map((s) => ({
        ...publicSubscriber(s),
        feesOwedUsd: ledger.owed.get(s.address) ?? 0,
        feesPaidUsd: ledger.collected.get(s.address) ?? 0,
      })),
    },
    200,
    cors,
  );
}

async function walletBelongsTo(deps: ApiDeps, userId: string, address: string): Promise<boolean> {
  try {
    const user = await deps.privy.getUserById(userId);
    return (user.linkedAccounts ?? []).some((a) => (a as { address?: string }).address === address);
  } catch {
    // Failing closed: an unverifiable claim of ownership is not ownership.
    return false;
  }
}

/** Never returns another user's id, the wallet id, or the processed set. */
function publicSubscriber(sub: Subscriber) {
  return {
    address: sub.address,
    leader: sub.leader,
    status: sub.status,
    subscribedAtMs: sub.subscribedAtMs,
    note: sub.note ?? null,
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function corsHeaders(req: Request, allowed: string[]): Record<string, string> {
  const origin = req.headers.get("origin");
  const base = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    vary: "origin",
  };
  // An explicit allowlist rather than "*", because these endpoints carry a
  // bearer token and a wildcard would let any page spend a user's session.
  if (origin && allowed.includes(origin)) {
    return { ...base, "access-control-allow-origin": origin };
  }
  return base;
}
