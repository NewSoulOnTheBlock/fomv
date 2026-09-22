import type { MarketDataSource } from "../chains/adapter.js";
import type { LeaderTrade, TokenRef } from "../types.js";
import { tokenKey } from "../types.js";
import { buildEpisodes } from "../scoring/episodes.js";
import { buildProfile, DEFAULT_ABILITY, type AbilityConfig, type AbilityProfile } from "../scoring/ability.js";
import { ObservedPricePath } from "../scoring/pricepath.js";
import { CurrentMarketLookup, type HistorySource } from "./shortlist.js";

/**
 * Build a trader's ability profile from live chain data.
 *
 * This is the one place where the honest-but-abstract machinery in
 * `src/scoring` meets the messy realities of what an RPC will actually tell
 * you, so it is also where every approximation gets named. The profile carries
 * its own provenance: what window it covers, how many prices were observable,
 * and which numbers are standing in for something better.
 */

export interface ProfileProvenance {
  /** Swaps decoded from the leader's history. */
  trades: number;
  /** Earliest and latest trade seen, in ms. Null when there were no trades. */
  windowFromMs: number | null;
  windowToMs: number | null;
  /** Tokens for which a current price and liquidity could be fetched. */
  tokensPriced: number;
  /** Total price observations available across all tokens. */
  priceObservations: number;
  /** Book value used to compute position weights, or null when unavailable. */
  equityUsd: number | null;
  /** Set when paging stopped early. */
  truncated: string | null;
  /** Approximations in force, in plain language. */
  caveats: string[];
  computedAtMs: number;
}

export interface TraderProfile {
  address: string;
  handle?: string;
  profile: AbilityProfile;
  provenance: ProfileProvenance;
}

export async function buildTraderProfile(args: {
  address: string;
  handle?: string;
  watcher: HistorySource;
  data: MarketDataSource;
  maxPages?: number;
  ability?: AbilityConfig;
  /** How far a price observation may be from the moment asked about. */
  priceToleranceMs?: number;
  onPage?: (page: number, trades: number) => void;
}): Promise<TraderProfile> {
  const {
    address,
    handle,
    watcher,
    data,
    maxPages,
    ability = DEFAULT_ABILITY,
    priceToleranceMs = 2 * 60 * 60 * 1000,
    onPage,
  } = args;

  let truncated: string | null = null;
  const trades = await watcher.history({
    pages: maxPages,
    onPage,
    onTruncated: (reason) => {
      truncated = reason;
    },
  });

  const lookup = await CurrentMarketLookup.warm(data, trades);

  // Book value, for position weights. Same approximation as the scorer: one
  // number standing in for the whole window.
  let equityUsd: number | null = null;
  try {
    const book = await data.portfolio(address);
    if (book.totalUsd > 0) equityUsd = book.totalUsd;
  } catch {
    // Leave it null; weights stay zero and the risk dimension says so.
  }
  const equityAt = equityUsd === null ? undefined : () => equityUsd ?? undefined;

  const episodes = buildEpisodes(trades, equityAt);

  // The price path is assembled from prices that were genuinely observed: the
  // trader's own fills, plus one current price per token. Sparse, and biased
  // toward moments the trader chose to act on, which is why every metric built
  // on it reports its own sample size.
  const path = ObservedPricePath.from(trades, {
    currentPrice: (t: TokenRef) => lookup.priceUsdAt(t, Date.now()),
    toleranceMs: priceToleranceMs,
  });

  const seen = new Set<string>();
  let priceObservations = 0;
  for (const t of trades) {
    const k = tokenKey(t.asset);
    if (seen.has(k)) continue;
    seen.add(k);
    priceObservations += path.observationCount(t.asset);
  }

  const profile = buildProfile(address, episodes, path, ability);

  const times = trades.map((t: LeaderTrade) => t.ts);
  const caveats = [
    "Position weights use the trader's book value as it is now, not as it was at each trade. " +
      "An account that has grown understates its early weights, which flatters risk scores.",
    "Prices after an entry or exit come from the trader's own later fills plus one current price. " +
      "Coverage is sparse and clustered where they chose to act, so entry and exit quality " +
      "report their own sample sizes.",
    "Drawdown is measured on realised P&L in close order, so it cannot see paper losses on a " +
      "position that recovered before being closed. It is a floor on the true figure.",
  ];
  if (truncated) caveats.push(`History paging stopped early: ${truncated}`);
  if (equityUsd === null) caveats.push("No book value was available, so position sizing is unmeasured.");

  return {
    address,
    handle,
    profile,
    provenance: {
      trades: trades.length,
      windowFromMs: times.length ? Math.min(...times) : null,
      windowToMs: times.length ? Math.max(...times) : null,
      tokensPriced: lookup.coverage,
      priceObservations,
      equityUsd,
      truncated,
      caveats,
      computedAtMs: Date.now(),
    },
  };
}
