/**
 * FOMV platform configuration.
 *
 * A vault's `VaultPolicy` is the *operator's* dial set. This is the
 * *platform's*, and the two are deliberately separate types: nothing a leader
 * configures about their own vault may change what FOMV charges, and nothing
 * FOMV charges may change how a leader's strategy trades.
 */

/**
 * Hard ceiling on the withdrawal fee. Mirrors `MAX_WITHDRAW_FEE_BPS` in
 * `onchain/programs/fomo-vault/src/platform.rs`, where it is the binding one.
 *
 * Duplicated rather than imported because the on-chain constant is the only
 * one a depositor can actually verify; this copy exists so the app refuses to
 * build a transaction the program would reject anyway.
 */
export const MAX_WITHDRAW_FEE_BPS = 200;

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface PlatformConfig {
  /** Display name. */
  name: string;
  /** Receives listing fees in SOL and withdrawal fees as vault shares. */
  treasury: string;
  /** May reprice fees and list vaults. Never has custody of vault assets. */
  authority: string;

  /**
   * Protocol skim on every withdrawal, in bps, taken in shares.
   *
   * Applies to vaults listed from this point on. A live vault keeps the figure
   * it was listed under, so repricing never reaches a depositor who is already
   * in — see `VaultListing.withdrawFeeBps`.
   */
  withdrawFeeBps: number;

  /** One-off charge for a trader to be listed, in lamports. */
  listingFeeLamports: bigint;

  /** Stops new listings without touching live vaults. */
  listingsPaused: boolean;

  /**
   * How many vaults may be live at once.
   *
   * A cap, not a limitation: the platform's claim is that these leaders were
   * *chosen*, and a roster that accepts everyone who pays cannot make that
   * claim. Raising this is a product decision, not an ops one.
   */
  maxLiveVaults: number;
}

export const DEFAULT_PLATFORM: PlatformConfig = {
  name: "FOMV",
  treasury: "",
  authority: "",
  withdrawFeeBps: 100,
  listingFeeLamports: 5n * LAMPORTS_PER_SOL,
  listingsPaused: false,
  maxLiveVaults: 3,
};

export function makePlatformConfig(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  const cfg: PlatformConfig = { ...DEFAULT_PLATFORM, ...overrides };
  validatePlatformConfig(cfg);
  return cfg;
}

export function validatePlatformConfig(cfg: PlatformConfig): void {
  const errs: string[] = [];

  if (!cfg.name.trim()) errs.push("name must not be empty");
  if (!cfg.treasury.trim()) errs.push("treasury must be set before any fee can be collected");
  if (!cfg.authority.trim()) errs.push("authority must not be empty");

  if (!Number.isInteger(cfg.withdrawFeeBps) || cfg.withdrawFeeBps < 0) {
    errs.push(`withdrawFeeBps must be a non-negative integer, got ${cfg.withdrawFeeBps}`);
  } else if (cfg.withdrawFeeBps > MAX_WITHDRAW_FEE_BPS) {
    errs.push(
      `withdrawFeeBps (${cfg.withdrawFeeBps}) exceeds the protocol ceiling of ${MAX_WITHDRAW_FEE_BPS}; ` +
        `the program would reject this listing`,
    );
  }

  if (cfg.listingFeeLamports < 0n) errs.push(`listingFeeLamports must be >= 0, got ${cfg.listingFeeLamports}`);

  if (!Number.isInteger(cfg.maxLiveVaults) || cfg.maxLiveVaults < 1) {
    errs.push(`maxLiveVaults must be a positive integer, got ${cfg.maxLiveVaults}`);
  }

  if (errs.length) throw new Error(`Invalid platform config:\n  - ${errs.join("\n  - ")}`);
}

/**
 * Build the platform config from the environment.
 *
 * Throws rather than falling back to defaults for the two values that have no
 * safe default: a missing treasury means fees would be sent nowhere, and a
 * missing authority means nobody can list a vault. Everything else has a
 * sensible default and is allowed to be absent.
 */
export function platformFromEnv(env: Record<string, string | undefined> = process.env): PlatformConfig {
  const num = (raw: string | undefined, fallback: number, label: string): number => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const v = Number(raw);
    if (!Number.isInteger(v)) throw new Error(`${label} must be an integer, got ${JSON.stringify(raw)}`);
    return v;
  };

  const lamports = (raw: string | undefined, fallback: bigint, label: string): bigint => {
    if (raw === undefined || raw.trim() === "") return fallback;
    try {
      return BigInt(raw.trim());
    } catch {
      throw new Error(`${label} must be an integer number of lamports, got ${JSON.stringify(raw)}`);
    }
  };

  return makePlatformConfig({
    treasury: env.FOMV_TREASURY ?? "",
    authority: env.FOMV_AUTHORITY ?? "",
    withdrawFeeBps: num(env.FOMV_WITHDRAW_FEE_BPS, DEFAULT_PLATFORM.withdrawFeeBps, "FOMV_WITHDRAW_FEE_BPS"),
    listingFeeLamports: lamports(
      env.FOMV_LISTING_FEE_LAMPORTS,
      DEFAULT_PLATFORM.listingFeeLamports,
      "FOMV_LISTING_FEE_LAMPORTS",
    ),
  });
}

/** Listing fee in SOL, for display. Never used for maths. */
export function listingFeeSol(cfg: PlatformConfig): number {
  return Number(cfg.listingFeeLamports) / Number(LAMPORTS_PER_SOL);
}
