#!/usr/bin/env bun
import { Connection } from "@solana/web3.js";

import { JupiterExecutor } from "../chains/solana/jupiter.js";
import { SolanaMarketData } from "../chains/solana/marketdata.js";
import { SolanaLeaderWatcher } from "../chains/solana/watcher.js";
import { PrivyDelegatedSigner } from "../chains/solana/privy-signer.js";
import { followCycle, type FollowDeps } from "../follow/runner.js";
import { makeFeeTerms } from "../follow/fees.js";
import type { Subscriber } from "../follow/subscriber.js";
import { LAUNCH_ROSTER, payoutAddressOf } from "../platform/roster.js";
import { createHandler } from "./api.js";
import { createPrivyClient, userApiFor, walletApiFor } from "./privy.js";
import { Store } from "./store.js";

/**
 * The FOMV follow server.
 *
 * Two things share a process: an HTTP API the app talks to, and a loop that
 * mirrors leaders into subscribers' wallets. They share a `Store` and nothing
 * else.
 *
 * # Operating notes
 *
 * This is a long-running stateful process, not a serverless function. It holds
 * a cursor per subscriber, a SQLite file, and rate-limited RPC connections;
 * none of that survives being started fresh per request. Run one instance.
 *
 * Running two against the same database would double-mirror every trade: both
 * would read the same unprocessed ids before either recorded a fill. If you
 * need redundancy, run a standby that is not polling.
 *
 * # Failure posture
 *
 * `MODE=live` is required before a single real transaction is signed. The
 * default is dry-run, which quotes and plans and prints exactly what it would
 * have done. A server that traded other people's money the moment it booted
 * would be the wrong default however careful the operator.
 */

const cfg = {
  rpcUrl: required("SOLANA_RPC_URL"),
  txRpcUrl: process.env.SOLANA_TX_RPC_URL ?? process.env.SOLANA_RPC_URL!,
  privyAppId: required("PRIVY_APP_ID"),
  privyAppSecret: required("PRIVY_APP_SECRET"),
  privyAuthKey: process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY,
  treasury: required("FOMV_TREASURY"),
  dbPath: process.env.FOMV_DB_PATH ?? "state/follow.sqlite",
  port: Number(process.env.PORT ?? 8080),
  intervalMs: Number(process.env.FOMV_POLL_INTERVAL_SEC ?? 10) * 1000,
  live: process.env.MODE === "live",
  allowedOrigins: (process.env.FOMV_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  tradeFeeBps: Number(process.env.FOMV_TRADE_FEE_BPS ?? 100),
  leaderShareBps: Number(process.env.FOMV_LEADER_SHARE_BPS ?? 5_000),
  // Absent disables the applications inbox rather than opening it.
  adminToken: process.env.FOMV_ADMIN_TOKEN,
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[fatal] ${name} is required. See .env.example.`);
    process.exit(1);
  }
  return v;
}

const store = new Store({ path: cfg.dbPath });
const privy = createPrivyClient({
  appId: cfg.privyAppId,
  appSecret: cfg.privyAppSecret,
  authorizationPrivateKey: cfg.privyAuthKey,
});
const wallets = walletApiFor(privy);
const users = userApiFor(privy);

const conn = new Connection(cfg.rpcUrl, "confirmed");
const txConn = cfg.txRpcUrl === cfg.rpcUrl ? conn : new Connection(cfg.txRpcUrl, "confirmed");
const data = new SolanaMarketData(conn);

const feeTerms = makeFeeTerms(cfg.treasury, {
  tradeFeeBps: cfg.tradeFeeBps,
  leaderShareBps: cfg.leaderShareBps,
});
const feeLedger = store.loadFeeLedger();

/**
 * One executor per subscriber, because each signs with their own delegation.
 *
 * Built per cycle rather than cached: a subscriber who revokes and re-grants
 * gets a signer whose sticky revocation flag has been cleared, which a cached
 * instance would carry forever.
 */
function executorFor(sub: Subscriber) {
  const signer = new PrivyDelegatedSigner({
    userId: sub.userId,
    walletId: sub.walletId,
    address: sub.address,
    wallets,
    users,
  });
  return new JupiterExecutor(conn, data, signer, {
    baseUrl: process.env.JUPITER_API_URL,
    apiKey: process.env.JUPITER_API_KEY,
  });
}

const deps: FollowDeps = {
  // Replaced per leader inside the loop; the watcher is leader-specific.
  watcher: null as never,
  data,
  executorFor,
  feeTerms,
  feeLedger,
  dryRun: !cfg.live,
};

/** First roster payout address, for the startup banner only. */
function leaderPayoutPreview(): string {
  const first = LAUNCH_ROSTER[0];
  return first ? payoutAddressOf(first).slice(0, 8) + "…" : "roster empty";
}

let cycles = 0;
let lastError: string | null = null;
let stopping = false;

async function runOnce(): Promise<void> {
  const byLeader = store.activeByLeader();
  if (byLeader.size === 0) return;

  for (const [leader, subscribers] of byLeader) {
    const watcher = new SolanaLeaderWatcher(txConn, leader, data, {
      limit: 25,
      batchSize: 5,
      throttleMs: 120,
    });

    const report = await followCycle({
      leader,
      subscribers,
      deps: { ...deps, watcher },
    });

    for (const sub of subscribers) {
      // Persist the idempotency set before anything else: a crash after a
      // broadcast must not leave a trade eligible to be mirrored twice.
      store.markProcessed(sub.address, sub.processed, Date.now());
      store.upsertSubscriber(sub);
    }
    store.saveFeeLedger(feeLedger);

    for (const r of report.results) {
      const filled = r.executions.filter((e) => e.ok).length;
      if (filled > 0 || r.error) {
        console.log(
          `[cycle] ${leader.slice(0, 8)} -> ${r.address.slice(0, 8)} ` +
            `filled=${filled} fees=$${r.feesAccruedUsd.toFixed(2)}${r.error ? ` error=${r.error}` : ""}`,
        );
      }
    }
    for (const address of report.revoked) {
      console.log(`[revoked] ${address.slice(0, 8)} withdrew delegation; no longer mirroring`);
    }
  }
}

async function loop(): Promise<void> {
  while (!stopping) {
    const started = Date.now();
    try {
      await runOnce();
      cycles++;
      lastError = null;
      // Cheap, and only worth doing occasionally.
      if (cycles % 360 === 0) store.pruneProcessed(Date.now());
    } catch (err) {
      lastError = (err as Error).message;
      console.error("[cycle] failed:", lastError);
    }
    const elapsed = Date.now() - started;
    await Bun.sleep(Math.max(0, cfg.intervalMs - elapsed));
  }
}

const handler = createHandler({
  store,
  privy,
  allowedOrigins: cfg.allowedOrigins,
  adminToken: cfg.adminToken,
});

const server = Bun.serve({
  port: cfg.port,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/status") {
      return new Response(
        JSON.stringify({
          ok: lastError === null,
          mode: cfg.live ? "live" : "dry-run",
          cycles,
          lastError,
          subscribers: store.allSubscribers().length,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return handler(req);
  },
});

console.log(`\nFOMV follow server`);
console.log(`  mode      ${cfg.live ? "LIVE — real transactions will be signed" : "dry-run"}`);
console.log(`  api       http://localhost:${server.port}`);
console.log(`  database  ${cfg.dbPath}`);
console.log(`  interval  ${cfg.intervalMs / 1000}s`);
console.log(
  `  fee       ${cfg.tradeFeeBps}bps per mirrored trade, ` +
    `${(cfg.leaderShareBps / 100).toFixed(0)}% to the leader \u2192 ${leaderPayoutPreview()}, ` +
    `rest to ${cfg.treasury.slice(0, 8)}\u2026`,
);
console.log(
  `  inbox     ${cfg.adminToken ? "GET /admin/applications (bearer)" : "disabled — set FOMV_ADMIN_TOKEN"}\n`,
);
if (!cfg.live) console.log(`  Set MODE=live to sign real transactions.\n`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // Finish the cycle in flight rather than abandoning a broadcast whose
    // fill has not yet been recorded.
    console.log(`\n[${sig}] finishing current cycle…`);
    stopping = true;
    setTimeout(() => {
      store.saveFeeLedger(feeLedger);
      store.close();
      process.exit(0);
    }, 1_000);
  });
}

await loop();
