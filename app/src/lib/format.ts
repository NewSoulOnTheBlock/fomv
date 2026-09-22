/**
 * Display helpers.
 *
 * One rule runs through all of them: `null` renders as an em dash, never as
 * zero and never as a blank. A dashboard whose gaps look like measurements is
 * worse than one with visible holes, and this is the last place that guarantee
 * can be lost.
 */

export const EMPTY = "—";

export function usd(v: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (opts.compact && abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (opts.compact && abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: abs < 100 ? 2 : 0 })}`;
}

export function pct(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  return `${(v * 100).toFixed(dp)}%`;
}

export function ratio(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  return v.toFixed(dp);
}

export function score(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  return Math.round(v).toString();
}

export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return EMPTY;
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

export function shortAddress(a: string, lead = 4, tail = 4): string {
  return a.length <= lead + tail + 1 ? a : `${a.slice(0, lead)}…${a.slice(-tail)}`;
}

export function dateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EMPTY;
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relative(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EMPTY;
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

/** Span between two moments, for the provenance line. */
export function span(fromMs: number | null, toMs: number | null): string {
  if (fromMs === null || toMs === null) return EMPTY;
  const hours = (toMs - fromMs) / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

export function bps(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EMPTY;
  return `${(v / 100).toFixed(v % 100 === 0 ? 0 : 2)}%`;
}

/** Colour band for a 0-100 score. Returns a CSS custom-property name. */
export function bandOf(v: number | null): "good" | "ok" | "warn" | "bad" | "none" {
  if (v === null || !Number.isFinite(v)) return "none";
  if (v >= 80) return "good";
  if (v >= 65) return "ok";
  if (v >= 45) return "warn";
  return "bad";
}
