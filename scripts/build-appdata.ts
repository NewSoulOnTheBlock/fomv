#!/usr/bin/env bun
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

import { DEFAULT_PLATFORM, LAMPORTS_PER_SOL, MAX_WITHDRAW_FEE_BPS } from "../src/platform/config.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { LAUNCH_ROSTER } from "../src/platform/roster.js";

/**
 * Generate the static data the FOMV app reads.
 *
 * The app is a static site on purpose. A profile costs hundreds of RPC calls
 * and several minutes to compute, so serving it live would mean either a slow
 * page or a cache pretending to be a live one. Writing files instead makes the
 * numbers on the site reproducible: there is a JSON you can diff, and the
 * timestamp in it is the honest answer to "how fresh is this".
 */

const PROFILES_IN = process.env.PROFILES_DIR ?? "state/profiles";
const OUT = process.env.APPDATA_DIR ?? "app/public/data";

/**
 * Whether the on-chain program exists.
 *
 * Derived from configuration rather than assumed, because every "deposit"
 * affordance in the UI keys off it. Defaulting this to true would produce a
 * front end that looks ready to take money and is not.
 */
const PROGRAM_DEPLOYED = process.env.FOMV_PROGRAM_DEPLOYED === "true";
const PROGRAM_ID = process.env.FOMV_PROGRAM_ID ?? null;

async function main() {
  await mkdir(`${OUT}/profiles`, { recursive: true });

  let copied = 0;
  let found: string[] = [];
  try {
    found = (await readdir(PROFILES_IN)).filter((f) => f.endsWith(".json"));
  } catch {
    console.warn(`  no profiles directory at ${PROFILES_IN}; the app will show empty vault cards`);
  }

  for (const file of found) {
    const body = await readFile(`${PROFILES_IN}/${file}`, "utf8");
    // Parsed and re-serialised rather than copied, so a malformed profile
    // fails here instead of in the browser.
    await writeFile(`${OUT}/profiles/${file}`, JSON.stringify(JSON.parse(body)));
    copied++;
  }

  const roster = LAUNCH_ROSTER.map((r) => ({
    handle: r.handle,
    leader: r.leader,
    chain: r.chain,
    // Without a deployed program no vault can be live, and saying otherwise in
    // the data file would put a Deposit button in front of a depositor.
    status: PROGRAM_DEPLOYED ? "live" : "approved",
    vaultAddress: null,
    withdrawFeeBps: DEFAULT_PLATFORM.withdrawFeeBps,
    performanceFeeBps: DEFAULT_POLICY.economics.performanceFeeBps,
    note: r.note,
    elsewhere: r.elsewhere,
  }));

  const app = {
    platform: {
      name: DEFAULT_PLATFORM.name,
      withdrawFeeBps: DEFAULT_PLATFORM.withdrawFeeBps,
      maxWithdrawFeeBps: MAX_WITHDRAW_FEE_BPS,
      listingFeeLamports: DEFAULT_PLATFORM.listingFeeLamports.toString(),
      listingFeeSol: Number(DEFAULT_PLATFORM.listingFeeLamports) / Number(LAMPORTS_PER_SOL),
      maxLiveVaults: DEFAULT_PLATFORM.maxLiveVaults,
      treasury: process.env.FOMV_TREASURY ?? null,
      programDeployed: PROGRAM_DEPLOYED,
      programId: PROGRAM_ID,
      cluster: process.env.SOLANA_CLUSTER ?? "mainnet-beta",
    },
    roster,
    generatedAtMs: Date.now(),
  };

  await writeFile(`${OUT}/app.json`, JSON.stringify(app, null, 2));

  console.log(`  ${OUT}/app.json  (${roster.length} vault${roster.length === 1 ? "" : "s"})`);
  console.log(`  ${OUT}/profiles  (${copied} profile${copied === 1 ? "" : "s"})`);
  if (!PROGRAM_DEPLOYED) {
    console.log("  programDeployed=false — the app will disable deposits and say why");
  }
}

await main();
