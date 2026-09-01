import type { LeaderTrade, TokenRef } from "../../types.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Mints treated as the money side of a swap rather than the position side. */
export const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

export interface BalanceDelta {
  mint: string;
  decimals: number;
  /** Signed change in human units for the leader's own accounts. */
  amount: number;
}

export interface ExtractArgs {
  deltas: BalanceDelta[];
  signature: string;
  /** Block time in ms. */
  ts: number;
  leader: string;
  /** USD price per human unit, by mint. Only the quote leg strictly needs one. */
  priceUsd: (mint: string) => number | undefined;
  /** Ignore legs whose absolute USD value is under this, to filter fee dust. */
  dustUsd?: number;
}

export type ExtractResult =
  | { ok: true; trade: LeaderTrade }
  | { ok: false; reason: string };

/**
 * Recover a swap from the leader's *net* token balance changes.
 *
 * Deliberately not a per-DEX log decoder. fomo routes through aggregators, so
 * a single user action can touch Raydium, Meteora, Orca and a pump.fun curve in
 * one transaction, and each venue emits a different event shape. Net balance
 * deltas are venue-agnostic and, more importantly, collapse multi-hop routes
 * for free: a USDC -> SOL -> BONK route nets to exactly (-USDC, +BONK), so the
 * intermediate SOL leg can never be mistaken for a trade of its own. Decoding
 * per-leg events and mirroring each one is how a copy bot ends up buying and
 * immediately re-selling the router's intermediate token.
 */
export function extractSwap(args: ExtractArgs): ExtractResult {
  const { deltas, signature, ts, leader, priceUsd } = args;
  const dust = args.dustUsd ?? 0.01;

  // Merge wrapped SOL into native SOL: wrapping is plumbing, not a trade.
  const merged = new Map<string, BalanceDelta>();
  for (const d of deltas) {
    const mint = d.mint === SOL_MINT ? SOL_MINT : d.mint;
    const prev = merged.get(mint);
    merged.set(mint, prev ? { ...prev, amount: prev.amount + d.amount } : { ...d, mint });
  }

  const significant = [...merged.values()].filter((d) => {
    const px = priceUsd(d.mint);
    // Without a price we cannot judge dust, so keep the leg and let the
    // one-in-one-out check below decide.
    return px === undefined ? d.amount !== 0 : Math.abs(d.amount * px) >= dust;
  });

  const outs = significant.filter((d) => d.amount < 0);
  const ins = significant.filter((d) => d.amount > 0);

  if (outs.length === 0 || ins.length === 0) return { ok: false, reason: "not-a-swap" };
  if (outs.length > 1 || ins.length > 1) {
    // A genuine batch of independent swaps in one transaction. Mirroring a
    // guess here is worse than skipping and letting the next poll catch the
    // resulting position change.
    return { ok: false, reason: `multi-leg:${outs.length}in/${ins.length}out` };
  }

  const spent = outs[0]!;
  const got = ins[0]!;

  const spentIsQuote = QUOTE_MINTS.has(spent.mint);
  const gotIsQuote = QUOTE_MINTS.has(got.mint);
  if (spentIsQuote === gotIsQuote) {
    // Both quotes is a stable/SOL rotation; neither is a token-to-token swap.
    // Neither maps onto the vault's buy/sell model without extra bookkeeping.
    return { ok: false, reason: spentIsQuote ? "quote-rotation" : "token-to-token" };
  }

  const side = spentIsQuote ? "buy" : "sell";
  const assetDelta = spentIsQuote ? got : spent;
  const quoteDelta = spentIsQuote ? spent : got;

  const quotePx = priceUsd(quoteDelta.mint);
  if (quotePx === undefined) return { ok: false, reason: `no-price:${quoteDelta.mint}` };

  const quoteAmount = Math.abs(quoteDelta.amount);
  const assetAmount = Math.abs(assetDelta.amount);
  if (assetAmount === 0) return { ok: false, reason: "zero-asset-amount" };

  const usdValue = quoteAmount * quotePx;

  const asset: TokenRef = { chain: "solana", address: assetDelta.mint, decimals: assetDelta.decimals };
  const quote: TokenRef = {
    chain: "solana",
    address: quoteDelta.mint,
    decimals: quoteDelta.decimals,
    symbol: symbolOf(quoteDelta.mint),
  };

  return {
    ok: true,
    trade: {
      // A signature is unique per transaction and immutable, so it is a safe
      // idempotency key across restarts and overlapping polls.
      id: `solana:${signature}`,
      chain: "solana",
      leader,
      ts,
      side,
      asset,
      quote,
      assetAmount,
      quoteAmount,
      usdValue,
      fillPxUsd: usdValue / assetAmount,
    },
  };
}

function symbolOf(mint: string): string | undefined {
  if (mint === SOL_MINT) return "SOL";
  if (mint === USDC_MINT) return "USDC";
  if (mint === USDT_MINT) return "USDT";
  return undefined;
}

/**
 * Net balance deltas for one owner from a parsed transaction's meta.
 *
 * Native SOL is reported as a lamport balance on the owner's own account and
 * the transaction fee is netted out of it, so a pure SOL-side fee never looks
 * like a tiny sell.
 */
export function deltasFromMeta(args: {
  ownerIndex: number | null;
  preBalances: number[];
  postBalances: number[];
  fee: number;
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  owner: string;
}): BalanceDelta[] {
  const { ownerIndex, preBalances, postBalances, fee, preTokenBalances, postTokenBalances, owner } = args;
  const out: BalanceDelta[] = [];

  if (ownerIndex !== null) {
    const pre = preBalances[ownerIndex] ?? 0;
    const post = postBalances[ownerIndex] ?? 0;
    // Add the fee back: it is a cost of transacting, not part of the swap.
    const lamports = post - pre + fee;
    if (lamports !== 0) out.push({ mint: SOL_MINT, decimals: 9, amount: lamports / 1e9 });
  }

  const byMint = new Map<string, { decimals: number; pre: number; post: number }>();
  const add = (tb: TokenBalance, side: "pre" | "post") => {
    if (tb.owner !== owner) return;
    const amt = Number(tb.uiTokenAmount.uiAmountString ?? "0");
    const e = byMint.get(tb.mint) ?? { decimals: tb.uiTokenAmount.decimals, pre: 0, post: 0 };
    e[side] += amt;
    byMint.set(tb.mint, e);
  };
  for (const tb of preTokenBalances) add(tb, "pre");
  for (const tb of postTokenBalances) add(tb, "post");

  for (const [mint, e] of byMint) {
    const amount = e.post - e.pre;
    if (amount !== 0) out.push({ mint, decimals: e.decimals, amount });
  }

  return out;
}

export interface TokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { decimals: number; uiAmountString?: string | null };
}
