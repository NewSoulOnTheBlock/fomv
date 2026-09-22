import type { MarketDataSource } from "../chains/adapter.js";
import { QUOTE_MINTS } from "../chains/solana/swaps.js";
import type { VaultState } from "../mirror/sizing.js";
import { tokenKey, type PortfolioSnapshot } from "../types.js";

/**
 * The subscriber's live book, read from the chain.
 *
 * # Why this is read rather than remembered
 *
 * The mirror engine was written against a `VaultState` that a caller invented
 * -- `emptyVaultState(50_000)` -- which is fine for a simulation and wrong for
 * a real account. A followed wallet is not a closed system: its owner can
 * trade it themselves, receive an airdrop, send tokens out, or simply run the
 * bot again after a week away.
 *
 * So balances are derived from chain state every cycle instead of accumulated
 * in memory. The bot self-heals: a restart, a missed fill, a manual sale, a
 * transaction that landed after we stopped watching, all correct themselves on
 * the next read. Accumulated state would drift silently and size every
 * subsequent trade off a number that was never true.
 *
 * What genuinely cannot be read back from a balance is carried separately in
 * `FollowMemory` -- those facts are about *decisions we made*, not about what
 * the wallet holds.
 */

/**
 * Facts the chain cannot tell us, which therefore have to be remembered.
 *
 * Deliberately small. Everything here is a liability on restart, because it is
 * the only state that can be wrong without anything correcting it.
 */
export interface FollowMemory {
  /** USD deployed into new positions so far this UTC day. */
  deployedTodayUsd: number;
  /** tokenKey -> ms of the last full exit, for the re-entry cooldown. */
  lastExitAtMs: Map<string, number>;
  /** tokenKey -> ms we first opened it, for hold-time reporting. */
  openedAtMs: Map<string, number>;
}

export function emptyMemory(): FollowMemory {
  return { deployedTodayUsd: 0, lastExitAtMs: new Map(), openedAtMs: new Map() };
}

/**
 * Build the engine's view of a wallet from its actual holdings.
 *
 * Quote assets (SOL, USDC, USDT) count as dry powder rather than positions,
 * which is what lets sizing treat "how much can I deploy" and "what am I
 * already exposed to" as different questions. A leader sitting 90% in USDC is
 * not 90% invested, and neither is a follower.
 */
export function vaultStateFromWallet(book: PortfolioSnapshot, memory: FollowMemory, nowMs: number): VaultState {
  const positions: VaultState["positions"] = new Map();
  let quoteUsd = 0;

  for (const h of book.holdings) {
    if (QUOTE_MINTS.has(h.token.address)) {
      quoteUsd += h.usdValue;
      continue;
    }
    // Dust is excluded from the position count so a trail of unsellable
    // remnants cannot consume the maxPositions budget and block new entries.
    if (h.amount <= 0 || h.usdValue < DUST_USD) continue;

    const key = tokenKey(h.token);
    positions.set(key, {
      token: h.token,
      amount: h.amount,
      usdValue: h.usdValue,
      openedAtMs: memory.openedAtMs.get(key) ?? nowMs,
    });
  }

  return {
    equityUsd: book.totalUsd,
    quoteUsd,
    positions,
    deployedTodayUsd: memory.deployedTodayUsd,
    lastExitAtMs: new Map(memory.lastExitAtMs),
  };
}

/**
 * Positions worth less than this are treated as dust, not holdings.
 *
 * Memecoin exits routinely leave a residue that cannot be sold for more than
 * it costs to sell. Counting those as open positions would make a wallet look
 * permanently full.
 */
export const DUST_USD = 1;

/**
 * Fold what actually happened back into memory.
 *
 * Only the unreadable facts are recorded. Balances are deliberately not
 * written anywhere: the next cycle reads them from the chain, which is the
 * only source that cannot be wrong.
 */
export function rememberCycle(
  memory: FollowMemory,
  before: VaultState,
  after: VaultState,
  deployedUsd: number,
  nowMs: number,
): void {
  memory.deployedTodayUsd += deployedUsd;

  for (const key of before.positions.keys()) {
    if (!after.positions.has(key)) memory.lastExitAtMs.set(key, nowMs);
  }
  for (const key of after.positions.keys()) {
    if (!memory.openedAtMs.has(key)) memory.openedAtMs.set(key, nowMs);
  }
  for (const key of memory.openedAtMs.keys()) {
    if (!after.positions.has(key)) memory.openedAtMs.delete(key);
  }
}

/** Read a subscriber's book. Thin, but the one place the source is named. */
export async function readBook(data: MarketDataSource, address: string): Promise<PortfolioSnapshot> {
  return data.portfolio(address);
}
