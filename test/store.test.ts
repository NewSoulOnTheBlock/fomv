import { describe, expect, test } from "bun:test";

import { Store } from "../src/server/store.js";
import { makePolicy } from "../src/policy.js";
import { createSubscriber, markRevoked, transition } from "../src/follow/subscriber.js";
import { accrue, createFeeLedger, feeForTrade, makeFeeTerms } from "../src/follow/fees.js";

const T0 = Date.UTC(2026, 0, 1);
const LEADER = "LEADER_ADDR";

const store = () => new Store({ path: ":memory:" });

const sub = (address = "ADDR1", userId = "u1") =>
  createSubscriber({
    userId,
    walletId: `w-${address}`,
    address,
    leader: LEADER,
    policy: makePolicy("follow", LEADER),
    nowMs: T0,
  });

describe("subscriber persistence", () => {
  test("survives a round trip with its guardrails intact", () => {
    const s = store();
    const original = sub();
    original.policy.sizing.maxPositionPct = 0.05;
    transition(original, "active");
    s.upsertSubscriber(original);

    const loaded = s.getSubscriber("ADDR1");
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("active");
    expect(loaded!.leader).toBe(LEADER);
    expect(loaded!.walletId).toBe("w-ADDR1");
    // The guardrail is the thing standing between a subscriber and an
    // unbounded trade, so it must not be lost or defaulted in transit.
    expect(loaded!.policy.sizing.maxPositionPct).toBeCloseTo(0.05, 9);
    s.close();
  });

  test("a malformed policy fails loudly instead of trading without guardrails", () => {
    const s = store();
    const original = sub();
    s.upsertSubscriber(original);

    // Simulate a hand-edited or corrupted row.
    // @ts-expect-error reaching into the private handle deliberately, for this test only
    s.db.query("UPDATE subscribers SET policy_json = ? WHERE address = ?").run(
      JSON.stringify({ name: "x", leader: LEADER, sizing: { maxPositionPct: 5 } }),
      "ADDR1",
    );

    expect(() => s.getSubscriber("ADDR1")).toThrow();
    s.close();
  });

  test("memory round-trips, so cooldowns are not lost on restart", () => {
    const s = store();
    const original = sub();
    original.memory.deployedTodayUsd = 250;
    original.memory.lastExitAtMs.set("solana:BONK", T0);
    original.memory.openedAtMs.set("solana:WIF", T0 + 5);
    s.upsertSubscriber(original);

    const loaded = s.getSubscriber("ADDR1")!;
    expect(loaded.memory.deployedTodayUsd).toBeCloseTo(250, 9);
    expect(loaded.memory.lastExitAtMs.get("solana:BONK")).toBe(T0);
    expect(loaded.memory.openedAtMs.get("solana:WIF")).toBe(T0 + 5);
    s.close();
  });

  test("only active subscribers are grouped for mirroring", () => {
    const s = store();
    const a = sub("A", "u1");
    const b = sub("B", "u2");
    const c = sub("C", "u3");
    transition(a, "active");
    transition(b, "active");
    transition(b, "paused");
    markRevoked(c);
    for (const x of [a, b, c]) s.upsertSubscriber(x);

    const grouped = s.activeByLeader();
    expect(grouped.get(LEADER)?.map((x) => x.address)).toEqual(["A"]);
    expect(s.allSubscribers().length).toBe(3);
    s.close();
  });
});

describe("processed ids", () => {
  test("a trade recorded once is not offered twice, even across a reload", () => {
    const s = store();
    const original = sub();
    transition(original, "active");
    s.upsertSubscriber(original);
    s.markProcessed("ADDR1", ["solana:sig1", "solana:sig2"], T0);

    const loaded = s.getSubscriber("ADDR1")!;
    expect(loaded.processed.has("solana:sig1")).toBe(true);
    expect(loaded.processed.has("solana:sig2")).toBe(true);
    expect(loaded.processed.size).toBe(2);
    s.close();
  });

  test("recording the same id twice is harmless", () => {
    const s = store();
    s.upsertSubscriber(sub());
    s.markProcessed("ADDR1", ["solana:sig1"], T0);
    expect(() => s.markProcessed("ADDR1", ["solana:sig1"], T0 + 1)).not.toThrow();
    expect(s.getSubscriber("ADDR1")!.processed.size).toBe(1);
    s.close();
  });

  test("two subscribers keep separate sets", () => {
    // Sharing them would starve every follower but the first to act.
    const s = store();
    s.upsertSubscriber(sub("A", "u1"));
    s.upsertSubscriber(sub("B", "u2"));
    s.markProcessed("A", ["solana:sig1"], T0);

    expect(s.getSubscriber("A")!.processed.has("solana:sig1")).toBe(true);
    expect(s.getSubscriber("B")!.processed.has("solana:sig1")).toBe(false);
    s.close();
  });

  test("pruning drops only ids older than the retention window", () => {
    const s = new Store({ path: ":memory:", processedRetentionDays: 7 });
    s.upsertSubscriber(sub());
    const now = T0 + 30 * 86_400_000;
    s.markProcessed("ADDR1", ["old"], now - 10 * 86_400_000);
    s.markProcessed("ADDR1", ["recent"], now - 1 * 86_400_000);

    expect(s.pruneProcessed(now)).toBe(1);
    const loaded = s.getSubscriber("ADDR1")!;
    expect(loaded.processed.has("old")).toBe(false);
    expect(loaded.processed.has("recent")).toBe(true);
    s.close();
  });
});

describe("fee ledger persistence", () => {
  test("what is owed survives a restart", () => {
    const s = store();
    const ledger = createFeeLedger();
    const terms = makeFeeTerms("TREASURY");
    const payees = { treasury: "TREASURY", leaderPayout: "LEADERPAY" };
    accrue(ledger, "A", feeForTrade(1_000, terms), payees);
    accrue(ledger, "B", feeForTrade(4_000, terms), payees);
    s.saveFeeLedger(ledger);

    const reloaded = s.loadFeeLedger();
    expect(reloaded.owed.get("A")).toBeCloseTo(10, 9);
    expect(reloaded.owed.get("B")).toBeCloseTo(40, 9);
    // The payout side must survive too, or a restart forgets what the leader
    // is owed while still remembering what the subscriber paid.
    expect(reloaded.payableTo.get("TREASURY")).toBeCloseTo(25, 9);
    expect(reloaded.payableTo.get("LEADERPAY")).toBeCloseTo(25, 9);
    s.close();
  });

  test("saving again overwrites rather than doubling", () => {
    const s = store();
    const ledger = createFeeLedger();
    accrue(ledger, "A", feeForTrade(1_000, makeFeeTerms("T")), {
      treasury: "T",
      leaderPayout: "L",
    });
    s.saveFeeLedger(ledger);
    s.saveFeeLedger(ledger);
    expect(s.loadFeeLedger().owed.get("A")).toBeCloseTo(10, 9);
    expect(s.loadFeeLedger().payableTo.get("L")).toBeCloseTo(5, 9);
    s.close();
  });
});
