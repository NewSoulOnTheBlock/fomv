/**
 * The token and the places to find FOMV, in one file.
 *
 * # Why these live here and not in the footer
 *
 * A contract address is the one string on a site that people copy and act on,
 * and the cost of it being wrong is somebody's money going somewhere it cannot
 * come back from. Keeping it in a module rather than inline in markup means
 * there is exactly one place it can be wrong, and a change to it shows up in a
 * diff as a change to *the contract address* rather than as an edit to a
 * footer.
 *
 * # Absent means absent
 *
 * Every field here is optional and the footer renders nothing for the ones
 * that are empty. A social row with a dead link, or a contract line reading
 * `0x…` because a placeholder shipped, is worse than not having the row: the
 * first wastes a visitor's click and the second is indistinguishable from a
 * real address until they have already copied it.
 */

export interface TokenInfo {
  /** The mint address. Empty until there is one. */
  address: string;
  symbol: string;
  /** Where to look it up. `{address}` is substituted. */
  explorer?: string;
}

/**
 * The FOMV token.
 *
 * Verified against both of the price sources this app already uses before it
 * was put here: GeckoTerminal and DexScreener both resolve it to Fomo Vault,
 * symbol FOMV, six decimals, trading on pump.fun. A contract address is not a
 * thing to take on trust, least of all from a chat message, and checking it
 * costs one request against a feed the product was already calling.
 */
export const TOKEN: TokenInfo = {
  address: "3YfBU5he5b6pJUFoztLR9N1YsvMYMMXU5GGdGaX3pump",
  symbol: "FOMV",
  explorer: "https://solscan.io/token/{address}",
};

export interface Social {
  name: string;
  href: string;
}

/** Empty entries are skipped, so an unfilled one never ships as a dead link. */
export const SOCIALS: Social[] = [
  { name: "X", href: "https://x.com/fomv_agency" },
  { name: "Telegram", href: "" },
];

export function tokenExplorerUrl(token: TokenInfo = TOKEN): string | null {
  if (!token.address || !token.explorer) return null;
  return token.explorer.replace("{address}", token.address);
}

export function activeSocials(socials: Social[] = SOCIALS): Social[] {
  return socials.filter((s) => s.href.trim().length > 0);
}
