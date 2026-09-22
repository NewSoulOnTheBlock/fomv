import type { MarketDataSource } from "../chains/adapter.js";
import type { LeaderTrade, TokenRef } from "../types.js";
import { tokenKey } from "../types.js";
import type { MarketLookup } from "../scoring/metrics.js";
import { DEFAULT_SCORING, scoreTrader, type CopyabilityScore, type ScoringConfig } from "../scoring/score.js";

/**
 * Turning copyability scores into a FOMV roster decision.
 *
 * The scoring module grades a trader. This decides whether that grade is worth
 * a seat, which is a different question: a roster of three has to weigh a
 * merely-good trader who can absorb $2m against a brilliant one who breaks at
 * $40k.
 */

/**
 * A `MarketLookup` that answers every timestamp with today's market.
 *
 * This is an approximation and the name says so. `MarketLookup` exists to let
 * metrics report `null` instead of guessing, and handing it current liquidity
 * for a trade from three weeks ago defeats that on purpose -- it is the only
 * thing available without an archival liquidity index.
 *
 * What it distorts, specifically: capacity is computed against pools as they
 * are now, so a trader whose favourite token has since drained looks more
 * capacious than they were, and one who traded a token before it filled up
 * looks less. Treat capacity from this lookup as an order of magnitude, not a
 * number. Tokens that could not be fetched at all stay `undefined`, so those
 * episodes are excluded rather than quietly scored.
 */
export class CurrentMarketLookup implements MarketLookup {
  private readonly liquidity = new Map<string, number>();
  private readonly price = new Map<string, number>();

  /**
   * Pre-fetch every token in `trades`.
   *
   * Warming a cache up front rather than looking up lazily is forced by the
   * interface: `MarketLookup` is synchronous, and market data is not.
   */
  static async warm(data: MarketDataSource, trades: LeaderTrade[]): Promise<CurrentMarketLookup> {
    const lookup = new CurrentMarketLookup();
    const seen = new Map<string, TokenRef>();
    for (const t of trades) seen.set(tokenKey(t.asset), t.asset);

    for (const [key, token] of seen) {
      try {
        const info = await data.market(token);
        if (!info) continue;
        lookup.liquidity.set(key, info.liquidityUsd);
        lookup.price.set(key, info.priceUsd);
      } catch {
        // Leave it unknown. A failed fetch must not become a market reading.
      }
    }
    return lookup;
  }

  /** Tokens that were successfully priced, for reporting coverage. */
  get coverage(): number {
    return this.price.size;
  }

  liquidityUsdAt(token: TokenRef, _tsMs: number): number | undefined {
    return this.liquidity.get(tokenKey(token));
  }

  priceUsdAt(token: TokenRef, _tsMs: number): number | undefined {
    return this.price.get(tokenKey(token));
  }
}

/**
 * A source of a leader's past trades.
 *
 * Narrower than `LeaderWatcher` on purpose. A watcher polls *forward* from a
 * cursor, which is what mirroring needs and exactly what scoring cannot use:
 * paging a forward tail reaches the present immediately and returns one page
 * of history however many times it is called. Backfill is a different
 * operation and gets a different interface.
 */
export interface HistorySource {
  history(opts?: {
    pages?: number;
    onPage?: (page: number, trades: number) => void;
    onTruncated?: (reason: string) => void;
  }): Promise<LeaderTrade[]>;
}

export type Verdict = "list" | "watch" | "pass";

export interface Candidate {
  address: string;
  handle?: string;
  score: CopyabilityScore;
  verdict: Verdict;
  /** Why this verdict, in the order that decided it. */
  reasons: string[];
}

export interface ShortlistConfig {
  /** Composite below this is not worth a seat. */
  minComposite: number;
  /** A vault smaller than this cannot carry its own costs. */
  minCapacityUsd: number;
  /** Seats available. */
  seats: number;
}

export const DEFAULT_SHORTLIST: ShortlistConfig = {
  minComposite: 60,
  minCapacityUsd: DEFAULT_SCORING.minViableVaultUsd,
  seats: 3,
};

/**
 * Rank candidates and hand out seats.
 *
 * Capacity gates before rank, not after. A trader who scores 95 but breaks at
 * $30k is not a better listing than one who scores 70 and absorbs $2m -- they
 * are a vault that fills up and then starts losing to its own price impact.
 * Ordering the checks this way means the roster never spends a seat on one.
 */
export function shortlist(
  candidates: { address: string; handle?: string; score: CopyabilityScore }[],
  config: ShortlistConfig = DEFAULT_SHORTLIST,
): Candidate[] {
  const judged = candidates.map(({ address, handle, score }): Omit<Candidate, "verdict"> & { eligible: boolean } => {
    const reasons: string[] = [];
    let eligible = true;

    if (score.composite === null) {
      reasons.push("Not enough closed history to grade");
      eligible = false;
    } else if (score.composite < config.minComposite) {
      reasons.push(`Composite ${score.composite.toFixed(0)} is below the ${config.minComposite} bar`);
      eligible = false;
    }

    if (score.capacityUsd === null) {
      reasons.push("Capacity could not be measured; liquidity data was missing");
      eligible = false;
    } else if (score.capacityUsd < config.minCapacityUsd) {
      reasons.push(
        `Capacity of $${Math.round(score.capacityUsd).toLocaleString()} is under the ` +
          `$${config.minCapacityUsd.toLocaleString()} floor`,
      );
      eligible = false;
    }

    reasons.push(...score.flags);
    return { address, handle, score, reasons, eligible };
  });

  // Best first among the eligible; everyone else keeps their place behind them.
  const ranked = judged
    .slice()
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return (b.score.composite ?? -1) - (a.score.composite ?? -1);
    });

  let seatsLeft = config.seats;
  return ranked.map(({ eligible, ...rest }) => {
    if (!eligible) return { ...rest, verdict: "pass" as Verdict };
    if (seatsLeft > 0) {
      seatsLeft--;
      return { ...rest, verdict: "list" as Verdict };
    }
    return {
      ...rest,
      verdict: "watch" as Verdict,
      reasons: [...rest.reasons, `Qualified, but the roster is full at ${config.seats} seats`],
    };
  });
}

/** Score one candidate end to end. Convenience wrapper for the CLI. */
export async function scoreCandidate(args: {
  address: string;
  watcher: HistorySource;
  data: MarketDataSource;
  maxPages?: number;
  scoring?: ScoringConfig;
  onPage?: (n: number, total: number) => void;
}): Promise<{
  score: CopyabilityScore;
  trades: number;
  coverage: number;
  truncated: string | null;
  /** Book value capacity was computed against, or null if it was unavailable. */
  equityUsd: number | null;
}> {
  const { address, watcher, data, maxPages, scoring = DEFAULT_SCORING, onPage } = args;
  let truncated: string | null = null;
  const trades = await watcher.history({
    pages: maxPages,
    onPage,
    onTruncated: (reason) => {
      truncated = reason;
    },
  });
  const lookup = await CurrentMarketLookup.warm(data, trades);

  // Capacity needs the trader's book value at each trade, because the whole
  // derivation is "they committed X% of their book, so a vault of size V would
  // need X% of V to fit in that pool". Without a book value every episode
  // reports a peak weight of zero and capacity has nothing to measure.
  //
  // Today's book stands in for the book at each moment. The distortion is
  // one-directional and worth stating: a trader whose account has grown over
  // the window has their early weights understated, which overstates capacity.
  // Rebuilding historical equity trade by trade would fix it and is the honest
  // next step; a constant is the approximation, not the answer.
  //
  // When the book cannot be valued at all, `equityAt` stays undefined so
  // weights remain zero and capacity reports `null` -- an unmeasured capacity
  // must not become a measured one.
  let equityUsd: number | null = null;
  try {
    const book = await data.portfolio(address);
    if (book.totalUsd > 0) equityUsd = book.totalUsd;
  } catch {
    // Leave it null.
  }
  const equityAt = equityUsd === null ? undefined : () => equityUsd ?? undefined;

  return {
    score: scoreTrader(address, trades, lookup, equityAt, scoring),
    trades: trades.length,
    coverage: lookup.coverage,
    truncated,
    equityUsd,
  };
}
