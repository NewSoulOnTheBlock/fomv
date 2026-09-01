import type { LeaderTrade, MarketInfo, MirrorIntent, PortfolioSnapshot } from "../types.js";
import { tokenKey } from "../types.js";
import type { VaultPolicy } from "../policy.js";
import { checkBreakers, checkEntry, checkExit, type BreakerContext, type Verdict } from "./guardrails.js";
import { leaderPositionBefore, sizeEntry, sizeExit, type VaultState } from "./sizing.js";

export interface PlanInput {
  /** Leader trades detected this cycle, oldest first. */
  trades: LeaderTrade[];
  leader: PortfolioSnapshot;
  vault: VaultState;
  /** Market data keyed by `tokenKey`. */
  markets: Map<string, MarketInfo>;
  policy: VaultPolicy;
  processed: ReadonlySet<string>;
  equityHighWaterUsd: number;
  startOfDayEquityUsd: number;
  leaderStartOfDayUsd: number;
  priceAsOfMs: number;
  nowMs: number;
}

export interface Plan {
  breaker: Verdict;
  intents: MirrorIntent[];
  /** True when a breaker demands the book be closed out, not merely frozen. */
  flatten: boolean;
  warnings: string[];
}

const skip = (id: string, code: string, reason: string): MirrorIntent => ({
  kind: "skip",
  sourceTradeId: id,
  code,
  reason,
});

/**
 * Turn a cycle's worth of leader trades into mirror intents.
 *
 * State is advanced provisionally as intents are accepted, so that budgets and
 * caps compose across a burst. Evaluating five buys independently against the
 * same starting balance is how a copy bot ends up 5x over its own position
 * limit in a single block.
 */
export function planCycle(input: PlanInput): Plan {
  const { trades, leader, markets, policy, processed, nowMs } = input;
  const warnings: string[] = [];
  const intents: MirrorIntent[] = [];

  // Work on a shallow-cloned state so provisional effects never leak back into
  // the caller's snapshot if the plan is discarded.
  const vault: VaultState = {
    ...input.vault,
    positions: new Map(input.vault.positions),
    lastExitAtMs: new Map(input.vault.lastExitAtMs),
  };

  const breakerCtx: BreakerContext = {
    policy,
    vault,
    equityHighWaterUsd: input.equityHighWaterUsd,
    startOfDayEquityUsd: input.startOfDayEquityUsd,
    leaderStartOfDayUsd: input.leaderStartOfDayUsd,
    leader,
    priceAsOfMs: input.priceAsOfMs,
    nowMs,
  };
  const breaker = checkBreakers(breakerCtx);

  // The kill switch stops everything. Every other breaker stops new risk while
  // still letting the vault get out of what it holds.
  if (!breaker.pass && breaker.code === "paused") {
    return {
      breaker,
      intents: trades.map((t) => skip(t.id, breaker.code, breaker.reason)),
      flatten: false,
      warnings,
    };
  }

  const flatten = !breaker.pass && breaker.code === "max-drawdown";
  if (flatten) {
    warnings.push(`${breaker.reason}: closing all positions`);
    for (const [key, pos] of vault.positions) {
      intents.push({
        kind: "sell",
        sourceTradeId: `breaker:max-drawdown:${key}`,
        asset: pos.token,
        quote: quoteFor(trades, pos.token.chain),
        fraction: 1,
        rationale: breaker.reason,
      });
    }
  }

  const processedNow = new Set(processed);

  for (const trade of trades) {
    if (trade.side === "buy" && !breaker.pass) {
      intents.push(skip(trade.id, breaker.code, breaker.reason));
      continue;
    }

    const ctx = {
      trade,
      market: markets.get(tokenKey(trade.asset)) ?? null,
      policy,
      vault,
      processed: processedNow,
      nowMs,
    };

    if (trade.side === "buy") {
      const verdict = checkEntry(ctx);
      if (!verdict.pass) {
        intents.push(skip(trade.id, verdict.code, verdict.reason));
        continue;
      }
      warnings.push(...verdict.warnings);

      const market = ctx.market!;
      const sized = sizeEntry({ trade, leader, vault, market, policy });
      if (sized.usdSize <= 0) {
        intents.push(skip(trade.id, "sized-out", `Sizing collapsed to zero via ${sized.clamps.join(", ")}`));
        continue;
      }

      intents.push({
        kind: "buy",
        sourceTradeId: trade.id,
        asset: trade.asset,
        quote: trade.quote,
        usdSize: sized.usdSize,
        rationale: describeEntry(trade, leader, sized.rawUsd, sized.usdSize, sized.clamps),
      });
      applyBuy(vault, trade, market, sized.usdSize);
      processedNow.add(trade.id);
      continue;
    }

    // --- sell -------------------------------------------------------------
    const verdict = checkExit(ctx);
    if (!verdict.pass) {
      intents.push(skip(trade.id, verdict.code, verdict.reason));
      continue;
    }
    warnings.push(...verdict.warnings);

    const held = leader.holdings.find((h) => tokenKey(h.token) === tokenKey(trade.asset));
    const before = leaderPositionBefore(held?.amount ?? 0, trade);
    const pos = vault.positions.get(tokenKey(trade.asset));
    const sized = sizeExit({ trade, leaderPositionBefore: before, vaultPosition: pos, policy });
    if (sized.fraction <= 0) {
      intents.push(skip(trade.id, "sized-out", `Exit fraction collapsed to zero via ${sized.clamps.join(", ")}`));
      continue;
    }

    intents.push({
      kind: "sell",
      sourceTradeId: trade.id,
      asset: trade.asset,
      quote: trade.quote,
      fraction: sized.fraction,
      rationale:
        `Leader sold ${(sized.leaderFraction * 100).toFixed(1)}% of their position` +
        (sized.clamps.length ? ` (${sized.clamps.join(", ")})` : ""),
    });
    applySell(vault, trade, sized.fraction, nowMs);
    processedNow.add(trade.id);
  }

  return { breaker, intents, flatten, warnings };
}

function describeEntry(
  trade: LeaderTrade,
  leader: PortfolioSnapshot,
  rawUsd: number,
  finalUsd: number,
  clamps: string[],
): string {
  const w = leader.totalUsd > 0 ? (trade.usdValue / leader.totalUsd) * 100 : 0;
  const base = `Leader put ${w.toFixed(2)}% of their book into ${trade.asset.symbol ?? trade.asset.address}`;
  if (!clamps.length) return `${base}; mirroring $${finalUsd.toFixed(2)}`;
  return `${base}; $${rawUsd.toFixed(2)} reduced to $${finalUsd.toFixed(2)} by ${clamps.join(", ")}`;
}

/** Provisional state advance so later trades in the same cycle see the effect. */
function applyBuy(vault: VaultState, trade: LeaderTrade, market: MarketInfo, usdSize: number): void {
  const key = tokenKey(trade.asset);
  const existing = vault.positions.get(key);
  const addedAmount = market.priceUsd > 0 ? usdSize / market.priceUsd : 0;
  vault.positions.set(key, {
    token: trade.asset,
    amount: (existing?.amount ?? 0) + addedAmount,
    usdValue: (existing?.usdValue ?? 0) + usdSize,
    openedAtMs: existing?.openedAtMs ?? trade.ts,
  });
  vault.quoteUsd -= usdSize;
  vault.deployedTodayUsd += usdSize;
}

function applySell(vault: VaultState, trade: LeaderTrade, fraction: number, nowMs: number): void {
  const key = tokenKey(trade.asset);
  const pos = vault.positions.get(key);
  if (!pos) return;
  const proceeds = pos.usdValue * fraction;
  if (fraction >= 1) {
    vault.positions.delete(key);
    vault.lastExitAtMs.set(key, nowMs);
  } else {
    vault.positions.set(key, {
      ...pos,
      amount: pos.amount * (1 - fraction),
      usdValue: pos.usdValue - proceeds,
    });
  }
  vault.quoteUsd += proceeds;
}

/** Best-effort quote token for a forced flatten, from whatever this cycle saw. */
function quoteFor(trades: LeaderTrade[], chain: string) {
  const match = trades.find((t) => t.chain === chain);
  if (match) return match.quote;
  return { chain: chain as LeaderTrade["chain"], address: "USDC", symbol: "USDC", decimals: 6 };
}
