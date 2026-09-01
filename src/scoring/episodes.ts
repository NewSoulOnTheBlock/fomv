import type { LeaderTrade, TokenRef } from "../types.js";
import { tokenKey } from "../types.js";

/** fomo's published spot fee: 0.50% of notional, with a $0.95 floor per trade. */
export const FOMO_FEE_BPS = 50;
export const FOMO_FEE_MIN_USD = 0.95;

/**
 * Fee a fomo user actually pays on one trade.
 *
 * The floor is the part everyone forgets and it dominates small tickets: a $200
 * round trip pays ~$1.90, nearly 1% before slippage. A trader can be reliably
 * gross-profitable and still lose money net, which is exactly the trader a
 * naive leaderboard promotes.
 */
export function fomoFeeUsd(notionalUsd: number, feeBps = FOMO_FEE_BPS, minUsd = FOMO_FEE_MIN_USD): number {
  if (notionalUsd <= 0) return 0;
  return Math.max(minUsd, (notionalUsd * feeBps) / 10_000);
}

/**
 * One complete pass through a position: from the first buy while flat, to the
 * point the position returns to (approximately) zero.
 *
 * Episodes rather than individual fills are the right unit because fomo traders
 * scale in and out. Treating every fill as its own trade both inflates the
 * trade count and makes hold time meaningless.
 */
export interface Fill {
  ts: number;
  side: "buy" | "sell";
  qty: number;
  pxUsd: number;
  usdValue: number;
}

export interface Episode {
  token: TokenRef;
  openedAtMs: number;
  /** null while the position is still open. */
  closedAtMs: number | null;
  buys: number;
  sells: number;
  /** Units acquired across the episode. */
  qtyBought: number;
  qtySold: number;
  costUsd: number;
  proceedsUsd: number;
  feesUsd: number;
  /** Peak fraction of the trader's book committed at any point in the episode. */
  peakWeight: number;
  /** proceeds - cost - fees. Only meaningful once closed. */
  netPnlUsd: number;
  grossPnlUsd: number;
  holdSec: number | null;
  closed: boolean;
  /** Every fill in the episode, kept so latency decay can re-price the entries. */
  fills: Fill[];
}

/** Residual below this fraction of what was bought counts as flat. */
const FLAT_EPSILON = 0.02;

/**
 * Group a trader's fills into episodes, FIFO by token.
 *
 * `equityAt` supplies the trader's book value at a moment so peak weight can be
 * recorded; without it, weights are reported as zero rather than guessed.
 */
export function buildEpisodes(
  trades: LeaderTrade[],
  equityAt?: (tsMs: number) => number | undefined,
): Episode[] {
  const sorted = [...trades].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const open = new Map<string, Episode & { qtyHeld: number }>();
  const done: Episode[] = [];

  for (const t of sorted) {
    const key = tokenKey(t.asset);
    const fee = fomoFeeUsd(t.usdValue);

    if (t.side === "buy") {
      let ep = open.get(key);
      if (!ep) {
        ep = {
          token: t.asset,
          openedAtMs: t.ts,
          closedAtMs: null,
          buys: 0,
          sells: 0,
          qtyBought: 0,
          qtySold: 0,
          costUsd: 0,
          proceedsUsd: 0,
          feesUsd: 0,
          peakWeight: 0,
          netPnlUsd: 0,
          grossPnlUsd: 0,
          holdSec: null,
          closed: false,
          fills: [],
          qtyHeld: 0,
        };
        open.set(key, ep);
      }
      ep.buys += 1;
      ep.qtyBought += t.assetAmount;
      ep.qtyHeld += t.assetAmount;
      ep.costUsd += t.usdValue;
      ep.feesUsd += fee;
      ep.fills.push({ ts: t.ts, side: "buy", qty: t.assetAmount, pxUsd: t.fillPxUsd, usdValue: t.usdValue });

      const equity = equityAt?.(t.ts);
      if (equity && equity > 0) {
        const heldValue = ep.qtyHeld * t.fillPxUsd;
        ep.peakWeight = Math.max(ep.peakWeight, heldValue / equity);
      }
      continue;
    }

    // Sell with no recorded entry: the trader acquired the token some way we
    // did not observe (airdrop, transfer in, a chain we do not watch). Counting
    // it as pure profit would flatter them, so it is dropped entirely.
    const ep = open.get(key);
    if (!ep) continue;

    ep.sells += 1;
    ep.qtySold += t.assetAmount;
    ep.qtyHeld -= t.assetAmount;
    ep.proceedsUsd += t.usdValue;
    ep.feesUsd += fee;
    ep.fills.push({ ts: t.ts, side: "sell", qty: t.assetAmount, pxUsd: t.fillPxUsd, usdValue: t.usdValue });

    if (ep.qtyHeld <= ep.qtyBought * FLAT_EPSILON) {
      ep.closedAtMs = t.ts;
      ep.closed = true;
      ep.holdSec = (t.ts - ep.openedAtMs) / 1000;
      ep.grossPnlUsd = ep.proceedsUsd - ep.costUsd;
      ep.netPnlUsd = ep.grossPnlUsd - ep.feesUsd;
      const { qtyHeld: _drop, ...rest } = ep;
      done.push(rest);
      open.delete(key);
    }
  }

  // Positions still open at the end of the window are reported, but with no
  // P&L: marking them would require a current price and would quietly turn
  // unrealised paper gains into a track record.
  for (const ep of open.values()) {
    const { qtyHeld: _drop, ...rest } = ep;
    done.push({ ...rest, closed: false, netPnlUsd: 0, grossPnlUsd: 0, holdSec: null });
  }

  return done.sort((a, b) => a.openedAtMs - b.openedAtMs);
}
