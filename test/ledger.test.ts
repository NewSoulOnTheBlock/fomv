import { describe, expect, test } from "bun:test";
import * as Fx from "../src/num.js";
import { makePolicy } from "../src/policy.js";
import {
  accrueManagementFee,
  createLedger,
  deposit,
  levyBps,
  navPerShare,
  sharesOf,
  unlockedShares,
  withdraw,
  type LedgerState,
} from "../src/vault/ledger.js";

const usd = Fx.fromNumber;
const num = Fx.toNumber;
const T0 = 1_700_000_000_000;

function policy(overrides: Parameters<typeof makePolicy>[2] = {}) {
  return makePolicy("test", "LEADER", {
    economics: { performanceFeeBps: 1000, managementFeeBpsAnnual: 0, halfSpreadBps: 30, maxLevyBps: 100, lockupSec: 0 },
    ...overrides,
  });
}

/** Total shares must always equal the sum of every member's lots. */
function assertConserved(state: LedgerState) {
  let sum = Fx.ZERO;
  for (const m of state.members.values()) for (const l of m.lots) sum += l.shares;
  expect(Fx.toString(sum)).toBe(Fx.toString(state.totalShares));
}

describe("share issuance", () => {
  test("the first deposit gets one share per dollar", () => {
    const s = createLedger("LEADER", T0);
    const r = deposit(s, {
      memberId: "alice",
      amountUsd: usd(1000),
      equityUsd: Fx.ZERO,
      investedUsd: Fx.ZERO,
      policy: policy(),
      nowMs: T0,
    });
    expect(num(r.sharesIssued)).toBe(1000);
    expect(num(r.navPerShare)).toBe(1);
    expect(num(r.levyUsd)).toBe(0);
    assertConserved(s);
  });

  test("a later depositor buys in at the current NAV, not at par", () => {
    const p = policy();
    const s = createLedger("LEADER", T0);
    deposit(s, { memberId: "alice", amountUsd: usd(1000), equityUsd: Fx.ZERO, investedUsd: Fx.ZERO, policy: p, nowMs: T0 });

    // Vault doubles.
    const equity = usd(2000);
    const r = deposit(s, { memberId: "bob", amountUsd: usd(1000), equityUsd: equity, investedUsd: Fx.ZERO, policy: p, nowMs: T0 });

    expect(num(r.navPerShare)).toBe(2);
    expect(num(r.sharesIssued)).toBe(500);
    // Alice still owns 1000 of 1500 shares, worth 2/3 of $3000.
    expect(num(sharesOf(s, "alice"))).toBe(1000);
    expect(num(Fx.mul(sharesOf(s, "alice"), navPerShare(s, usd(3000))))).toBeCloseTo(2000, 6);
    assertConserved(s);
  });
});

describe("anti-dilution levy", () => {
  test("an idle all-quote vault charges nothing, because no trading is forced", () => {
    const p = policy();
    expect(levyBps({ equityUsd: usd(1000), investedUsd: Fx.ZERO, policy: p })).toBe(0);
  });

  test("a fully invested vault charges the full half-spread", () => {
    const p = policy();
    expect(levyBps({ equityUsd: usd(1000), investedUsd: usd(1000), policy: p })).toBe(30);
  });

  test("the levy scales with how invested the vault is, and is capped", () => {
    const p = policy();
    expect(levyBps({ equityUsd: usd(1000), investedUsd: usd(500), policy: p })).toBe(15);
    const wide = policy({ economics: { performanceFeeBps: 1000, managementFeeBpsAnnual: 0, halfSpreadBps: 900, maxLevyBps: 100, lockupSec: 0 } });
    expect(levyBps({ equityUsd: usd(1000), investedUsd: usd(1000), policy: wide })).toBe(100);
  });

  test("the levy is paid by the incoming member and lifts NAV for the existing ones", () => {
    const p = policy();
    const s = createLedger("LEADER", T0);
    deposit(s, { memberId: "alice", amountUsd: usd(1000), equityUsd: Fx.ZERO, investedUsd: Fx.ZERO, policy: p, nowMs: T0 });

    const navBefore = navPerShare(s, usd(1000));
    const r = deposit(s, {
      memberId: "bob",
      amountUsd: usd(1000),
      equityUsd: usd(1000),
      investedUsd: usd(1000), // fully invested: 30bps
      policy: p,
      nowMs: T0,
    });

    expect(num(r.levyUsd)).toBeCloseTo(3, 9);
    expect(num(r.sharesIssued)).toBeCloseTo(997, 9);

    // All $2000 is in the vault but only 1997 shares exist, so NAV per share rose.
    const navAfter = navPerShare(s, usd(2000));
    expect(num(navAfter)).toBeGreaterThan(num(navBefore));
    expect(num(Fx.mul(sharesOf(s, "alice"), navAfter))).toBeCloseTo(1001.502, 3);
    assertConserved(s);
  });
});

describe("performance fee", () => {
  test("the leader earns its cut as shares, and the books balance exactly", () => {
    const p = policy();
    const s = createLedger("LEADER", T0);
    deposit(s, { memberId: "alice", amountUsd: usd(1000), equityUsd: Fx.ZERO, investedUsd: Fx.ZERO, policy: p, nowMs: T0 });

    // Vault doubles to $2000.
    const r = withdraw(s, {
      memberId: "alice",
      shares: usd(1000),
      equityUsd: usd(2000),
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });

    expect(num(r.performanceFeeUsd)).toBe(100); // 10% of $1000 profit
    expect(num(r.feeShares)).toBe(50); // $100 at NAV 2.0
    expect(num(r.payoutUsd)).toBe(1900);

    // What stays behind is exactly the leader's fee.
    expect(num(r.equityAfterUsd)).toBe(100);
    expect(num(sharesOf(s, "LEADER"))).toBe(50);
    expect(num(Fx.mul(sharesOf(s, "LEADER"), navPerShare(s, r.equityAfterUsd)))).toBeCloseTo(100, 9);
    assertConserved(s);
  });

  test("no fee is charged below the high-water mark", () => {
    const p = policy();
    const s = createLedger("LEADER", T0);
    deposit(s, { memberId: "alice", amountUsd: usd(1000), equityUsd: Fx.ZERO, investedUsd: Fx.ZERO, policy: p, nowMs: T0 });

    const r = withdraw(s, {
      memberId: "alice",
      shares: usd(1000),
      equityUsd: usd(600),
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });

    expect(num(r.performanceFeeUsd)).toBe(0);
    expect(num(r.payoutUsd)).toBe(600);
    assertConserved(s);
  });

  test("per-lot high-water marks stop a losing top-up from sheltering an older lot's gains", () => {
    const p = policy();
    const s = createLedger("LEADER", T0);

    // Lot 1: $1000 at NAV 1.0 -> 1000 shares.
    deposit(s, { memberId: "alice", amountUsd: usd(1000), equityUsd: Fx.ZERO, investedUsd: Fx.ZERO, policy: p, nowMs: T0 });
    // Vault doubles. Lot 2: $400 at NAV 2.0 -> 200 shares.
    deposit(s, { memberId: "alice", amountUsd: usd(400), equityUsd: usd(2000), investedUsd: Fx.ZERO, policy: p, nowMs: T0 + 1 });
    expect(num(s.totalShares)).toBe(1200);

    // Vault falls back to NAV 1.5, so lot 1 is up and lot 2 is underwater.
    const r = withdraw(s, {
      memberId: "alice",
      shares: usd(1200),
      equityUsd: usd(1800),
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0 + 2,
    });

    // Lot 1: 1000 shares x $0.50 gain = $500 profit -> $50 fee.
    // Lot 2: underwater, contributes nothing.
    // A single share-weighted HWM would have blended to 1.1667 and charged only
    // $40, letting the loss on lot 2 shelter the gain on lot 1.
    expect(num(r.performanceFeeUsd)).toBe(50);
    assertConserved(s);
  });
});

describe("lockup", () => {
  test("shares inside the lockup window cannot be withdrawn", () => {
    const p = policy({ economics: { performanceFeeBps: 1000, managementFeeBpsAnnual: 0, halfSpreadBps: 30, maxLevyBps: 100, lockupSec: 3600 } });
    const s = createLedger("LEADER", T0);
    deposit(s, { memberId: "alice", amountUsd: usd(1000), equityUsd: Fx.ZERO, investedUsd: Fx.ZERO, policy: p, nowMs: T0 });

    expect(num(unlockedShares(s, "alice", p, T0 + 60_000))).toBe(0);
    expect(() =>
      withdraw({ ...s } as LedgerState, {
        memberId: "alice",
        shares: usd(1000),
        equityUsd: usd(1000),
        investedUsd: Fx.ZERO,
        policy: p,
        nowMs: T0 + 60_000,
      }),
    ).toThrow(/past lockup/);

    expect(num(unlockedShares(s, "alice", p, T0 + 3_600_000))).toBe(1000);
  });
});

describe("management fee", () => {
  test("accrues pro rata over time and dilutes holders into the leader", () => {
    const p = policy({ economics: { performanceFeeBps: 0, managementFeeBpsAnnual: 200, halfSpreadBps: 0, maxLevyBps: 0, lockupSec: 0 } });
    const s = createLedger("LEADER", T0);
    deposit(s, { memberId: "alice", amountUsd: usd(10_000), equityUsd: Fx.ZERO, investedUsd: Fx.ZERO, policy: p, nowMs: T0 });

    const oneYear = T0 + 31_536_000_000;
    const r = accrueManagementFee(s, { equityUsd: usd(10_000), policy: p, nowMs: oneYear });

    expect(num(r.feeUsd)).toBeCloseTo(200, 6); // 2% of $10k
    const nav = navPerShare(s, usd(10_000));
    expect(num(Fx.mul(sharesOf(s, "LEADER"), nav))).toBeCloseTo(200, 3);
    expect(num(Fx.mul(sharesOf(s, "alice"), nav))).toBeCloseTo(9800, 3);
    assertConserved(s);
  });
});

describe("no value leaks across many round trips", () => {
  test("NAV per share never falls from ledger operations alone", () => {
    const p = policy();
    const s = createLedger("LEADER", T0);
    let equity = Fx.ZERO;

    deposit(s, { memberId: "seed", amountUsd: usd(5000), equityUsd: equity, investedUsd: Fx.ZERO, policy: p, nowMs: T0 });
    equity = usd(5000);

    let prevNav = navPerShare(s, equity);
    for (let i = 0; i < 200; i++) {
      const id = `m${i % 7}`;
      const amount = usd(37.13 + (i % 11));
      const invested = Fx.mul(equity, Fx.fromNumber(0.8));

      const d = deposit(s, { memberId: id, amountUsd: amount, equityUsd: equity, investedUsd: invested, policy: p, nowMs: T0 + i });
      equity = d.equityAfterUsd;

      const held = sharesOf(s, id);
      if (held > Fx.ZERO && i % 3 === 0) {
        const w = withdraw(s, {
          memberId: id,
          shares: Fx.div(held, Fx.fromNumber(2)),
          equityUsd: equity,
          investedUsd: Fx.mul(equity, Fx.fromNumber(0.8)),
          policy: p,
          nowMs: T0 + i,
        });
        equity = w.equityAfterUsd;
      }

      const nav = navPerShare(s, equity);
      expect(num(nav)).toBeGreaterThanOrEqual(num(prevNav) - 1e-12);
      prevNav = nav;
      assertConserved(s);
    }

    // The levies accumulated in the pool, so NAV strictly improved.
    expect(num(prevNav)).toBeGreaterThan(1);
  });
});
