/**
 * Fixed-point decimal arithmetic on bigint, scaled 1e18.
 *
 * The share ledger is the one place in this system where floating point is
 * genuinely unsafe: a 1e-16 rounding error repeated across thousands of
 * deposits silently mints shares out of nothing, and every existing depositor
 * pays for it. Position sizing tolerates float (the DEX rounds to token
 * decimals anyway); share issuance does not.
 */

export type Fx = bigint;

export const DECIMALS = 18;
export const ONE: Fx = 10n ** BigInt(DECIMALS);
export const ZERO: Fx = 0n;

export function fromString(s: string): Fx {
  const t = s.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error(`Fx.fromString: not a decimal: ${JSON.stringify(s)}`);
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1) : t;
  const dot = body.indexOf(".");
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracRaw = dot === -1 ? "" : body.slice(dot + 1);
  // Truncate rather than round: never conjure value that was not written down.
  const frac = (fracRaw + "0".repeat(DECIMALS)).slice(0, DECIMALS);
  const v = BigInt(intPart) * ONE + BigInt(frac);
  return neg ? -v : v;
}

export function fromNumber(n: number): Fx {
  if (!Number.isFinite(n)) throw new Error(`Fx.fromNumber: not finite: ${n}`);
  // Route through a decimal string so binary-float artifacts do not leak in.
  return fromString(n.toFixed(DECIMALS));
}

export function toNumber(x: Fx): number {
  return Number(x) / Number(ONE);
}

export function toString(x: Fx, dp = 6): string {
  if (dp < 0 || dp > DECIMALS) throw new Error(`Fx.toString: dp out of range: ${dp}`);
  const neg = x < 0n;
  const a = neg ? -x : x;
  const int = a / ONE;
  const frac = (a % ONE).toString().padStart(DECIMALS, "0").slice(0, dp);
  const sign = neg ? "-" : "";
  return dp === 0 ? `${sign}${int}` : `${sign}${int}.${frac}`;
}

/** Truncating multiply. Rounds toward zero. */
export function mul(a: Fx, b: Fx): Fx {
  return (a * b) / ONE;
}

/** Truncating divide. Rounds toward zero. */
export function div(a: Fx, b: Fx): Fx {
  if (b === 0n) throw new Error("Fx.div: divide by zero");
  return (a * ONE) / b;
}

function assertNonNeg(...xs: Fx[]): void {
  for (const x of xs) if (x < 0n) throw new Error(`Fx: expected non-negative, got ${toString(x)}`);
}

/**
 * floor(a * b / c) for non-negative inputs.
 * Use when issuing shares or paying a member out: rounding down keeps the
 * residual dust inside the pool, where it belongs to everyone.
 */
export function mulDivFloor(a: Fx, b: Fx, c: Fx): Fx {
  assertNonNeg(a, b, c);
  if (c === 0n) throw new Error("Fx.mulDivFloor: divide by zero");
  return (a * b) / c;
}

/**
 * ceil(a * b / c) for non-negative inputs.
 * Use when burning shares or charging a fee: rounding up means the pool is
 * never short-changed by the rounding.
 */
export function mulDivCeil(a: Fx, b: Fx, c: Fx): Fx {
  assertNonNeg(a, b, c);
  if (c === 0n) throw new Error("Fx.mulDivCeil: divide by zero");
  const n = a * b;
  return n === 0n ? 0n : (n - 1n) / c + 1n;
}

export function min(a: Fx, b: Fx): Fx {
  return a < b ? a : b;
}

export function max(a: Fx, b: Fx): Fx {
  return a > b ? a : b;
}

/** Basis points of a non-negative amount, rounded up (the pool's favour). */
export function bps(amount: Fx, basisPoints: number): Fx {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new Error(`Fx.bps: basisPoints must be a non-negative integer, got ${basisPoints}`);
  }
  return mulDivCeil(amount, BigInt(basisPoints) * ONE, 10_000n * ONE);
}
