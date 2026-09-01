import type { ChainAdapter } from "./chains/adapter.js";
import type { JupiterExecutor } from "./chains/solana/jupiter.js";
import { planCycle, type Plan } from "./mirror/engine.js";
import type { VaultState } from "./mirror/sizing.js";
import type { VaultPolicy } from "./policy.js";
import {
  tokenKey,
  type ExecutionResult,
  type LeaderTrade,
  type MarketInfo,
  type MirrorIntent,
  type PortfolioSnapshot,
} from "./types.js";

export interface RunnerState {
  cursor: string | null;
  /** Leader trade ids already acted on. The durable idempotency guarantee. */
  processed: Set<string>;
  vault: VaultState;
  equityHighWaterUsd: number;
  startOfDayEquityUsd: number;
  leaderStartOfDayUsd: number;
  /** UTC day the daily counters belong to, as YYYY-MM-DD. */
  utcDay: string;
}

export interface TickReport {
  plan: Plan;
  leader: PortfolioSnapshot;
  executions: ExecutionResult[];
  skippedTransactions: { signature: string; reason: string }[];
}

export function initialState(vault: VaultState, leaderUsd: number, nowMs: number): RunnerState {
  return {
    cursor: null,
    processed: new Set(),
    vault,
    equityHighWaterUsd: vault.equityUsd,
    startOfDayEquityUsd: vault.equityUsd,
    leaderStartOfDayUsd: leaderUsd,
    utcDay: utcDay(nowMs),
  };
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Roll the per-day counters when the UTC date changes.
 *
 * Kept explicit rather than derived on read, so a vault that sat idle across a
 * date boundary starts the new day from the equity it actually has, not from
 * a number captured before the gap.
 */
export function rollDay(state: RunnerState, leaderUsd: number, nowMs: number): void {
  const day = utcDay(nowMs);
  if (day === state.utcDay) return;
  state.utcDay = day;
  state.startOfDayEquityUsd = state.vault.equityUsd;
  state.leaderStartOfDayUsd = leaderUsd;
  state.vault.deployedTodayUsd = 0;
}

export async function tick(args: {
  adapter: ChainAdapter;
  policy: VaultPolicy;
  state: RunnerState;
  dryRun: boolean;
  nowMs?: number;
}): Promise<TickReport> {
  const { adapter, policy, state, dryRun } = args;
  const nowMs = args.nowMs ?? Date.now();
  const skippedTransactions: { signature: string; reason: string }[] = [];

  const [{ trades, cursor }, leader] = await Promise.all([
    adapter.watcher.poll(state.cursor),
    adapter.data.portfolio(policy.leader),
  ]);

  rollDay(state, leader.totalUsd, nowMs);
  state.equityHighWaterUsd = Math.max(state.equityHighWaterUsd, state.vault.equityUsd);

  // Market data only for the assets this cycle actually touches.
  const assets = new Map(trades.map((t) => [tokenKey(t.asset), t]));
  const markets = new Map<string, MarketInfo>();
  await Promise.all(
    [...assets.entries()].map(async ([key, t]) => {
      const m = await adapter.data.market(t.asset).catch(() => null);
      if (!m) return;
      // The honeypot probe is asked of the executor, because "can we sell it"
      // is a routing question, not a metadata question.
      const canSell = await probeSell(adapter, t, m, policy, state.vault.equityUsd).catch(() => true);
      markets.set(key, { ...m, sellSimulationFailed: !canSell });
    }),
  );

  const plan = planCycle({
    trades,
    leader,
    vault: state.vault,
    markets,
    policy,
    processed: state.processed,
    equityHighWaterUsd: state.equityHighWaterUsd,
    startOfDayEquityUsd: state.startOfDayEquityUsd,
    leaderStartOfDayUsd: state.leaderStartOfDayUsd,
    priceAsOfMs: leader.ts,
    nowMs,
  });

  const executions: ExecutionResult[] = [];
  for (const intent of plan.intents) {
    if (intent.kind === "skip") continue;
    const pos = state.vault.positions.get(tokenKey(intent.asset));
    const result = await adapter.executor.execute(intent, {
      positionAmount: pos?.amount ?? 0,
      maxSlippageBps: policy.execution.maxSlippageBps,
      maxPriorityFeeUsd: policy.execution.maxPriorityFeeUsd,
      dryRun,
    });
    executions.push(result);

    // Record before mutating anything else: a crash after a broadcast must not
    // leave the trade unrecorded and eligible to be mirrored a second time.
    if (result.ok) {
      state.processed.add(intent.sourceTradeId);
      applyFill(state.vault, intent, result, nowMs);
    }
  }

  // Only advance the cursor once every intent from this batch is resolved, so
  // an interrupted run re-reads the range instead of skipping it.
  state.cursor = cursor;
  return { plan, leader, executions, skippedTransactions };
}

/**
 * Ask whether the vault could get back out of this asset, at the size it might
 * actually hold.
 *
 * Probing with a nominal one-unit amount is close to useless: a thin or
 * deliberately trapped token routes fine for dust and not at all for a real
 * position, so the probe passes and the vault buys something it cannot exit.
 * Sizing the probe at the largest position policy would ever permit asks the
 * question that matters — can we get out on our worst day, not our smallest.
 */
async function probeSell(
  adapter: ChainAdapter,
  trade: LeaderTrade,
  market: MarketInfo,
  policy: VaultPolicy,
  equityUsd: number,
): Promise<boolean> {
  // Called as a method so `this` survives; executors without a probe abstain.
  const ex = adapter.executor as unknown as JupiterExecutor;
  if (typeof (ex as { canSell?: unknown }).canSell !== "function") return true;
  if (market.priceUsd <= 0) return false;

  // Worst case the vault could be holding: the per-asset concentration cap,
  // itself bounded by what the liquidity cap would ever let us accumulate.
  const worstCaseUsd = Math.min(
    policy.sizing.maxPositionPct * equityUsd,
    policy.safety.maxPctOfLiquidity * market.liquidityUsd,
  );
  const units = worstCaseUsd / market.priceUsd;
  const base = BigInt(Math.max(1, Math.floor(units * 10 ** trade.asset.decimals)));
  return ex.canSell(trade.asset, trade.quote, base, policy.execution.maxSlippageBps);
}

function applyFill(
  vault: VaultState,
  intent: Extract<MirrorIntent, { kind: "buy" | "sell" }>,
  result: ExecutionResult,
  nowMs: number,
): void {
  const key = tokenKey(intent.asset);
  if (intent.kind === "buy") {
    const px = result.fillPxUsd ?? 0;
    const amount = px > 0 ? result.filledUsd / px : 0;
    const prev = vault.positions.get(key);
    vault.positions.set(key, {
      token: intent.asset,
      amount: (prev?.amount ?? 0) + amount,
      usdValue: (prev?.usdValue ?? 0) + result.filledUsd,
      openedAtMs: prev?.openedAtMs ?? nowMs,
    });
    vault.quoteUsd -= result.filledUsd;
    vault.deployedTodayUsd += result.filledUsd;
    return;
  }

  const prev = vault.positions.get(key);
  if (!prev) return;
  if (intent.fraction >= 1) {
    vault.positions.delete(key);
    vault.lastExitAtMs.set(key, nowMs);
  } else {
    vault.positions.set(key, {
      ...prev,
      amount: prev.amount * (1 - intent.fraction),
      usdValue: Math.max(0, prev.usdValue - result.filledUsd),
    });
  }
  vault.quoteUsd += result.filledUsd;
}
