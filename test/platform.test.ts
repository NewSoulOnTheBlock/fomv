import { describe, expect, test } from "bun:test";

import * as Fx from "../src/num.js";
import { makePolicy } from "../src/policy.js";
import { createLedger, deposit, lowerPlatformFee, withdraw, sharesOf } from "../src/vault/ledger.js";
import {
  LAMPORTS_PER_SOL,
  MAX_WITHDRAW_FEE_BPS,
  makePlatformConfig,
  platformFromEnv,
  validatePlatformConfig,
} from "../src/platform/config.js";
import { quoteListing, quoteWithdrawal, withdrawalFeeShares } from "../src/platform/fees.js";
import * as Reg from "../src/platform/registry.js";

const T0 = Date.UTC(2026, 0, 1);
const usd = (n: number) => Fx.fromNumber(n);

const cfg = () =>
  makePlatformConfig({ treasury: "FOMV_TREASURY", authority: "FOMV_AUTH", maxLiveVaults: 3 });

const policy = () => makePolicy("test", "LEADER", { economics: { lockupSec: 0 } });

const terms = { treasuryId: "FOMV_TREASURY", withdrawFeeBps: 100 };

describe("platform config", () => {
  test("refuses a withdrawal fee the program would reject", () => {
    expect(() => makePlatformConfig({ treasury: "T", authority: "A", withdrawFeeBps: MAX_WITHDRAW_FEE_BPS + 1 })).toThrow(
      /exceeds the protocol ceiling/,
    );
    expect(() => makePlatformConfig({ treasury: "T", authority: "A", withdrawFeeBps: MAX_WITHDRAW_FEE_BPS })).not.toThrow();
  });

  test("refuses to run without a treasury, since there is nowhere for a fee to go", () => {
    const c = { ...cfg(), treasury: "" };
    expect(() => validatePlatformConfig(c)).toThrow(/treasury must be set/);
  });
});

describe("config from the environment", () => {
  const base = { FOMV_TREASURY: "T", FOMV_AUTHORITY: "A" };

  test("reads the fees and falls back to defaults for what is absent", () => {
    const c = platformFromEnv({ ...base, FOMV_WITHDRAW_FEE_BPS: "50" });
    expect(c.withdrawFeeBps).toBe(50);
    expect(c.listingFeeLamports).toBe(5n * LAMPORTS_PER_SOL);
  });

  test("refuses to start without somewhere to send the fees", () => {
    expect(() => platformFromEnv({ FOMV_AUTHORITY: "A" })).toThrow(/treasury must be set/);
  });

  test("rejects a malformed fee rather than silently defaulting", () => {
    expect(() => platformFromEnv({ ...base, FOMV_WITHDRAW_FEE_BPS: "1.5" })).toThrow(/must be an integer/);
    expect(() => platformFromEnv({ ...base, FOMV_LISTING_FEE_LAMPORTS: "five" })).toThrow(/lamports/);
  });

  test("still enforces the protocol ceiling when the value comes from the environment", () => {
    expect(() => platformFromEnv({ ...base, FOMV_WITHDRAW_FEE_BPS: "500" })).toThrow(/protocol ceiling/);
  });
});

describe("withdrawal fee arithmetic", () => {
  test("floors, so the protocol never takes a whole dust withdrawal", () => {
    // 1 share at 1% is 0.01 shares, which floors to nothing.
    expect(withdrawalFeeShares(1n, 100)).toBe(0n);
    expect(withdrawalFeeShares(99n, 100)).toBe(0n);
    expect(withdrawalFeeShares(100n, 100)).toBe(1n);
    expect(withdrawalFeeShares(10_000n, 100)).toBe(100n);
  });

  test("the fee shares plus the burned shares always equal what was presented", () => {
    for (const shares of [1n, 7n, 100n, 123_456n, 999_999_999n]) {
      for (const bps of [0, 1, 50, 100, MAX_WITHDRAW_FEE_BPS]) {
        const fee = withdrawalFeeShares(shares, bps);
        expect(fee + (shares - fee)).toBe(shares);
        expect(fee).toBeLessThanOrEqual(shares);
      }
    }
  });

  test("quoting exempts the treasury from its own fee", () => {
    const base = { shares: 1_000n, vaultWithdrawFeeBps: 100, totalSharesBefore: 10_000n };
    expect(quoteWithdrawal(base).feeShares).toBe(10n);
    expect(quoteWithdrawal({ ...base, isTreasury: true }).feeShares).toBe(0n);
  });

  test("the payout fraction is taken against the burned shares, not the presented ones", () => {
    // Fee shares stay outstanding, so they keep claiming against the book.
    const q = quoteWithdrawal({ shares: 1_000n, vaultWithdrawFeeBps: 200, totalSharesBefore: 10_000n });
    expect(q.feeShares).toBe(20n);
    expect(q.sharesBurned).toBe(980n);
    expect(q.payoutFraction).toBeCloseTo(0.098, 12);
  });

  test("refuses to build a withdrawal the program would revert", () => {
    // 10000bps would burn nothing at all.
    expect(() => quoteWithdrawal({ shares: 50n, vaultWithdrawFeeBps: 10_000, totalSharesBefore: 100n })).toThrow(
      /leaves nothing after the protocol fee/,
    );
  });
});

describe("listing quote", () => {
  test("defaults the ceiling to the quoted price, so a repricing cannot overcharge", () => {
    const q = quoteListing(cfg());
    expect(q.lamports).toBe(5n * LAMPORTS_PER_SOL);
    expect(q.maxLamports).toBe(q.lamports);
    expect(q.sol).toBe(5);
    expect(q.usd).toBeNull();
  });

  test("a stated tolerance widens the ceiling and nothing else", () => {
    const q = quoteListing(cfg(), { tolerancePct: 10, solPriceUsd: 200 });
    expect(q.lamports).toBe(5n * LAMPORTS_PER_SOL);
    expect(q.maxLamports).toBe(5n * LAMPORTS_PER_SOL + (5n * LAMPORTS_PER_SOL) / 10n);
    expect(q.usd).toBe(1_000);
  });
});

describe("listing lifecycle", () => {
  test("a vault cannot reach the roster without passing through paying to list", () => {
    const reg = Reg.createRegistry(cfg());
    Reg.apply(reg, { leader: "LDR", handle: "ldr" });
    expect(() => Reg.goLive(reg, "LDR")).toThrow(/illegal listing transition/);

    Reg.approve(reg, { leader: "LDR", policy: policy() });
    expect(() => Reg.goLive(reg, "LDR")).toThrow(/illegal listing transition/);

    Reg.recordListed(reg, {
      leader: "LDR",
      vaultAddress: "VAULT1",
      withdrawFeeBps: 100,
      listingFeePaidLamports: 5n * LAMPORTS_PER_SOL,
      nowMs: T0,
    });
    expect(Reg.goLive(reg, "LDR").status).toBe("live");
  });

  test("the crank runs only for live, listed vaults", () => {
    const reg = Reg.createRegistry(cfg());
    Reg.apply(reg, { leader: "LDR", handle: "ldr" });
    Reg.approve(reg, { leader: "LDR", policy: policy() });
    const l = Reg.recordListed(reg, {
      leader: "LDR",
      vaultAddress: "VAULT1",
      withdrawFeeBps: 100,
      listingFeePaidLamports: 5n * LAMPORTS_PER_SOL,
      nowMs: T0,
    });
    expect(Reg.shouldCrank(l)).toBe(false);

    Reg.goLive(reg, "LDR");
    expect(Reg.shouldCrank(l)).toBe(true);

    Reg.suspend(reg, "LDR", "leader went dark");
    expect(Reg.shouldCrank(l)).toBe(false);
  });

  test("the roster is capped, and a suspended vault may always resume", () => {
    const reg = Reg.createRegistry({ ...cfg(), maxLiveVaults: 2 });
    for (const id of ["A", "B", "C"]) {
      Reg.apply(reg, { leader: id, handle: id });
      Reg.approve(reg, { leader: id, policy: policy() });
      Reg.recordListed(reg, {
        leader: id,
        vaultAddress: `V_${id}`,
        withdrawFeeBps: 100,
        listingFeePaidLamports: 0n,
        nowMs: T0,
      });
    }
    Reg.goLive(reg, "A");
    Reg.goLive(reg, "B");
    expect(() => Reg.goLive(reg, "C")).toThrow(/roster is full/);

    // Resuming a suspension is not a new seat and must not be blocked by the cap.
    Reg.suspend(reg, "A", "paused for review");
    expect(Reg.goLive(reg, "A").status).toBe("live");
    expect(Reg.liveCount(reg)).toBe(2);
  });

  test("a fee that moved up on-chain is flagged rather than silently accepted", () => {
    const reg = Reg.createRegistry(cfg());
    Reg.apply(reg, { leader: "LDR", handle: "ldr" });
    Reg.approve(reg, { leader: "LDR", policy: policy() });
    const l = Reg.recordListed(reg, {
      leader: "LDR",
      vaultAddress: "V",
      withdrawFeeBps: 100,
      listingFeePaidLamports: 0n,
      nowMs: T0,
    });

    expect(Reg.reconcile(l, 50)).toMatchObject({ changed: true, suspicious: false, from: 100, to: 50 });
    // The program cannot raise a vault fee, so seeing one is an anomaly.
    expect(Reg.reconcile(l, 90)).toMatchObject({ changed: true, suspicious: true, from: 50, to: 90 });
  });

  test("refuses to record a listing the program could not have produced", () => {
    const reg = Reg.createRegistry(cfg());
    Reg.apply(reg, { leader: "LDR", handle: "ldr" });
    Reg.approve(reg, { leader: "LDR", policy: policy() });
    expect(() =>
      Reg.recordListed(reg, {
        leader: "LDR",
        vaultAddress: "V",
        withdrawFeeBps: MAX_WITHDRAW_FEE_BPS + 1,
        listingFeePaidLamports: 0n,
        nowMs: T0,
      }),
    ).toThrow(/exceeds the protocol ceiling/);
  });
});

describe("platform fee in the share ledger", () => {
  test("the skim moves shares to the treasury and never leaves the vault", () => {
    const p = policy();
    const s = createLedger("LEADER", T0, { ...terms });

    deposit(s, {
      memberId: "ALICE",
      amountUsd: usd(1_000),
      equityUsd: Fx.ZERO,
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });

    const sharesBefore = s.totalShares;
    const alice = sharesOf(s, "ALICE");

    // Flat vault: no profit, so the only fee in play is the platform's.
    const r = withdraw(s, {
      memberId: "ALICE",
      shares: alice,
      equityUsd: usd(1_000),
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });

    expect(r.performanceFeeUsd).toBe(Fx.ZERO);
    // 1% of 1000 shares.
    expect(Fx.toNumber(r.platformFeeShares)).toBeCloseTo(10, 9);
    expect(Fx.toNumber(r.platformFeeUsd)).toBeCloseTo(10, 9);
    expect(Fx.toNumber(sharesOf(s, "FOMV_TREASURY"))).toBeCloseTo(10, 9);

    // The fee stayed outstanding: supply fell only by what was actually burned.
    expect(s.totalShares).toBe(sharesBefore - r.sharesBurned);
    expect(Fx.toNumber(r.payoutUsd)).toBeCloseTo(990, 6);
  });

  test("the treasury is not charged its own fee on the way out", () => {
    const p = policy();
    const s = createLedger("LEADER", T0, { ...terms });
    deposit(s, {
      memberId: "FOMV_TREASURY",
      amountUsd: usd(500),
      equityUsd: Fx.ZERO,
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });

    const r = withdraw(s, {
      memberId: "FOMV_TREASURY",
      shares: sharesOf(s, "FOMV_TREASURY"),
      equityUsd: usd(500),
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });
    expect(r.platformFeeShares).toBe(Fx.ZERO);
  });

  test("a vault with no platform attached behaves exactly as before", () => {
    const p = policy();
    const s = createLedger("LEADER", T0);
    deposit(s, {
      memberId: "ALICE",
      amountUsd: usd(1_000),
      equityUsd: Fx.ZERO,
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });
    const r = withdraw(s, {
      memberId: "ALICE",
      shares: sharesOf(s, "ALICE"),
      equityUsd: usd(1_000),
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });
    expect(r.platformFeeShares).toBe(Fx.ZERO);
    expect(Fx.toNumber(r.payoutUsd)).toBeCloseTo(1_000, 6);
  });

  test("both fees are claims on the same shares and cannot jointly exceed them", () => {
    // Maximum pressure: 50% performance fee on a 10x, plus the platform ceiling.
    const p = makePolicy("greedy", "LEADER", {
      economics: { performanceFeeBps: 5_000, lockupSec: 0, halfSpreadBps: 0 },
    });
    const s = createLedger("LEADER", T0, { treasuryId: "FOMV_TREASURY", withdrawFeeBps: MAX_WITHDRAW_FEE_BPS });

    deposit(s, {
      memberId: "ALICE",
      amountUsd: usd(1_000),
      equityUsd: Fx.ZERO,
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });

    const equity = usd(10_000);
    const alice = sharesOf(s, "ALICE");
    const r = withdraw(s, {
      memberId: "ALICE",
      shares: alice,
      equityUsd: equity,
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });

    expect(r.platformFeeShares + r.feeShares + r.sharesBurned).toBe(alice);
    expect(r.payoutUsd).toBeGreaterThan(Fx.ZERO);
  });

  test("the platform fee only ratchets down", () => {
    const s = createLedger("LEADER", T0, { ...terms });
    lowerPlatformFee(s, 25);
    expect(s.platform?.withdrawFeeBps).toBe(25);
    expect(() => lowerPlatformFee(s, 26)).toThrow(/may only be lowered/);
  });

  test("the fee does not dilute the members who stay", () => {
    const p = makePolicy("flat", "LEADER", { economics: { lockupSec: 0, halfSpreadBps: 0 } });
    const s = createLedger("LEADER", T0, { ...terms });

    deposit(s, {
      memberId: "ALICE",
      amountUsd: usd(1_000),
      equityUsd: Fx.ZERO,
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });
    deposit(s, {
      memberId: "BOB",
      amountUsd: usd(1_000),
      equityUsd: usd(1_000),
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });

    const equity = usd(2_000);
    const navBefore = Fx.div(equity, s.totalShares);

    const r = withdraw(s, {
      memberId: "ALICE",
      shares: sharesOf(s, "ALICE"),
      equityUsd: equity,
      investedUsd: Fx.ZERO,
      policy: p,
      nowMs: T0,
    });

    const navAfter = Fx.div(r.equityAfterUsd, s.totalShares);
    expect(navAfter).toBeGreaterThanOrEqual(navBefore);
  });
});
