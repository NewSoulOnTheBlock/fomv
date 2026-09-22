import { Database } from "bun:sqlite";

import { makePolicy, type VaultPolicy } from "../policy.js";
import { createFeeLedger, type FeeLedger } from "../follow/fees.js";
import type { Subscriber, SubscriberStatus } from "../follow/subscriber.js";
import { emptyMemory, type FollowMemory } from "../follow/wallet-state.js";
import type { ApplicationStatus, TraderApplication } from "../platform/application.js";

/**
 * Durable state for the follow server.
 *
 * # Why SQLite and not a JSON file
 *
 * Two of these tables grow without bound if nothing stops them. `processed`
 * gains a row per mirrored trade per subscriber forever, and rewriting a JSON
 * document on every cycle turns that into an O(n) write that eventually stalls
 * the loop. SQLite also survives a crash mid-write, which a rewritten file
 * does not, and `bun:sqlite` ships with the runtime so it adds no dependency
 * and no service to operate.
 *
 * # What must survive a restart, and what must not
 *
 * Balances are deliberately absent. They are read from chain every cycle (see
 * `wallet-state.ts`), because remembered balances drift the moment a
 * subscriber trades their own wallet. The only things stored here are facts
 * the chain cannot report back: who consented, where their cursor reached,
 * which trades were already acted on, and what they owe.
 */

export interface StoreOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  /**
   * Days of `processed` history to keep.
   *
   * The set exists to stop a trade being mirrored twice. A trade older than
   * the watcher's own `maxTradeAgeMs` can never be re-offered, so keeping its
   * id forever protects nothing and costs a row. A week is far beyond any
   * plausible replay window.
   */
  processedRetentionDays?: number;
}

export class Store {
  private readonly db: Database;
  private readonly retentionDays: number;

  constructor(opts: StoreOptions) {
    this.db = new Database(opts.path);
    this.retentionDays = opts.processedRetentionDays ?? 7;
    // WAL keeps the HTTP handlers readable while the mirror loop writes.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscribers (
        address       TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        wallet_id     TEXT NOT NULL,
        leader        TEXT NOT NULL,
        status        TEXT NOT NULL,
        policy_json   TEXT NOT NULL,
        memory_json   TEXT NOT NULL,
        cursor        TEXT,
        utc_day       TEXT,
        note          TEXT,
        subscribed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed (
        address  TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        seen_at  INTEGER NOT NULL,
        PRIMARY KEY (address, trade_id)
      );
      CREATE INDEX IF NOT EXISTS processed_seen_at ON processed (seen_at);

      CREATE TABLE IF NOT EXISTS fees (
        address       TEXT PRIMARY KEY,
        owed_usd      REAL NOT NULL DEFAULT 0,
        collected_usd REAL NOT NULL DEFAULT 0
      );

      -- Who we owe, as opposed to who owes us. Separate because the two
      -- answer different questions: this one drives the payout run.
      CREATE TABLE IF NOT EXISTS payees (
        address      TEXT PRIMARY KEY,
        payable_usd  REAL NOT NULL DEFAULT 0,
        paid_usd     REAL NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS subscribers_leader_status ON subscribers (leader, status);

      CREATE TABLE IF NOT EXISTS applications (
        id          TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        status      TEXT NOT NULL,
        handle      TEXT NOT NULL,
        address     TEXT NOT NULL,
        chain       TEXT NOT NULL,
        email       TEXT,
        telegram    TEXT,
        twitter     TEXT,
        book_usd    REAL,
        strategy    TEXT NOT NULL,
        elsewhere   TEXT NOT NULL,
        booked_at   INTEGER,
        note        TEXT
      );
      CREATE INDEX IF NOT EXISTS applications_created ON applications (created_at);
      -- One live application per address. A trader who applies twice is
      -- updating their answers, not queueing behind themselves.
      CREATE UNIQUE INDEX IF NOT EXISTS applications_address ON applications (address);
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- subscribers ---------------------------------------------------------

  upsertSubscriber(sub: Subscriber): void {
    this.db
      .query(
        `INSERT INTO subscribers
           (address, user_id, wallet_id, leader, status, policy_json, memory_json, cursor, utc_day, note, subscribed_at)
         VALUES ($address, $userId, $walletId, $leader, $status, $policy, $memory, $cursor, $utcDay, $note, $subscribedAt)
         ON CONFLICT(address) DO UPDATE SET
           user_id = $userId, wallet_id = $walletId, leader = $leader, status = $status,
           policy_json = $policy, memory_json = $memory, cursor = $cursor,
           utc_day = $utcDay, note = $note`,
      )
      .run({
        $address: sub.address,
        $userId: sub.userId,
        $walletId: sub.walletId,
        $leader: sub.leader,
        $status: sub.status,
        $policy: JSON.stringify(sub.policy),
        $memory: serialiseMemory(sub.memory),
        $cursor: sub.cursor,
        $utcDay: (sub as Subscriber & { utcDay?: string }).utcDay ?? null,
        $note: sub.note ?? null,
        $subscribedAt: sub.subscribedAtMs,
      });
  }

  getSubscriber(address: string): Subscriber | null {
    const row = this.db.query(`SELECT * FROM subscribers WHERE address = ?`).get(address) as SubscriberRow | null;
    return row ? this.hydrate(row) : null;
  }

  /** Every subscriber currently mirroring, grouped by leader. */
  activeByLeader(): Map<string, Subscriber[]> {
    const rows = this.db.query(`SELECT * FROM subscribers WHERE status = 'active'`).all() as SubscriberRow[];
    const out = new Map<string, Subscriber[]>();
    for (const row of rows) {
      const sub = this.hydrate(row);
      const list = out.get(sub.leader);
      if (list) list.push(sub);
      else out.set(sub.leader, [sub]);
    }
    return out;
  }

  allSubscribers(): Subscriber[] {
    const rows = this.db.query(`SELECT * FROM subscribers`).all() as SubscriberRow[];
    return rows.map((r) => this.hydrate(r));
  }

  private hydrate(row: SubscriberRow): Subscriber {
    const processed = new Set(
      (this.db.query(`SELECT trade_id FROM processed WHERE address = ?`).all(row.address) as { trade_id: string }[]).map(
        (r) => r.trade_id,
      ),
    );

    const sub: Subscriber & { utcDay?: string } = {
      address: row.address,
      userId: row.user_id,
      walletId: row.wallet_id,
      leader: row.leader,
      status: row.status as SubscriberStatus,
      policy: revivePolicy(row.policy_json),
      memory: deserialiseMemory(row.memory_json),
      cursor: row.cursor,
      processed,
      subscribedAtMs: row.subscribed_at,
      note: row.note ?? undefined,
    };
    if (row.utc_day) sub.utcDay = row.utc_day;
    return sub;
  }

  // --- processed ids -------------------------------------------------------

  /**
   * Record acted-on trades.
   *
   * Written separately from the subscriber row and immediately after a fill,
   * so a crash between broadcasting and persisting cannot leave a trade
   * eligible to be mirrored a second time.
   */
  markProcessed(address: string, tradeIds: Iterable<string>, nowMs: number): void {
    const stmt = this.db.query(
      `INSERT OR IGNORE INTO processed (address, trade_id, seen_at) VALUES (?, ?, ?)`,
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(address, id, nowMs);
    });
    tx([...tradeIds]);
  }

  /** Drop ids far older than any possible replay. Returns rows removed. */
  pruneProcessed(nowMs: number): number {
    const cutoff = nowMs - this.retentionDays * 86_400_000;
    return this.db.query(`DELETE FROM processed WHERE seen_at < ?`).run(cutoff).changes;
  }

  // --- fees ----------------------------------------------------------------

  loadFeeLedger(): FeeLedger {
    const ledger = createFeeLedger();
    const rows = this.db.query(`SELECT * FROM fees`).all() as FeeRow[];
    for (const r of rows) {
      if (r.owed_usd > 0) ledger.owed.set(r.address, r.owed_usd);
      if (r.collected_usd > 0) ledger.collected.set(r.address, r.collected_usd);
    }
    const payees = this.db.query(`SELECT * FROM payees`).all() as PayeeRow[];
    for (const p of payees) {
      if (p.payable_usd > 0) ledger.payableTo.set(p.address, p.payable_usd);
      if (p.paid_usd > 0) ledger.paidTo.set(p.address, p.paid_usd);
    }
    return ledger;
  }

  saveFeeLedger(ledger: FeeLedger): void {
    const stmt = this.db.query(
      `INSERT INTO fees (address, owed_usd, collected_usd) VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET owed_usd = excluded.owed_usd, collected_usd = excluded.collected_usd`,
    );
    const payeeStmt = this.db.query(
      `INSERT INTO payees (address, payable_usd, paid_usd) VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET payable_usd = excluded.payable_usd, paid_usd = excluded.paid_usd`,
    );
    const addresses = new Set([...ledger.owed.keys(), ...ledger.collected.keys()]);
    const payees = new Set([...ledger.payableTo.keys(), ...ledger.paidTo.keys()]);
    const tx = this.db.transaction(() => {
      for (const a of addresses) {
        stmt.run(a, ledger.owed.get(a) ?? 0, ledger.collected.get(a) ?? 0);
      }
      for (const p of payees) {
        payeeStmt.run(p, ledger.payableTo.get(p) ?? 0, ledger.paidTo.get(p) ?? 0);
      }
    });
    tx();
  }

  // --- listing applications ------------------------------------------------

  /**
   * Record a trader asking to be listed.
   *
   * Upserts on address rather than inserting, because the common second
   * submission is the same person correcting a typo. Two rows for one trader
   * would mean two people chasing the same lead. The original `created_at` and
   * any status already set by hand survive the overwrite -- re-applying must
   * not quietly reset a lead that has already had a call.
   */
  upsertApplication(app: TraderApplication): TraderApplication {
    const existing = this.applicationByAddress(app.address);
    const row: TraderApplication = existing
      ? { ...app, id: existing.id, createdAtMs: existing.createdAtMs, status: existing.status,
          bookedAtMs: existing.bookedAtMs, note: existing.note }
      : app;

    this.db
      .query(
        `INSERT INTO applications
           (id, created_at, status, handle, address, chain, email, telegram, twitter,
            book_usd, strategy, elsewhere, booked_at, note)
         VALUES ($id, $createdAt, $status, $handle, $address, $chain, $email, $telegram, $twitter,
                 $bookUsd, $strategy, $elsewhere, $bookedAt, $note)
         ON CONFLICT(address) DO UPDATE SET
           handle = $handle, chain = $chain, email = $email, telegram = $telegram,
           twitter = $twitter, book_usd = $bookUsd, strategy = $strategy, elsewhere = $elsewhere`,
      )
      .run({
        $id: row.id,
        $createdAt: row.createdAtMs,
        $status: row.status,
        $handle: row.handle,
        $address: row.address,
        $chain: row.chain,
        $email: row.email,
        $telegram: row.telegram,
        $twitter: row.twitter,
        $bookUsd: row.bookUsd,
        $strategy: row.strategy,
        $elsewhere: JSON.stringify(row.elsewhere),
        $bookedAt: row.bookedAtMs,
        $note: row.note,
      });

    return row;
  }

  applicationByAddress(address: string): TraderApplication | null {
    const row = this.db
      .query(`SELECT * FROM applications WHERE address = ?`)
      .get(address) as ApplicationRow | null;
    return row ? hydrateApplication(row) : null;
  }

  listApplications(limit = 200): TraderApplication[] {
    const rows = this.db
      .query(`SELECT * FROM applications ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as ApplicationRow[];
    return rows.map(hydrateApplication);
  }

  /** Applications recorded since a moment, for the submission rate limit. */
  applicationsSince(sinceMs: number): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM applications WHERE created_at >= ?`)
      .get(sinceMs) as { n: number };
    return row.n;
  }

  setApplicationStatus(id: string, status: ApplicationStatus, note?: string | null): void {
    this.db
      .query(
        `UPDATE applications
            SET status = ?,
                note = COALESCE(?, note),
                booked_at = CASE WHEN ? = 'booked' AND booked_at IS NULL THEN ? ELSE booked_at END
          WHERE id = ?`,
      )
      .run(status, note ?? null, status, Date.now(), id);
  }
}

interface ApplicationRow {
  id: string;
  created_at: number;
  status: string;
  handle: string;
  address: string;
  chain: string;
  email: string | null;
  telegram: string | null;
  twitter: string | null;
  book_usd: number | null;
  strategy: string;
  elsewhere: string;
  booked_at: number | null;
  note: string | null;
}

function hydrateApplication(row: ApplicationRow): TraderApplication {
  let elsewhere: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.elsewhere);
    if (Array.isArray(parsed)) elsewhere = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // A malformed extras list is not worth losing the lead over.
  }
  return {
    id: row.id,
    createdAtMs: row.created_at,
    status: row.status as ApplicationStatus,
    handle: row.handle,
    address: row.address,
    chain: row.chain,
    email: row.email,
    telegram: row.telegram,
    twitter: row.twitter,
    bookUsd: row.book_usd,
    strategy: row.strategy,
    elsewhere,
    bookedAtMs: row.booked_at,
    note: row.note,
  };
}

interface SubscriberRow {
  address: string;
  user_id: string;
  wallet_id: string;
  leader: string;
  status: string;
  policy_json: string;
  memory_json: string;
  cursor: string | null;
  utc_day: string | null;
  note: string | null;
  subscribed_at: number;
}

interface FeeRow {
  address: string;
  owed_usd: number;
  collected_usd: number;
}

interface PayeeRow {
  address: string;
  payable_usd: number;
  paid_usd: number;
}

function serialiseMemory(m: FollowMemory): string {
  return JSON.stringify({
    deployedTodayUsd: m.deployedTodayUsd,
    lastExitAtMs: [...m.lastExitAtMs.entries()],
    openedAtMs: [...m.openedAtMs.entries()],
  });
}

function deserialiseMemory(json: string): FollowMemory {
  try {
    const raw = JSON.parse(json) as {
      deployedTodayUsd?: number;
      lastExitAtMs?: [string, number][];
      openedAtMs?: [string, number][];
    };
    return {
      deployedTodayUsd: raw.deployedTodayUsd ?? 0,
      lastExitAtMs: new Map(raw.lastExitAtMs ?? []),
      openedAtMs: new Map(raw.openedAtMs ?? []),
    };
  } catch {
    // Unreadable memory costs a cooldown and a day's deploy budget, not money.
    // Starting fresh beats refusing to serve the subscriber at all.
    return emptyMemory();
  }
}

/**
 * Rebuild a policy through its validator rather than trusting the row.
 *
 * Stored JSON is the one input here that could be stale or hand-edited, and a
 * policy is the thing standing between a subscriber and an unbounded trade.
 * Re-validating means a malformed row fails loudly at load instead of silently
 * removing a guardrail mid-cycle.
 */
function revivePolicy(json: string): VaultPolicy {
  const raw = JSON.parse(json) as VaultPolicy;
  return makePolicy(raw.name, raw.leader, raw);
}
