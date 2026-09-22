import type { ChainId } from "../types.js";

/**
 * The FOMV launch roster.
 *
 * Kept as data rather than being discovered at runtime: which traders FOMV
 * lists is an editorial decision that should be reviewable in a diff, not an
 * emergent property of whatever the scorer happened to return that morning.
 * `src/cli.ts score` informs this file; it does not write it.
 */

export interface RosterCandidate {
  /** Public handle, used on the vault page. */
  handle: string;
  /** The address the vault mirrors. One chain, because a vault mirrors one book. */
  leader: string;
  chain: ChainId;
  /**
   * Other addresses known to belong to the same trader that FOMV cannot mirror.
   *
   * Recorded rather than dropped, because they matter twice: a depositor
   * following "pointfarmcap" should know they are getting one chain and not
   * the trader in full, and whoever builds the next chain adapter needs the
   * address to test against.
   */
  elsewhere?: { address: string; note: string }[];
  /**
   * Where this leader's share of trade fees is sent.
   *
   * Defaults to their trading address only because that is the one we are
   * certain they control. Paying into the wallet being watched moves the very
   * balances the strategy sizes against, so a separate address is strongly
   * preferred and should be collected at listing.
   */
  payoutAddress?: string;
  /** Freeform note for the roster page. */
  note?: string;
}

/** Where a leader's fee share should be sent. */
export function payoutAddressOf(c: RosterCandidate): string {
  return c.payoutAddress ?? c.leader;
}

export const LAUNCH_ROSTER: RosterCandidate[] = [
  {
    handle: "pointfarmcap",
    leader: "Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit",
    chain: "solana",
    elsewhere: [
      {
        address: "0xfd87eda88be6c372453b721da63d58ad1a5b2d94",
        note:
          "EVM address supplied alongside the Solana one. Which EVM chain is not yet " +
          "established, and there is no EVM ChainAdapter in this repo, so nothing here " +
          "reads, scores or mirrors it. A pointfarmcap vault is Solana-only until that " +
          "adapter exists.",
      },
    ],
    note:
      "Scored 2026-09-22 over ~4,500 signatures spanning 5.6 days: Edge Score 54 (grade D) " +
      "from 56 complete round trips, 53.6% win rate, 1.30 profit factor. An earlier 18-hour " +
      "sample read far better (79% win, 2.16 profit factor) and was flattering - it caught " +
      "one good afternoon.",
  },
  {
    handle: "crewofrebels",
    leader: "9Y3RsSURHJL9DGvAbRhbBHPUs7YsnXmiCkpMkCn5RJLW",
    chain: "solana",
    note:
      "Listed on fomo as https://fomo.family/profile/crewofrebels. Renamed from "
      + "\"MFCheetoTiger\" on 2026-09-22: the handle was wrong, the address was not, "
      + "and the trader confirmed the two go together. Nothing was rescored, because a "
      + "handle is a label and no figure below depends on it. "
      + "Scored 2026-09-22 and NOT yet listable. This address has 22 transactions in "
      + "total, all from 2026-09-22, and holds 0 SOL. 18 decoded as swaps across a "
      + "3.6-hour window: 8 complete round trips, 0% win rate, -$161 realised. The "
      + "scorer withholds a grade below 20 closed trips, and correctly does so here. "
      + "Decoding is not the problem (18 of 22 transactions parsed) - there is simply "
      + "almost no history, so this is a thin window rather than a bad trader.",
  },
  {
    handle: "johnarchived",
    leader: "5savr1gUa6iCLuWUKAwWmX55Z2own7sQCyYFhRpe7fZk",
    chain: "solana",
    note:
      "Audited 2026-09-22 over 437 swaps spanning 2026-07-31 to 2026-09-22: "
      + "Edge Score 56 (grade C) from 73 closed round trips. Entry 40, "
      + "profitability 54, risk 68, exit 49, consistency 65. "
      + "The shape is a right tail, and it is the whole thesis. 32.9% win rate "
      + "with a 1.96 profit factor and 4.00 reward-to-risk: the median trade "
      + "loses 9.1% while the average makes 23.9%, because wins average $435 "
      + "against losses of $109. Realised +$5,106 on a book now worth $4,856. "
      + "A follower's first several mirrored trades will probably lose money; "
      + "the strategy only pays for someone who sits through that. "
      + "Two things to settle before listing. Peak position weight averages "
      + "9.6% and reached 66% of book, so the default maxPositionPct of 15% "
      + "would clip their largest conviction trades - decide whether that is "
      + "the intent. And candles covered 2 of 103 tokens, so entry (40) and "
      + "exit (49) rest on thin price support; a BIRDEYE_API_KEY would settle "
      + "whether those scores are real or an artifact of missing data. "
      + "Worth recording how nearly this was got wrong: a 12-page read saw 18 "
      + "closed trips and withheld a grade. Thirty pages found 73. The floor "
      + "of 20 measures the window, not the trader.",
  },
];

/** Candidates FOMV can actually mirror today. */
export function mirrorable(roster: RosterCandidate[] = LAUNCH_ROSTER): RosterCandidate[] {
  return roster.filter((c) => c.chain === "solana");
}
