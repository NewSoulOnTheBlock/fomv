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
  /** Freeform note for the roster page. */
  note?: string;
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
      "Scored 2026-09-22 over the most recent ~1,200 signatures: grade A, composite 91, " +
      "capacity ~$1.6m against a $15.9m book. High-frequency; the window covered under a " +
      "day of activity.",
  },
];

/** Candidates FOMV can actually mirror today. */
export function mirrorable(roster: RosterCandidate[] = LAUNCH_ROSTER): RosterCandidate[] {
  return roster.filter((c) => c.chain === "solana");
}
