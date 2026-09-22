import type { MarketDataSource } from "../chains/adapter.js";
import type { LeaderTrade, TokenRef } from "../types.js";
import { tokenKey } from "../types.js";
import { buildEpisodes } from "../scoring/episodes.js";
import { buildProfile, DEFAULT_ABILITY, type AbilityConfig, type AbilityProfile } from "../scoring/ability.js";
import { ObservedPricePath } from "../scoring/pricepath.js";
import { candlePathFor, LayeredPricePath, type CandleCoverage } from "../marketdata/candlepath.js";
import { resolutionKey, type PriceFeed } from "../marketdata/feed.js";
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
  /**
   * Where the historical prices came from.
   *
   * The single most important line of provenance on a published grade. Entry
   * and exit quality mean different things depending on the answer, and a
   * reader comparing two traders is entitled to know whether they were
   * measured against the market or against their own fills.
   */
  priceSource: PriceSource;
  /** Book value used to compute position weights, or null when unavailable. */
  equityUsd: number | null;
  /** Set when paging stopped early. */
  truncated: string | null;
  /** Approximations in force, in plain language. */
  caveats: string[];
  computedAtMs: number;
}

export interface PriceSource {
  /** Feed name, or "observed-fills" when no feed was configured or none answered. */
  feed: string;
  /** Candle width, e.g. "minute15". Null when no candles were used. */
  resolution: string | null;
  tokensRequested: number;
  tokensCovered: number;
  candles: number;
  /**
   * True when the trader's own fills were the only prices available.
   *
   * Read this before reading the entry and exit dimensions.
   */
  degraded: boolean;
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
  /**
   * Historical candles. Absent means the profile falls back to the trader's
   * own fills, and says so in its provenance.
   */
  priceFeed?: PriceFeed | null;
  onPage?: (page: number, trades: number) => void;
  onCandles?: (address: string, candles: number) => void;
}): Promise<TraderProfile> {
  const {
    address,
    handle,
    watcher,
    data,
    maxPages,
    ability = DEFAULT_ABILITY,
    priceToleranceMs = 2 * 60 * 60 * 1000,
    priceFeed,
    onPage,
    onCandles,
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

  // Two layers, in order of trust.
  //
  // Candles are the market's own record of every interval, including the ones
  // the trader slept through, and they are what makes capture ratio a
  // measurement rather than a restatement of the trade log. The trader's fills
  // stay underneath because they are real prices at exact moments, and a fill
  // inside a candle can reveal a spike the candle's resolution smoothed away.
  const observed = ObservedPricePath.from(trades, {
    currentPrice: (t: TokenRef) => lookup.priceUsdAt(t, Date.now()),
    toleranceMs: priceToleranceMs,
  });

  let coverage: CandleCoverage | null = null;
  let path: typeof observed | LayeredPricePath = observed;

  if (priceFeed) {
    const built = await candlePathFor(trades, priceFeed, { onToken: onCandles });
    // A feed that answered for nothing is not used at all, so the provenance
    // reports the fallback honestly rather than naming a source that
    // contributed no prices.
    if (built && built.coverage.candles > 0) {
      coverage = built.coverage;
      path = new LayeredPricePath([built.path, observed]);
    }
  }

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
    coverage
      ? `Prices after an entry or exit come from ${coverage.feed} candles at ${resolutionKey(coverage.resolution)} ` +
        `resolution, covering ${coverage.tokensCovered} of ${coverage.tokensRequested} tokens, with the ` +
        "trader's own fills underneath. A peak inside one candle is reported at that candle's high, so " +
        "capture ratio is measured against the market rather than against their own best fill."
      : "Prices after an entry or exit come from the trader's own later fills plus one current price. " +
        "Coverage is sparse and clustered where they chose to act -- a trader acts when price moves -- " +
        "so entry and exit quality are biased toward flattering the trader and report their own sample sizes.",
    "Drawdown is measured on realised P&L in close order, so it cannot see paper losses on a " +
      "position that recovered before being closed. It is a floor on the true figure.",
  ];
  if (coverage && coverage.uncovered.length > 0) {
    caveats.push(
      `${coverage.uncovered.length} token${coverage.uncovered.length === 1 ? "" : "s"} had no candles on ` +
        `${coverage.feed} and fall back to observed fills. Tokens too new or too thin to be indexed are the ` +
        "usual reason, and they are exactly the ones where the two sources disagree most.",
    );
  }
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
      priceSource: {
        feed: coverage?.feed ?? "observed-fills",
        resolution: coverage ? resolutionKey(coverage.resolution) : null,
        tokensRequested: coverage?.tokensRequested ?? seen.size,
        tokensCovered: coverage?.tokensCovered ?? 0,
        candles: coverage?.candles ?? 0,
        degraded: coverage === null,
      },
      equityUsd,
      truncated,
      caveats,
      computedAtMs: Date.now(),
    },
  };
}
