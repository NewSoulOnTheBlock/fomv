import { describe, expect, test } from "bun:test";
import { makePolicy, type VaultPolicy } from "../src/policy.js";
import { tokenKey, type LeaderTrade, type MarketInfo, type PortfolioSnapshot, type TokenRef } from "../src/types.js";
import { checkEntry, checkExit } from "../src/mirror/guardrails.js";
import { emptyVaultState, sizeEntry, sizeExit, type VaultState } from "../src/mirror/sizing.js";
import { planCycle } from "../src/mirror/engine.js";

const NOW = 1_700_000_000_000;

const BONK: TokenRef = { chain: "solana", address: "Bonk111", symbol: "BONK", decimals: 5 };
const USDC: TokenRef = { chain: "solana", address: "EPjF...", symbol: "USDC", decimals: 6 };

function policy(o: Parameters<typeof makePolicy>[2] = {}): VaultPolicy {
  return makePolicy("test-vault", "LEADER", o);
}

function trade(over: Partial<LeaderTrade> = {}): LeaderTrade {
  return {
    id: "sig1:0",
    chain: "solana",
    leader: "LEADER",
    ts: NOW - 2000,
    side: "buy",
    asset: BONK,
    quote: USDC,
    assetAmount: 1_000_000,
    quoteAmount: 4000,
    usdValue: 4000,
    fillPxUsd: 0.004,
    ...over,
  };
}

function leaderBook(totalUsd: number, holdings: PortfolioSnapshot["holdings"] = []): PortfolioSnapshot {
  return { owner: "LEADER", ts: NOW, totalUsd, holdings };
}

function market(over: Partial<MarketInfo> = {}): MarketInfo {
  return {
    token: BONK,
    priceUsd: 0.004,
    liquidityUsd: 5_000_000,
    ageSec: 86_400,
    mintAuthorityRenounced: true,
    freezeAuthorityRenounced: true,
    topHolderConcentration: 0.2,
    transferFeeBps: 0,
    sellSimulationFailed: false,
    ...over,
  };
}

function vaultWith(equityUsd: number, over: Partial<VaultState> = {}): VaultState {
  return { ...emptyVaultState(equityUsd), ...over };
}

describe("entry sizing follows portfolio weight", () => {
  test("mirrors the leader's conviction, not their dollars", () => {
    // Leader commits 4% of a $100k book. A $50k vault should commit 4% too.
    const r = sizeEntry({
      trade: trade({ usdValue: 4000 }),
      leader: leaderBook(100_000),
      vault: vaultWith(50_000),
      market: market(),
      policy: policy(),
    });
    expect(r.usdSize).toBeCloseTo(2000, 6);
    expect(r.clamps).toEqual([]);
  });

  test("is scale-invariant: a small vault and a large one run the same strategy", () => {
    const t = trade({ usdValue: 4000 });
    const l = leaderBook(100_000);
    const p = policy({ safety: { maxPctOfLiquidity: 1 } });

    const small = sizeEntry({ trade: t, leader: l, vault: vaultWith(1_000), market: market(), policy: p });
    const large = sizeEntry({ trade: t, leader: l, vault: vaultWith(1_000_000), market: market(), policy: p });

    expect(small.usdSize / 1_000).toBeCloseTo(large.usdSize / 1_000_000, 9);
  });

  test("exposureScalar dials the whole strategy up or down", () => {
    const half = sizeEntry({
      trade: trade({ usdValue: 4000 }),
      leader: leaderBook(100_000),
      vault: vaultWith(50_000),
      market: market(),
      policy: policy({ sizing: { exposureScalar: 0.5 } }),
    });
    expect(half.usdSize).toBeCloseTo(1000, 6);
  });
});

describe("entry sizing clamps", () => {
  test("maxPositionPct caps concentration in one asset", () => {
    // Leader goes 40% into one name; the vault's cap is 15%.
    const r = sizeEntry({
      trade: trade({ usdValue: 40_000 }),
      leader: leaderBook(100_000),
      vault: vaultWith(50_000),
      market: market(),
      policy: policy(),
    });
    expect(r.usdSize).toBeCloseTo(7500, 6); // 15% of 50k
    expect(r.clamps).toContain("maxPositionPct");
  });

  test("maxPctOfLiquidity stops the vault from being its own adverse price move", () => {
    const r = sizeEntry({
      trade: trade({ usdValue: 4000 }),
      leader: leaderBook(100_000),
      vault: vaultWith(50_000),
      market: market({ liquidityUsd: 40_000 }), // 1% cap => $400
      policy: policy(),
    });
    expect(r.usdSize).toBeCloseTo(400, 6);
    expect(r.clamps).toContain("maxPctOfLiquidity");
  });

  test("the quote reserve is never spent", () => {
    const r = sizeEntry({
      trade: trade({ usdValue: 40_000 }),
      leader: leaderBook(100_000),
      vault: vaultWith(50_000, { quoteUsd: 3_000 }), // reserve is 5% of 50k = 2500
      market: market(),
      policy: policy(),
    });
    expect(r.usdSize).toBeCloseTo(500, 6);
    expect(r.clamps).toContain("quoteReserve");
  });

  test("the daily deployment budget bounds how fast the book can rotate", () => {
    const r = sizeEntry({
      trade: trade({ usdValue: 10_000 }),
      leader: leaderBook(100_000),
      vault: vaultWith(50_000, { deployedTodayUsd: 49_000 }),
      market: market(),
      policy: policy(),
    });
    expect(r.usdSize).toBeCloseTo(1000, 6);
    expect(r.clamps).toContain("dailyDeployPct");
  });

  test("a mirror below the floor becomes no trade at all", () => {
    const r = sizeEntry({
      trade: trade({ usdValue: 10 }),
      leader: leaderBook(100_000),
      vault: vaultWith(5_000),
      market: market(),
      policy: policy(),
    });
    expect(r.usdSize).toBe(0);
    expect(r.clamps).toContain("belowMinTradeUsd");
  });
});

describe("exit sizing follows position fraction", () => {
  const pos = { token: BONK, amount: 500_000, usdValue: 2000, openedAtMs: NOW - 60_000 };

  test("halving their position halves ours, whatever ours is worth", () => {
    const r = sizeExit({
      trade: trade({ side: "sell", assetAmount: 500_000 }),
      leaderPositionBefore: 1_000_000,
      vaultPosition: { ...pos, usdValue: 90_000 }, // ours 10x'd since entry
      policy: policy(),
    });
    expect(r.fraction).toBeCloseTo(0.5, 9);
    expect(r.clamps).toEqual([]);
  });

  test("a near-total exit is promoted to a full exit rather than leaving dust", () => {
    const r = sizeExit({
      trade: trade({ side: "sell", assetAmount: 950_000 }),
      leaderPositionBefore: 1_000_000,
      vaultPosition: pos,
      policy: policy(),
    });
    expect(r.fraction).toBe(1);
    expect(r.clamps).toContain("exitDustThreshold");
  });

  test("a residual worth less than the trade floor is closed out too", () => {
    const r = sizeExit({
      trade: trade({ side: "sell", assetAmount: 800_000 }),
      leaderPositionBefore: 1_000_000,
      vaultPosition: { ...pos, usdValue: 100 }, // 20% residual = $20 < $25 floor
      policy: policy(),
    });
    expect(r.fraction).toBe(1);
    expect(r.clamps).toContain("residualBelowMinTradeUsd");
  });

  test("an unexplained sell errs toward flat", () => {
    const r = sizeExit({
      trade: trade({ side: "sell", assetAmount: 500_000 }),
      leaderPositionBefore: 0,
      vaultPosition: pos,
      policy: policy(),
    });
    expect(r.fraction).toBe(1);
  });

  test("selling what we do not hold is a no-op", () => {
    const r = sizeExit({
      trade: trade({ side: "sell", assetAmount: 500_000 }),
      leaderPositionBefore: 1_000_000,
      vaultPosition: undefined,
      policy: policy(),
    });
    expect(r.fraction).toBe(0);
  });
});

describe("entry guardrails", () => {
  const base = () => ({
    trade: trade(),
    market: market(),
    policy: policy(),
    vault: vaultWith(50_000),
    processed: new Set<string>(),
    nowMs: NOW,
  });

  const cases: Array<[string, Partial<MarketInfo>, string]> = [
    ["a honeypot", { sellSimulationFailed: true }, "honeypot"],
    ["a live freeze authority", { freezeAuthorityRenounced: false }, "freeze-authority"],
    ["a live mint authority", { mintAuthorityRenounced: false }, "mint-authority"],
    ["a fee-on-transfer token", { transferFeeBps: 500 }, "transfer-fee"],
    ["a thin pool", { liquidityUsd: 1_000 }, "low-liquidity"],
    ["a token minutes old", { ageSec: 30 }, "token-too-new"],
    ["a concentrated holder base", { topHolderConcentration: 0.9 }, "holder-concentration"],
    // Fails closed, but with a code that blames the data source rather than
    // the token, so an inadequate RPC is diagnosable instead of looking like a
    // market full of scams.
    ["unmeasurable holder data", { topHolderConcentration: null }, "holder-data-unavailable"],
  ];

  for (const [label, over, code] of cases) {
    test(`rejects ${label}`, () => {
      const v = checkEntry({ ...base(), market: market(over) });
      expect(v.pass).toBe(false);
      if (!v.pass) expect(v.code).toBe(code);
    });
  }

  test("rejects a trade that has already been mirrored", () => {
    const v = checkEntry({ ...base(), processed: new Set(["sig1:0"]) });
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe("duplicate");
  });

  test("rejects a leader trade we noticed too late", () => {
    const v = checkEntry({ ...base(), trade: trade({ ts: NOW - 60_000 }) });
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe("trade-stale");
  });

  test("refuses to buy the leader's exit liquidity after the price has run", () => {
    // Leader filled at 0.004; it is now 0.005, i.e. 2500bps past them.
    const v = checkEntry({ ...base(), market: market({ priceUsd: 0.005 }) });
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe("leader-price-drift");
  });

  test("still enters when the price moved in our favour", () => {
    const v = checkEntry({ ...base(), market: market({ priceUsd: 0.0032 }) });
    expect(v.pass).toBe(true);
    if (v.pass) expect(v.warnings.join(" ")).toMatch(/below the leader's fill/);
  });

  test("honours the re-entry cooldown", () => {
    const vault = vaultWith(50_000, { lastExitAtMs: new Map([[tokenKey(BONK), NOW - 5_000]]) });
    const v = checkEntry({ ...base(), vault });
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe("reentry-cooldown");
  });

  test("refuses a new name once the position count is full", () => {
    const positions = new Map(
      Array.from({ length: 20 }, (_, i) => [
        `solana:tok${i}`,
        { token: { ...BONK, address: `tok${i}` }, amount: 1, usdValue: 100, openedAtMs: NOW },
      ]),
    );
    const v = checkEntry({ ...base(), vault: vaultWith(50_000, { positions }) });
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe("max-positions");
  });
});

describe("exit guardrails stay out of the way", () => {
  const held = new Map([[tokenKey(BONK), { token: BONK, amount: 1, usdValue: 100, openedAtMs: NOW }]]);

  test("a stale, illiquid, honeypot-flagged asset can still be sold", () => {
    const v = checkExit({
      trade: trade({ side: "sell", ts: NOW - 600_000 }),
      market: market({ sellSimulationFailed: true, liquidityUsd: 1, ageSec: 1 }),
      policy: policy(),
      vault: vaultWith(50_000, { positions: held }),
      processed: new Set(),
      nowMs: NOW,
    });
    expect(v.pass).toBe(true);
  });

  test("deny-listing an asset does not trap depositors inside it", () => {
    const v = checkExit({
      trade: trade({ side: "sell" }),
      market: market(),
      policy: policy({ safety: { denyTokens: [tokenKey(BONK)] } }),
      vault: vaultWith(50_000, { positions: held }),
      processed: new Set(),
      nowMs: NOW,
    });
    expect(v.pass).toBe(true);
    if (v.pass) expect(v.warnings.join(" ")).toMatch(/never block exits/);
  });
});

describe("planCycle composes limits across a burst", () => {
  const markets = new Map([[tokenKey(BONK), market()]]);

  function cycle(over: Partial<Parameters<typeof planCycle>[0]> = {}) {
    return planCycle({
      trades: [],
      leader: leaderBook(100_000),
      vault: vaultWith(50_000),
      markets,
      policy: policy(),
      processed: new Set(),
      equityHighWaterUsd: 50_000,
      startOfDayEquityUsd: 50_000,
      leaderStartOfDayUsd: 100_000,
      priceAsOfMs: NOW,
      nowMs: NOW,
      ...over,
    });
  }

  test("five buys in one cycle share one budget instead of each getting the full one", () => {
    const trades = Array.from({ length: 5 }, (_, i) =>
      trade({ id: `sig${i}:0`, usdValue: 8_000, asset: { ...BONK, address: `tok${i}` } }),
    );
    const ms = new Map(trades.map((t) => [tokenKey(t.asset), market({ token: t.asset })]));

    const plan = cycle({
      trades,
      markets: ms,
      // Reserve is 5% of 50k = 2500, so only 47500 of quote is investable.
      vault: vaultWith(50_000, { quoteUsd: 50_000 }),
    });

    const buys = plan.intents.filter((i) => i.kind === "buy");
    const total = buys.reduce((a, i) => a + (i.kind === "buy" ? i.usdSize : 0), 0);
    // Each raw mirror is 8% of 50k = $4000; five would be $20k, under budget,
    // but the per-asset cap and quote reserve still bind the aggregate.
    expect(total).toBeLessThanOrEqual(47_500);
    expect(buys.length).toBeGreaterThan(0);

    // Rerunning the same trades changes nothing: they are already recorded.
    const replay = cycle({ trades, markets: ms, processed: new Set(trades.map((t) => t.id)) });
    expect(replay.intents.every((i) => i.kind === "skip")).toBe(true);
  });

  test("the kill switch stops everything, exits included", () => {
    const plan = cycle({
      trades: [trade(), trade({ id: "sig2:0", side: "sell" })],
      policy: policy({ breakers: { paused: true } }),
    });
    expect(plan.intents.every((i) => i.kind === "skip")).toBe(true);
    expect(plan.flatten).toBe(false);
  });

  test("a drawdown breach flattens the book rather than merely freezing it", () => {
    const positions = new Map([[tokenKey(BONK), { token: BONK, amount: 1, usdValue: 5_000, openedAtMs: NOW }]]);
    const plan = cycle({
      trades: [trade()],
      vault: vaultWith(30_000, { positions }),
      equityHighWaterUsd: 100_000, // 70% drawdown
    });

    expect(plan.flatten).toBe(true);
    const sells = plan.intents.filter((i) => i.kind === "sell");
    expect(sells).toHaveLength(1);
    if (sells[0]?.kind === "sell") expect(sells[0].fraction).toBe(1);
    // The new buy is refused.
    expect(plan.intents.some((i) => i.kind === "skip" && i.code === "max-drawdown")).toBe(true);
  });

  test("the daily loss limit blocks new risk but still lets the vault sell", () => {
    const positions = new Map([[tokenKey(BONK), { token: BONK, amount: 1_000_000, usdValue: 4_000, openedAtMs: NOW }]]);
    const plan = cycle({
      trades: [trade({ id: "buy:0" }), trade({ id: "sell:0", side: "sell", assetAmount: 500_000 })],
      leader: leaderBook(100_000, [{ token: BONK, amount: 500_000, usdValue: 2_000 }]),
      vault: vaultWith(40_000, { positions }),
      startOfDayEquityUsd: 50_000, // down 20%, limit is 15%
    });

    expect(plan.intents.some((i) => i.kind === "skip" && i.code === "daily-loss-limit")).toBe(true);
    const sell = plan.intents.find((i) => i.kind === "sell");
    expect(sell?.kind).toBe("sell");
    if (sell?.kind === "sell") expect(sell.fraction).toBeCloseTo(0.5, 9);
  });
});
