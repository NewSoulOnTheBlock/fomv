import type { LeaderWatcher, MarketDataSource, Executor } from "../chains/adapter.js";
import { DelegationRevokedError } from "../chains/solana/signer.js";
import { planCycle } from "../mirror/engine.js";
import { tokenKey, type ExecutionResult, type LeaderTrade, type MarketInfo, type PortfolioSnapshot } from "../types.js";
import { accrue, feeForTrade, type FeeLedger, type FeeTerms } from "./fees.js";
import { markRevoked, shouldMirror, type Subscriber } from "./subscriber.js";
import { rememberCycle, vaultStateFromWallet, type FollowMemory } from "./wallet-state.js";
import { utcDay } from "../runner.js";

/**
 * Mirrors one leader into many independent wallets.
 *
 * # The shape that matters
 *
 * The leader is polled **once** and the result is fanned out. Polling per
 * subscriber would multiply RPC cost by the subscriber count and, worse, would
 * hand different subscribers slightly different views of the same trade
 * depending on when their poll landed -- so two people following the same
 * leader would get different fills for reasons that have nothing to do with
 * them.
 *
 * Everything downstream of the poll is per subscriber, because it has to be:
 * each has their own balances, their own guardrails, their own idempotency
 * set, and their own permission that can disappear mid-cycle.
 *
 * # One subscriber's failure is their own
 *
 * A revoked delegation, an empty wallet, a route that will not price -- none
 * of these say anything about anyone else following the same leader. Each
 * subscriber is isolated so one bad account cannot stop the others being
 * served.
 */

export interface SubscriberExecution {
  address: string;
  executions: ExecutionResult[];
  /** Guardrail rejections, for the subscriber's activity feed. */
  skipped: { code: string; reason: string }[];
  feesAccruedUsd: number;
  error?: string;
}

export interface FollowCycleReport {
  leader: string;
  trades: LeaderTrade[];
  leaderBook: PortfolioSnapshot;
  results: SubscriberExecution[];
  /** Subscribers dropped this cycle because delegation was withdrawn. */
  revoked: string[];
}

export interface FollowDeps {
  watcher: LeaderWatcher;
  data: MarketDataSource;
  /** Built per subscriber, because each signs with their own delegation. */
  executorFor: (sub: Subscriber) => Executor;
  feeTerms: FeeTerms;
  feeLedger: FeeLedger;
  dryRun: boolean;
}

/**
 * Poll the leader once and mirror into every active subscriber.
 *
 * The cursor lives on each subscriber rather than on the loop. Someone who
 * subscribes today must not be served the leader's back catalogue, and someone
 * whose account errored for an hour should resume from where they stopped
 * rather than from wherever the shared loop happens to be.
 */
export async function followCycle(args: {
  leader: string;
  subscribers: Subscriber[];
  deps: FollowDeps;
  nowMs?: number;
}): Promise<FollowCycleReport> {
  const { leader, subscribers, deps } = args;
  const nowMs = args.nowMs ?? Date.now();

  // The oldest cursor across subscribers, so a single poll covers everyone.
  // Each subscriber then filters to what they have not already acted on.
  const cursor = oldestCursor(subscribers);
  const [{ trades }, leaderBook] = await Promise.all([
    deps.watcher.poll(cursor),
    deps.data.portfolio(leader),
  ]);

  const markets = await loadMarkets(deps.data, trades);

  const results: SubscriberExecution[] = [];
  const revoked: string[] = [];

  for (const sub of subscribers) {
    if (!shouldMirror(sub)) continue;
    try {
      const result = await mirrorInto({ sub, trades, leaderBook, markets, deps, nowMs });
      results.push(result);
    } catch (err) {
      if (err instanceof DelegationRevokedError) {
        markRevoked(sub);
        revoked.push(sub.address);
        results.push({ address: sub.address, executions: [], skipped: [], feesAccruedUsd: 0, error: "delegation withdrawn" });
        continue;
      }
      results.push({
        address: sub.address,
        executions: [],
        skipped: [],
        feesAccruedUsd: 0,
        error: (err as Error).message,
      });
    }
  }

  return { leader, trades, leaderBook, results, revoked };
}

async function mirrorInto(args: {
  sub: Subscriber;
  trades: LeaderTrade[];
  leaderBook: PortfolioSnapshot;
  markets: Map<string, MarketInfo>;
  deps: FollowDeps;
  nowMs: number;
}): Promise<SubscriberExecution> {
  const { sub, trades, leaderBook, markets, deps, nowMs } = args;

  // Balances come from the chain every cycle. See wallet-state.ts: a followed
  // wallet is not a closed system, and remembered balances drift.
  const book = await deps.data.portfolio(sub.address);
  rollDayFor(sub.memory, sub, nowMs);
  const before = vaultStateFromWallet(book, sub.memory, nowMs);

  const plan = planCycle({
    trades,
    leader: leaderBook,
    vault: before,
    markets,
    policy: sub.policy,
    processed: sub.processed,
    // Drawdown and daily-loss breakers need a reference equity. For a wallet
    // the subscriber also uses, the only defensible mark is what it is worth
    // now, so the breakers bound a single session rather than all time. Worth
    // knowing: this is weaker than the pooled version, which owned its book.
    equityHighWaterUsd: before.equityUsd,
    startOfDayEquityUsd: before.equityUsd,
    leaderStartOfDayUsd: leaderBook.totalUsd,
    priceAsOfMs: leaderBook.ts,
    nowMs,
  });

  const executor = deps.executorFor(sub);
  const executions: ExecutionResult[] = [];
  const skipped: { code: string; reason: string }[] = [];
  let feesAccruedUsd = 0;
  let deployedUsd = 0;

  for (const intent of plan.intents) {
    if (intent.kind === "skip") {
      skipped.push({ code: intent.code, reason: intent.reason });
      continue;
    }

    const pos = before.positions.get(tokenKey(intent.asset));
    const result = await executor.execute(intent, {
      positionAmount: pos?.amount ?? 0,
      maxSlippageBps: sub.policy.execution.maxSlippageBps,
      maxPriorityFeeUsd: sub.policy.execution.maxPriorityFeeUsd,
      dryRun: deps.dryRun,
    });
    executions.push(result);

    if (!result.ok) continue;

    // Recorded before anything else, so a crash after broadcast cannot leave
    // the trade eligible to be mirrored a second time.
    sub.processed.add(intent.sourceTradeId);
    if (intent.kind === "buy") deployedUsd += result.filledUsd;

    // Fees accrue against the filled notional and are settled separately.
    // Charging inside the swap would let a failed fee transfer revert the
    // subscriber's trade -- their execution must never depend on our invoice.
    if (!deps.dryRun) {
      const fee = feeForTrade(result.filledUsd, deps.feeTerms);
      accrue(deps.feeLedger, sub.address, fee);
      feesAccruedUsd += fee.feeUsd;
    }
  }

  // Re-read rather than mutate: the chain is the authority on what the trades
  // actually did, including partial fills and route slippage.
  const after = executions.some((e) => e.ok)
    ? vaultStateFromWallet(await deps.data.portfolio(sub.address), sub.memory, nowMs)
    : before;
  rememberCycle(sub.memory, before, after, deployedUsd, nowMs);

  // Only advance once every intent resolved, so an interrupted cycle re-reads
  // the range instead of skipping it.
  sub.cursor = newestOf(trades) ?? sub.cursor;

  return { address: sub.address, executions, skipped, feesAccruedUsd };
}

/** Per-subscriber UTC day roll, so the daily deploy budget resets. */
function rollDayFor(memory: FollowMemory, sub: Subscriber, nowMs: number): void {
  const day = utcDay(nowMs);
  const marker = (sub as Subscriber & { utcDay?: string }).utcDay;
  if (marker === day) return;
  (sub as Subscriber & { utcDay?: string }).utcDay = day;
  memory.deployedTodayUsd = 0;
}

function oldestCursor(subscribers: Subscriber[]): string | null {
  // A null cursor anywhere means someone needs the current head, and the
  // watcher treats null as "from here", which is what a new subscriber wants.
  for (const s of subscribers) if (s.cursor === null) return null;
  return subscribers[0]?.cursor ?? null;
}

function newestOf(trades: LeaderTrade[]): string | null {
  if (trades.length === 0) return null;
  return trades.reduce((a, b) => (a.ts >= b.ts ? a : b)).id.replace(/^solana:/, "");
}

async function loadMarkets(data: MarketDataSource, trades: LeaderTrade[]): Promise<Map<string, MarketInfo>> {
  const assets = new Map(trades.map((t) => [tokenKey(t.asset), t]));
  const markets = new Map<string, MarketInfo>();
  await Promise.all(
    [...assets.entries()].map(async ([key, t]) => {
      const m = await data.market(t.asset).catch(() => null);
      if (m) markets.set(key, m);
    }),
  );
  return markets;
}
