import { describe, expect, test } from "bun:test";
import { VersionedTransaction } from "@solana/web3.js";

import { makePolicy } from "../src/policy.js";
import { DelegationRevokedError } from "../src/chains/solana/signer.js";
import { PrivyDelegatedSigner } from "../src/chains/solana/privy-signer.js";
import { SOL_MINT, USDC_MINT } from "../src/chains/solana/swaps.js";
import {
  accrue,
  createFeeLedger,
  feeForTrade,
  makeFeeTerms,
  settle,
  totalOwed,
  MAX_TRADE_FEE_BPS,
} from "../src/follow/fees.js";
import {
  add,
  createRegistry,
  createSubscriber,
  activeByLeader,
  markRevoked,
  shouldMirror,
  transition,
} from "../src/follow/subscriber.js";
import { emptyMemory, rememberCycle, vaultStateFromWallet, DUST_USD } from "../src/follow/wallet-state.js";
import { tokenKey, type PortfolioSnapshot, type TokenRef } from "../src/types.js";

const T0 = Date.UTC(2026, 0, 1);
const LEADER = "LEADER_ADDR";

const tok = (address: string, symbol?: string): TokenRef => ({ chain: "solana", address, decimals: 6, symbol });

const policy = () => makePolicy("follow", LEADER);

function book(holdings: { token: TokenRef; amount: number; usdValue: number }[]): PortfolioSnapshot {
  return {
    owner: "SUB",
    ts: T0,
    totalUsd: holdings.reduce((a, h) => a + h.usdValue, 0),
    holdings,
  };
}

describe("wallet state is read, not remembered", () => {
  test("quote assets are dry powder, everything else is a position", () => {
    const b = book([
      { token: tok(USDC_MINT, "USDC"), amount: 500, usdValue: 500 },
      { token: tok(SOL_MINT, "SOL"), amount: 1, usdValue: 120 },
      { token: tok("BONK"), amount: 1_000_000, usdValue: 380 },
    ]);
    const v = vaultStateFromWallet(b, emptyMemory(), T0);

    expect(v.equityUsd).toBeCloseTo(1_000, 9);
    // Both SOL and USDC count as deployable, not as exposure.
    expect(v.quoteUsd).toBeCloseTo(620, 9);
    expect(v.positions.size).toBe(1);
    expect(v.positions.get(tokenKey(tok("BONK")))?.usdValue).toBeCloseTo(380, 9);
  });

  test("dust does not consume the position budget", () => {
    // Unsellable remnants are the normal residue of memecoin exits. Counted as
    // positions, they would make a wallet look permanently full.
    const b = book([
      { token: tok(USDC_MINT), amount: 100, usdValue: 100 },
      { token: tok("DUST1"), amount: 5, usdValue: DUST_USD / 2 },
      { token: tok("DUST2"), amount: 5, usdValue: 0 },
      { token: tok("REAL"), amount: 5, usdValue: 50 },
    ]);
    const v = vaultStateFromWallet(b, emptyMemory(), T0);
    expect(v.positions.size).toBe(1);
    expect(v.positions.has(tokenKey(tok("REAL")))).toBe(true);
  });

  test("balances follow the chain even when they move behind our back", () => {
    // The subscriber sold by hand. The next read must reflect that rather than
    // trusting what we thought we left them holding.
    const memory = emptyMemory();
    const before = vaultStateFromWallet(
      book([{ token: tok("BONK"), amount: 1_000, usdValue: 400 }]),
      memory,
      T0,
    );
    expect(before.positions.size).toBe(1);

    const after = vaultStateFromWallet(book([{ token: tok(USDC_MINT), amount: 400, usdValue: 400 }]), memory, T0);
    expect(after.positions.size).toBe(0);
    expect(after.quoteUsd).toBeCloseTo(400, 9);
  });

  test("an exit records a cooldown, and re-entry clears the open marker", () => {
    const memory = emptyMemory();
    const key = tokenKey(tok("BONK"));
    const held = vaultStateFromWallet(book([{ token: tok("BONK"), amount: 1_000, usdValue: 400 }]), memory, T0);
    rememberCycle(memory, held, held, 400, T0);
    expect(memory.openedAtMs.get(key)).toBe(T0);
    expect(memory.deployedTodayUsd).toBeCloseTo(400, 9);

    const flat = vaultStateFromWallet(book([]), memory, T0 + 1000);
    rememberCycle(memory, held, flat, 0, T0 + 1000);
    expect(memory.lastExitAtMs.get(key)).toBe(T0 + 1000);
    expect(memory.openedAtMs.has(key)).toBe(false);
  });
});

describe("subscriber lifecycle", () => {
  test("nothing is mirrored until delegation is granted", () => {
    const reg = createRegistry();
    const sub = add(
      reg,
      createSubscriber({ userId: "u1", walletId: "w1", address: "A", leader: LEADER, policy: policy(), nowMs: T0 }),
    );
    expect(sub.status).toBe("pending");
    expect(shouldMirror(sub)).toBe(false);

    transition(sub, "active");
    expect(shouldMirror(sub)).toBe(true);
  });

  test("revocation is terminal until consent is granted afresh", () => {
    const sub = createSubscriber({ userId: "u1", walletId: "w1", address: "A", leader: LEADER, policy: policy(), nowMs: T0 });
    transition(sub, "active");
    markRevoked(sub);
    expect(shouldMirror(sub)).toBe(false);

    // Re-granting must not silently resume a withdrawn permission: it re-enters
    // at pending so consent is recorded again.
    expect(() => transition(sub, "active")).toThrow(/illegal subscriber transition/);
    transition(sub, "pending");
    transition(sub, "active");
    expect(shouldMirror(sub)).toBe(true);
  });

  test("marking revoked twice is not an error", () => {
    const sub = createSubscriber({ userId: "u1", walletId: "w1", address: "A", leader: LEADER, policy: policy(), nowMs: T0 });
    transition(sub, "active");
    markRevoked(sub);
    expect(() => markRevoked(sub)).not.toThrow();
    expect(sub.status).toBe("revoked");
  });

  test("two followers of the same leader each mirror the same trade", () => {
    // The idempotency set is per subscriber. One having acted says nothing
    // about the other, and sharing it would starve everyone but the first.
    const reg = createRegistry();
    const a = add(reg, createSubscriber({ userId: "u1", walletId: "w1", address: "A", leader: LEADER, policy: policy(), nowMs: T0 }));
    const b = add(reg, createSubscriber({ userId: "u2", walletId: "w2", address: "B", leader: LEADER, policy: policy(), nowMs: T0 }));
    transition(a, "active");
    transition(b, "active");

    a.processed.add("solana:sig1");
    expect(a.processed.has("solana:sig1")).toBe(true);
    expect(b.processed.has("solana:sig1")).toBe(false);

    const byLeader = activeByLeader(reg);
    expect(byLeader.get(LEADER)?.length).toBe(2);
  });

  test("paused subscribers are skipped without being revoked", () => {
    const reg = createRegistry();
    const a = add(reg, createSubscriber({ userId: "u1", walletId: "w1", address: "A", leader: LEADER, policy: policy(), nowMs: T0 }));
    transition(a, "active");
    transition(a, "paused", "taking a break");
    expect(activeByLeader(reg).size).toBe(0);
    expect(a.status).toBe("paused");
  });
});

describe("per-trade fees", () => {
  const terms = () => makeFeeTerms("TREASURY");

  test("charges the filled notional, not the intended size", () => {
    const f = feeForTrade(1_000, terms());
    expect(f.feeUsd).toBeCloseTo(2.5, 9);
    expect(f.bps).toBe(25);
    expect(f.waived).toBeNull();
  });

  test("small trades are free rather than charged in dust", () => {
    const f = feeForTrade(10, terms());
    expect(f.feeUsd).toBe(0);
    expect(f.waived).toBe("below-minimum");
  });

  test("refuses a rate above the stated ceiling", () => {
    expect(() => makeFeeTerms("T", { tradeFeeBps: MAX_TRADE_FEE_BPS + 1 })).toThrow(/exceeds the ceiling/);
    expect(() => makeFeeTerms("", {})).toThrow(/treasury must be set/);
  });

  test("fees accrue per subscriber and settle down to zero", () => {
    const ledger = createFeeLedger();
    const t = terms();
    accrue(ledger, "A", feeForTrade(1_000, t));
    accrue(ledger, "A", feeForTrade(2_000, t));
    accrue(ledger, "B", feeForTrade(400, t));

    expect(ledger.owed.get("A")).toBeCloseTo(7.5, 9);
    expect(ledger.owed.get("B")).toBeCloseTo(1, 9);
    expect(totalOwed(ledger)).toBeCloseTo(8.5, 9);

    settle(ledger, "A", 7.5);
    expect(ledger.owed.get("A")).toBeCloseTo(0, 9);
    expect(ledger.collected.get("A")).toBeCloseTo(7.5, 9);
  });

  test("overpaying settles only what was owed", () => {
    const ledger = createFeeLedger();
    accrue(ledger, "A", feeForTrade(1_000, terms()));
    settle(ledger, "A", 100);
    expect(ledger.owed.get("A")).toBeCloseTo(0, 9);
    expect(ledger.collected.get("A")).toBeCloseTo(2.5, 9);
  });
});

describe("delegated signing", () => {
  const tx = () => ({ serialize: () => new Uint8Array([1, 2, 3]) }) as unknown as VersionedTransaction;

  const signerWith = (opts: { delegated: boolean; signImpl?: () => Promise<never> }) =>
    new PrivyDelegatedSigner({
      userId: "u1",
      walletId: "w1",
      address: "ADDR",
      users: {
        async getUserById() {
          return { linkedAccounts: [{ type: "wallet", address: "ADDR", delegated: opts.delegated }] };
        },
      },
      wallets: {
        signTransaction: opts.signImpl
          ? (opts.signImpl as never)
          : async ({ transaction }) => ({ signedTransaction: transaction }),
      },
    });

  test("signs while the delegation stands", async () => {
    const s = signerWith({ delegated: true });
    expect(await s.isActive()).toBe(true);
    await expect(s.sign(tx())).resolves.toBeDefined();
  });

  test("refuses once delegation is withdrawn", async () => {
    const s = signerWith({ delegated: false });
    expect(await s.isActive()).toBe(false);
    await expect(s.sign(tx())).rejects.toThrow(DelegationRevokedError);
  });

  test("an unreachable Privy fails closed, not open", async () => {
    // Not being able to confirm consent is not consent. Failing open would
    // mean trading for someone who may have revoked, which cannot be undone.
    const s = new PrivyDelegatedSigner({
      userId: "u1",
      walletId: "w1",
      address: "ADDR",
      users: {
        async getUserById(): Promise<never> {
          throw new Error("network down");
        },
      },
      wallets: { async signTransaction({ transaction }) { return { signedTransaction: transaction }; } },
    });
    expect(await s.isActive()).toBe(false);
    await expect(s.sign(tx())).rejects.toThrow(DelegationRevokedError);
  });

  test("a revocation discovered at signing time is reported as one", async () => {
    const s = signerWith({
      delegated: true,
      signImpl: async () => {
        throw new Error("wallet is not delegated to this app");
      },
    });
    await expect(s.sign(tx())).rejects.toThrow(DelegationRevokedError);
    // And the cached answer flips, so the next cycle does not retry.
    expect(await s.isActive()).toBe(false);
  });
});
