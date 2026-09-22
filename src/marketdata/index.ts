import { BirdeyeFeed } from "./birdeye.js";
import { CandleCache } from "./cache.js";
import { GeckoTerminalFeed } from "./geckoterminal.js";
import type { PriceFeed } from "./feed.js";

export * from "./feed.js";
export { CandleCache } from "./cache.js";
export { GeckoTerminalFeed } from "./geckoterminal.js";
export { BirdeyeFeed } from "./birdeye.js";
export * from "./candlepath.js";

/**
 * The price feed this machine is configured for.
 *
 * # Why the default is a working feed rather than none
 *
 * Every other optional dependency in this repo defaults to off, because the
 * failure of a missing RPC key is loud. This one is the opposite: with no feed
 * the profile still builds, still prints an Edge Score, and still publishes a
 * grade -- computed from the trader's own fills, with the bias that implies.
 * A silent downgrade to worse data is the one thing a published grade must
 * not do, so the default is the keyless feed that actually works and the
 * escape hatch is explicit.
 *
 * `FOMV_PRICE_FEED=none` turns it off for anyone who wants the old behaviour
 * or is working offline. The provenance says which was used either way.
 */
export function priceFeedFromEnv(
  env: Record<string, string | undefined> = process.env,
): PriceFeed | null {
  const choice = (env.FOMV_PRICE_FEED ?? "auto").toLowerCase();
  if (choice === "none" || choice === "off") return null;

  const cache = new CandleCache({ dir: env.FOMV_CANDLE_CACHE ?? "state/cache/candles" });
  const network = env.FOMV_PRICE_NETWORK ?? "solana";
  const key = env.BIRDEYE_API_KEY;

  if (choice === "birdeye" || (choice === "auto" && key)) {
    if (!key) throw new Error("FOMV_PRICE_FEED=birdeye requires BIRDEYE_API_KEY");
    return new BirdeyeFeed({ apiKey: key, chain: network, cache });
  }

  return new GeckoTerminalFeed({ network, cache });
}
