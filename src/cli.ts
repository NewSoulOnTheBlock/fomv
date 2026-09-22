#!/usr/bin/env bun
import { Connection, Keypair } from "@solana/web3.js";
import type { ChainAdapter } from "./chains/adapter.js";
import { JupiterExecutor } from "./chains/solana/jupiter.js";
import { SolanaMarketData } from "./chains/solana/marketdata.js";
import { SolanaLeaderWatcher } from "./chains/solana/watcher.js";
import { LocalKeypairSigner } from "./chains/solana/signer.js";
import { emptyVaultState } from "./mirror/sizing.js";
import { makePolicy } from "./policy.js";
import { initialState, tick } from "./runner.js";
import { DEFAULT_SHORTLIST, scoreCandidate, shortlist } from "./platform/shortlist.js";
import { buildTraderProfile } from "./platform/profile.js";
import { priceFeedFromEnv } from "./marketdata/index.js";
import { LAUNCH_ROSTER } from "./platform/roster.js";
import { mkdir, writeFile } from "node:fs/promises";
import { SolanaLeaderWatcher as Watcher } from "./chains/solana/watcher.js";
import { tokenKey } from "./types.js";

const args = parseArgs(process.argv.slice(2));
const flags = args.flags;
const command = args._[0] ?? "help";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const TX_RPC = flags["tx-rpc"] ?? process.env.SOLANA_TX_RPC_URL ?? RPC;
const LEADER = flags.leader ?? process.env.LEADER_ADDRESS ?? "";
const EQUITY = Number(flags.equity ?? 50_000);
const LIVE = flags.live === "true" || process.env.MODE === "live";

function buildAdapter(): ChainAdapter {
  const conn = new Connection(RPC, "confirmed");
  // Transaction history and account state are often served well by different
  // endpoints: free RPCs tend to refuse one or the other, and archival history
  // is the expensive half. Splitting them is what a real deployment does too.
  const txConn = TX_RPC === RPC ? conn : new Connection(TX_RPC, "confirmed");
  const data = new SolanaMarketData(conn);
  const key = process.env.SOLANA_VAULT_PRIVATE_KEY;
  const signer = LIVE && key ? new LocalKeypairSigner(Keypair.fromSecretKey(decodeKey(key))) : null;
  return {
    chain: "solana",
    watcher: new SolanaLeaderWatcher(txConn, LEADER, data, {
      limit: Number(flags.limit ?? 25),
      batchSize: Number(flags.batch ?? 5),
      onSkip: (sig, reason) => {
        if (flags.verbose) console.log(dim(`  · ${sig.slice(0, 12)}… skipped: ${reason}`));
      },
    }),
    data,
    executor: new JupiterExecutor(conn, data, signer, {
      baseUrl: process.env.JUPITER_API_URL,
      apiKey: process.env.JUPITER_API_KEY,
    }),
  };
}

async function main() {
  switch (command) {
    case "inspect":
      return inspect();
    case "simulate":
      return simulate(1);
    case "watch":
      return watch();
    case "score":
      return score();
    case "profile":
      return profile();
    default:
      return help();
  }
}

async function inspect() {
  requireLeader();
  const data = new SolanaMarketData(new Connection(RPC, "confirmed"));
  const p = await data.portfolio(LEADER);
  console.log(`\n${bold("Leader book")}  ${LEADER}`);
  console.log(`${bold("Total")}        ${usd(p.totalUsd)}\n`);
  for (const h of p.holdings.slice(0, 15)) {
    const w = p.totalUsd > 0 ? (h.usdValue / p.totalUsd) * 100 : 0;
    console.log(
      `  ${(h.token.symbol ?? h.token.address.slice(0, 8) + "…").padEnd(12)} ` +
        `${usd(h.usdValue).padStart(14)}  ${w.toFixed(2).padStart(6)}%`,
    );
  }
  if (p.holdings.length > 15) console.log(dim(`  … and ${p.holdings.length - 15} more`));
  console.log();
}

async function simulate(cycles: number) {
  requireLeader();
  const adapter = buildAdapter();
  const policy = makePolicy(String(flags.name ?? "sim-vault"), LEADER, {
    sizing: { exposureScalar: Number(flags.scalar ?? 1) },
    safety: { requireHolderData: flags["allow-blind-holders"] !== "true" },
    execution: {
      // Replaying history means every trade is stale by definition. Raising the
      // age limit is what makes a simulation a simulation; it is deliberately
      // not something `watch` exposes.
      maxTradeAgeMs: Number(flags["max-age"] ?? 20) * 1000,
    },
  });
  const leaderBook = await adapter.data.portfolio(LEADER);
  const state = initialState(emptyVaultState(EQUITY), leaderBook.totalUsd, Date.now());

  console.log(`\n${bold("fomo-vaults")} ${dim("· dry-run simulation")}`);
  console.log(`  leader        ${LEADER}`);
  console.log(`  leader book   ${usd(leaderBook.totalUsd)}`);
  console.log(`  vault equity  ${usd(EQUITY)}`);
  console.log(`  exposure      ${policy.sizing.exposureScalar}x`);
  console.log(dim(`  reading last ${flags.limit ?? 25} signatures via ${RPC}\n`));

  for (let i = 0; i < cycles; i++) {
    const report = await tick({ adapter, policy, state, dryRun: true });
    render(report);
  }
}

async function watch() {
  requireLeader();
  const adapter = buildAdapter();
  const policy = makePolicy(String(flags.name ?? "watch-vault"), LEADER, {
    sizing: { exposureScalar: Number(flags.scalar ?? 1) },
  });
  const leaderBook = await adapter.data.portfolio(LEADER);
  const state = initialState(emptyVaultState(EQUITY), leaderBook.totalUsd, Date.now());
  const intervalMs = Number(flags.interval ?? 10) * 1000;

  console.log(`\n${bold("fomo-vaults")} ${LIVE ? red("· LIVE") : dim("· dry-run")}`);
  console.log(`  polling every ${intervalMs / 1000}s. Ctrl-C to stop.\n`);
  if (LIVE) console.log(red("  Live mode: this will sign and broadcast real transactions.\n"));

  // Prime the cursor so a fresh start does not replay the leader's history.
  const primed = await adapter.watcher.poll(null);
  state.cursor = primed.cursor;
  console.log(dim(`  cursor primed at ${primed.cursor?.slice(0, 16) ?? "head"}…\n`));

  for (;;) {
    try {
      const report = await tick({ adapter, policy, state, dryRun: !LIVE });
      if (report.plan.intents.length > 0) render(report);
    } catch (err) {
      console.error(red(`  tick failed: ${(err as Error).message}`));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function render(report: Awaited<ReturnType<typeof tick>>) {
  const { plan, executions } = report;
  if (!plan.breaker.pass) {
    console.log(red(`  ⛔ breaker ${plan.breaker.code}: ${plan.breaker.reason}`));
  }
  if (plan.intents.length === 0) {
    console.log(dim("  no leader trades in range"));
    return;
  }

  for (const intent of plan.intents) {
    if (intent.kind === "skip") {
      console.log(`  ${dim("skip")}  ${pad(intent.code, 22)} ${dim(intent.reason)}`);
      continue;
    }
    const sym = intent.asset.symbol ?? intent.asset.address.slice(0, 8) + "…";
    const exec = executions.find((e) => e.intentId === intent.sourceTradeId);
    const status = exec?.ok ? green("ok") : exec ? red(exec.error ?? "failed") : dim("planned");
    if (intent.kind === "buy") {
      console.log(`  ${green("BUY ")}  ${pad(sym, 22)} ${usd(intent.usdSize).padStart(12)}  ${status}`);
    } else {
      console.log(`  ${red("SELL")}  ${pad(sym, 22)} ${(intent.fraction * 100).toFixed(1).padStart(11)}%  ${status}`);
    }
    console.log(dim(`        ${intent.rationale}`));
  }
  console.log();
}

function help() {
  console.log(`
${bold("fomo-vaults")} — pooled copy-trading vaults over fomo leader wallets

  ${bold("inspect")}   --leader <address>
            Value a leader's book and show their portfolio weights.

  ${bold("simulate")}  --leader <address> [--equity 50000] [--scalar 1] [--limit 25]
            Replay their recent swaps against a hypothetical vault and print
            exactly what the vault would have done, and why it skipped the rest.

  ${bold("watch")}     --leader <address> [--equity 50000] [--interval 10] [--live true]
            Poll continuously. Dry-run unless --live is set AND
            SOLANA_VAULT_PRIVATE_KEY is present.

  ${bold("profile")}   [--candidates <addr,...>] [--pages 12] [--out state/profiles] [--no-prices]
            Build full ability profiles (Edge Score, 5 dimensions, 10 metrics).
            Historical candles come from FOMV_PRICE_FEED (default geckoterminal,
            no key required; set BIRDEYE_API_KEY for better coverage).
            --no-prices falls back to the trader's own fills and says so.
            and write them as JSON for the dashboard to serve.

  ${bold("score")}     --candidates <addr,addr,...> [--pages 8] [--seats 3] [--limit 25]
            Grade candidate leaders on copyability and propose a FOMV roster.
            Read-only. Needs an RPC that serves batched transaction reads.

  ${dim("env: SOLANA_RPC_URL, SOLANA_TX_RPC_URL, LEADER_ADDRESS, JUPITER_API_URL,")}
  ${dim("     JUPITER_API_KEY,")}
  ${dim("     SOLANA_VAULT_PRIVATE_KEY (base58 or JSON array), MODE=live")}
`);
}

/**
 * Grade candidate leaders and propose a roster.
 *
 * Read-only and never signs anything: this is the step that happens before a
 * vault exists, so there is nothing yet to be careful with.
 */
async function score() {
  const candidates = (flags.candidates ?? LEADER)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  if (candidates.length === 0) {
    console.error("score: pass --candidates <addr,addr,...> or set LEADER_ADDRESS");
    process.exit(1);
  }

  const conn = new Connection(RPC, "confirmed");
  const txConn = TX_RPC === RPC ? conn : new Connection(TX_RPC, "confirmed");
  const data = new SolanaMarketData(conn);
  const maxPages = Number(flags.pages ?? 8);
  const seats = Number(flags.seats ?? DEFAULT_SHORTLIST.seats);

  console.log(`\n${bold("Scoring")} ${candidates.length} candidate(s) over up to ${maxPages} pages each\n`);

  const scored: { address: string; score: Awaited<ReturnType<typeof scoreCandidate>>["score"] }[] = [];
  for (const address of candidates) {
    process.stdout.write(`  ${address.slice(0, 8)}…  `);
    try {
      const res = await scoreCandidate({
        address,
        watcher: new Watcher(txConn, address, data, {
          limit: Number(flags.limit ?? 25),
          batchSize: Number(flags.batch ?? 5),
          throttleMs: Number(flags.throttle ?? 150),
        }),
        data,
        maxPages,
        onPage: (_n, total) => process.stdout.write(`
  ${address.slice(0, 8)}…  ${total} swaps`),
      });
      console.log(
        `
  ${address.slice(0, 8)}…  ${String(res.trades).padStart(4)} swaps, ` +
          `${res.coverage} tokens priced, book ${res.equityUsd === null ? "unknown" : usd(res.equityUsd)} ` +
          `→ ${dim(res.score.grade)}`,
      );
      if (res.truncated) console.log(`        ${dim("history truncated -- " + res.truncated)}`);
      scored.push({ address, score: res.score });
    } catch (err) {
      console.log(`
  ${address.slice(0, 8)}…  ${dim(`failed: ${String(err)}`)}`);
    }
  }

  if (scored.length === 0) {
    console.error("\nNo candidate could be scored. Check SOLANA_TX_RPC_URL; free endpoints refuse batched reads.");
    process.exit(1);
  }

  const results = shortlist(scored, { ...DEFAULT_SHORTLIST, seats });

  console.log(`\n${bold("Roster proposal")}  ${seats} seat(s)\n`);
  for (const c of results) {
    const mark = c.verdict === "list" ? "LIST " : c.verdict === "watch" ? "WATCH" : "PASS ";
    const composite = c.score.composite === null ? "  — " : c.score.composite.toFixed(0).padStart(4);
    const cap = c.score.capacityUsd === null ? "unknown" : usd(c.score.capacityUsd);
    console.log(`  ${bold(mark)} ${c.address}`);
    console.log(`        grade ${c.score.grade.padEnd(18)} composite ${composite}    capacity ${cap}`);
    const comp = c.score.components;
    const part = (label: string, v: number | null) =>
      `${label} ${v === null ? " -- " : v.toFixed(0).padStart(3)}`;
    console.log(
      `        ${dim(
        [
          part("perf", comp.performance),
          part("capacity", comp.capacity),
          part("latency", comp.latency),
          part("process", comp.process),
          part("hygiene", comp.hygiene),
        ].join("   "),
      )}`,
    );
    const raw = c.score.raw;
    console.log(
      `        ${dim(
        `${raw.episodes} episodes, ${raw.performance.closedEpisodes} closed  ` +
          `win ${(raw.performance.winRate * 100).toFixed(0)}%  ` +
          `net $${raw.performance.netPnlUsd.toFixed(0)}  ` +
          `fee drag ${raw.performance.feeDragBps.toFixed(0)}bps`,
      )}`,
    );
    for (const r of c.reasons) console.log(`        ${dim("· " + r)}`);
    console.log("");
  }

  console.log(
    dim(
      "  Capacity is computed against today's pools, not the pools at the time of each\n" +
        "  trade. Read it as an order of magnitude.\n",
    ),
  );
}

/**
 * Compute ability profiles and write them to `state/profiles/`.
 *
 * Written to disk rather than computed on request because a profile costs
 * hundreds of RPC calls and several minutes. The dashboard reads the file; a
 * scheduled run of this command is what keeps it fresh. Making that a
 * deliberate step also means the numbers on the site are reproducible -- there
 * is a file you can diff.
 */
async function profile() {
  const addresses = (flags.candidates ?? LAUNCH_ROSTER.map((r) => r.leader).join(","))
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  if (addresses.length === 0) {
    console.error("profile: no addresses; pass --candidates or add entries to src/platform/roster.ts");
    process.exit(1);
  }

  const conn = new Connection(RPC, "confirmed");
  const txConn = TX_RPC === RPC ? conn : new Connection(TX_RPC, "confirmed");
  const data = new SolanaMarketData(conn);
  const outDir = flags.out ?? "state/profiles";
  const maxPages = Number(flags.pages ?? 12);
  await mkdir(outDir, { recursive: true });

  // Candles are what make entry and exit quality measurements rather than
  // restatements of the trade log. `--no-prices` is for working offline; the
  // provenance records which path was taken either way.
  const priceFeed = flags["no-prices"] ? null : priceFeedFromEnv();
  console.log(
    `  prices   ${priceFeed ? priceFeed.name : dim("observed fills only - entry and exit quality will be biased")}\n`,
  );

  for (const address of addresses) {
    const handle = LAUNCH_ROSTER.find((r) => r.leader === address)?.handle;
    process.stdout.write(`  ${handle ?? address.slice(0, 8)}  `);
    try {
      const res = await buildTraderProfile({
        address,
        handle,
        watcher: new Watcher(txConn, address, data, {
          limit: Number(flags.limit ?? 100),
          batchSize: Number(flags.batch ?? 5),
          throttleMs: Number(flags.throttle ?? 150),
        }),
        data,
        maxPages,
        priceFeed,
        onPage: (_p, total) =>
          process.stdout.write(`\r  ${(handle ?? address.slice(0, 8)).padEnd(16)} ${total} swaps            `),
        onCandles: (token: string, n: number) =>
          process.stdout.write(
            `\r  ${(handle ?? address.slice(0, 8)).padEnd(16)} candles ${token.slice(0, 6)}\u2026 ${n}        `,
          ),
      });

      const file = `${outDir}/${address}.json`;
      await writeFile(file, JSON.stringify(res, null, 2));
      const p = res.profile;
      const src = res.provenance.priceSource;
      process.stdout.write("\r");
      console.log(
        `
  ${(handle ?? address.slice(0, 8)).padEnd(16)} ` +
          `edge ${p.edgeScore === null ? " -- " : p.edgeScore.toFixed(0).padStart(3)}  ` +
          `${p.grade.padEnd(18)} ${res.provenance.trades} swaps, ` +
          `${p.core.closedEpisodes} closed  -> ${file}`,
      );
      console.log(
        `      ${dim(
          src.degraded
            ? "prices: observed fills only"
            : `prices: ${src.feed} ${src.resolution}, ${src.candles} candles over ` +
              `${src.tokensCovered}/${src.tokensRequested} tokens`,
        )}`,
      );
      for (const g of p.gaps) console.log(`      ${dim("gap: " + g)}`);
      for (const f of p.flags) console.log(`      ${dim("flag: " + f)}`);
    } catch (err) {
      console.log(`
  ${address.slice(0, 8)}  ${dim(`failed: ${String(err)}`)}`);
    }
  }
}

function requireLeader() {
  if (!LEADER) {
    console.error(red("A leader address is required: --leader <address> or LEADER_ADDRESS."));
    process.exit(1);
  }
}

function decodeKey(raw: string): Uint8Array {
  const t = raw.trim();
  if (t.startsWith("[")) return Uint8Array.from(JSON.parse(t) as number[]);
  // base58 without pulling in a dependency for one call site
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const ch of t) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error("SOLANA_VAULT_PRIVATE_KEY is neither a JSON array nor base58");
    num = num * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of t) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

interface Args {
  _: string[];
  flags: Record<string, string | undefined>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = "true";
    } else out._.push(a);
  }
  return out;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

void tokenKey; // re-exported for consumers of this module's shape

main().catch((err) => {
  console.error(red(String(err instanceof Error ? err.stack ?? err.message : err)));
  process.exit(1);
});
