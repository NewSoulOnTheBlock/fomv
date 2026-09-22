import { describe, expect, test } from "bun:test";
import {
  deltasFromMeta,
  extractSwap,
  SOL_MINT,
  USDC_MINT,
  type BalanceDelta,
} from "../src/chains/solana/swaps.js";

const BONK = "Bonk111111111111111111111111111111111111111";
const WIF = "Wif11111111111111111111111111111111111111111";
const TS = 1_700_000_000_000;

const PRICES: Record<string, number> = { [SOL_MINT]: 150, [USDC_MINT]: 1, [BONK]: 0.00004, [WIF]: 2.5 };
const priceUsd = (m: string) => PRICES[m];

function run(deltas: BalanceDelta[]) {
  return extractSwap({ deltas, signature: "sig", ts: TS, leader: "LEADER", priceUsd });
}

const d = (mint: string, amount: number, decimals = 6): BalanceDelta => ({ mint, amount, decimals });

describe("swap extraction from net balance deltas", () => {
  test("reads a buy: quote out, asset in", () => {
    const r = run([d(USDC_MINT, -400), d(BONK, 10_000_000, 5)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.side).toBe("buy");
    expect(r.trade.asset.address).toBe(BONK);
    expect(r.trade.quote.symbol).toBe("USDC");
    expect(r.trade.usdValue).toBeCloseTo(400, 9);
    expect(r.trade.fillPxUsd).toBeCloseTo(0.00004, 12);
    expect(r.trade.id).toBe("solana:sig");
  });

  test("reads a sell: asset out, quote in", () => {
    const r = run([d(BONK, -10_000_000, 5), d(SOL_MINT, 3, 9)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.side).toBe("sell");
    expect(r.trade.asset.address).toBe(BONK);
    expect(r.trade.usdValue).toBeCloseTo(450, 9);
  });

  test("a multi-hop route collapses to one trade, with no phantom intermediate leg", () => {
    // USDC -> SOL -> BONK. The SOL leg nets to zero and must not surface as a
    // trade of its own; mirroring it would buy SOL and immediately re-sell it.
    const r = run([d(USDC_MINT, -400), d(SOL_MINT, 0, 9), d(BONK, 10_000_000, 5)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.side).toBe("buy");
    expect(r.trade.asset.address).toBe(BONK);
    expect(r.trade.quote.address).toBe(USDC_MINT);
  });

  test("wrap/unwrap plumbing merges into the native SOL leg", () => {
    // Wrap 1 SOL, spend the wSOL, unwrap the remainder. All one mint after merge.
    const r = run([d(SOL_MINT, -1, 9), d(SOL_MINT, 1, 9), d(SOL_MINT, -1, 9), d(BONK, 10_000_000, 5)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.side).toBe("buy");
    expect(r.trade.quoteAmount).toBeCloseTo(1, 9);
    expect(r.trade.usdValue).toBeCloseTo(150, 9);
  });

  test("refuses to guess at a batch of independent swaps", () => {
    const r = run([d(USDC_MINT, -400), d(SOL_MINT, -1, 9), d(BONK, 10_000_000, 5), d(WIF, 60, 6)]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/^multi-leg/);
  });

  test("ignores a stable-to-SOL rotation", () => {
    const r = run([d(USDC_MINT, -400), d(SOL_MINT, 2.66, 9)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("quote-rotation");
  });

  test("ignores a token-to-token swap it cannot model as buy or sell", () => {
    const r = run([d(BONK, -10_000_000, 5), d(WIF, 160, 6)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("token-to-token");
  });

  test("a fee-only transaction is not a swap", () => {
    const r = run([d(SOL_MINT, -0.000005, 9)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-a-swap");
  });

  test("a rent refund alongside a buy is plumbing, not a second leg", () => {
    // The shape that made the extractor blind to most real routes: an
    // aggregator opens a temporary token account, closes it, and refunds
    // ~0.002 SOL. At $150/SOL that is 30c -- far above the dust floor -- so it
    // used to read as a second "in" and sink an ordinary USDC -> BONK buy.
    const r = run([d(USDC_MINT, -400), d(SOL_MINT, 0.00204, 9), d(BONK, 10_000_000, 5)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.side).toBe("buy");
    expect(r.trade.quote.address).toBe(USDC_MINT);
    expect(r.trade.usdValue).toBeCloseTo(400, 9);
    // The refund must not be counted as part of what was bought.
    expect(r.trade.assetAmount).toBeCloseTo(10_000_000, 6);
  });

  test("the same refund on the way out still reads as a sell", () => {
    const r = run([d(BONK, -10_000_000, 5), d(USDC_MINT, 400), d(SOL_MINT, 0.00204, 9)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.side).toBe("sell");
    expect(r.trade.quote.address).toBe(USDC_MINT);
  });

  test("stripping plumbing never rescues a genuine batch", () => {
    // Two real buys plus a refund. Dropping the SOL leg still leaves two ins,
    // so the transaction is refused rather than half-mirrored.
    const r = run([d(USDC_MINT, -400), d(SOL_MINT, 0.00204, 9), d(BONK, 10_000_000, 5), d(WIF, 60, 6)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^multi-leg/);
  });

  test("a small but genuine SOL quote leg is not mistaken for plumbing", () => {
    // 0.01 SOL is inside the plumbing bound, but it is the only thing spent.
    // Dropping it would leave no quote at all, so the rule must not fire.
    const r = run([d(SOL_MINT, -0.01, 9), d(BONK, 10_000, 5)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.side).toBe("buy");
    expect(r.trade.quote.address).toBe(SOL_MINT);
    expect(r.trade.usdValue).toBeCloseTo(1.5, 9);
  });

  test("the multi-leg reason reports its counts the right way round", () => {
    const r = run([d(USDC_MINT, -400), d(SOL_MINT, -1, 9), d(BONK, 10_000_000, 5), d(WIF, 60, 6)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("multi-leg:2out/2in");
  });

  test("sub-cent dust legs are filtered before classification", () => {
    // A stray 0.2c of USDC alongside a real SOL -> BONK buy must not turn the
    // transaction into an unclassifiable two-out batch.
    const r = run([d(SOL_MINT, -1, 9), d(USDC_MINT, -0.002), d(BONK, 10_000_000, 5)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.quote.address).toBe(SOL_MINT);
  });
});

describe("deltasFromMeta", () => {
  test("nets the transaction fee out of the native SOL change", () => {
    const out = deltasFromMeta({
      ownerIndex: 0,
      preBalances: [2_000_000_000],
      postBalances: [999_995_000],
      fee: 5_000,
      preTokenBalances: [],
      postTokenBalances: [],
      owner: "LEADER",
    });
    // Spent exactly 1 SOL; the 5000-lamport fee is a cost of transacting.
    expect(out).toHaveLength(1);
    expect(out[0]!.amount).toBeCloseTo(-1, 9);
  });

  test("only counts token accounts belonging to the leader", () => {
    const out = deltasFromMeta({
      ownerIndex: null,
      preBalances: [],
      postBalances: [],
      fee: 0,
      preTokenBalances: [
        { mint: BONK, owner: "LEADER", uiTokenAmount: { decimals: 5, uiAmountString: "0" } },
        { mint: WIF, owner: "SOMEONE_ELSE", uiTokenAmount: { decimals: 6, uiAmountString: "100" } },
      ],
      postTokenBalances: [
        { mint: BONK, owner: "LEADER", uiTokenAmount: { decimals: 5, uiAmountString: "10000000" } },
        { mint: WIF, owner: "SOMEONE_ELSE", uiTokenAmount: { decimals: 6, uiAmountString: "0" } },
      ],
      owner: "LEADER",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.mint).toBe(BONK);
    expect(out[0]!.amount).toBeCloseTo(10_000_000, 6);
  });

  test("sums multiple token accounts of the same mint", () => {
    const out = deltasFromMeta({
      ownerIndex: null,
      preBalances: [],
      postBalances: [],
      fee: 0,
      preTokenBalances: [
        { mint: BONK, owner: "LEADER", uiTokenAmount: { decimals: 5, uiAmountString: "100" } },
        { mint: BONK, owner: "LEADER", uiTokenAmount: { decimals: 5, uiAmountString: "50" } },
      ],
      postTokenBalances: [
        { mint: BONK, owner: "LEADER", uiTokenAmount: { decimals: 5, uiAmountString: "0" } },
        { mint: BONK, owner: "LEADER", uiTokenAmount: { decimals: 5, uiAmountString: "0" } },
      ],
      owner: "LEADER",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.amount).toBeCloseTo(-150, 6);
  });
});
