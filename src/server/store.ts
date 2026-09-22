import { Database } from "bun:sqlite";

import { makePolicy, type VaultPolicy } from "../policy.js";
import { createFeeLedger, type FeeLedger } from "../follow/fees.js";
import type { Subscriber, SubscriberStatus } from "../follow/subscriber.js";
import { emptyMemory, type FollowMemory } from "../follow/wallet-state.js";

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

      CREATE INDEX IF NOT EXISTS subscribers_leader_status ON subscribers (leader, status);
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
    return ledger;
  }

  saveFeeLedger(ledger: FeeLedger): void {
    const stmt = this.db.query(
      `INSERT INTO fees (address, owed_usd, collected_usd) VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET owed_usd = excluded.owed_usd, collected_usd = excluded.collected_usd`,
    );
    const addresses = new Set([...ledger.owed.keys(), ...ledger.collected.keys()]);
    const tx = this.db.transaction(() => {
      for (const a of addresses) {
        stmt.run(a, ledger.owed.get(a) ?? 0, ledger.collected.get(a) ?? 0);
      }
    });
    tx();
  }
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
