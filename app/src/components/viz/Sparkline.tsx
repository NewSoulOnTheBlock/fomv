import { cn } from "@/lib/utils";

/**
 * A cumulative P&L curve, small enough for a table row.
 *
 * Drawn from the per-period buckets the profile already carries, accumulated
 * rather than plotted as bars. The question a reader asks of a roster row is
 * "did this go up", and a run of independent bars does not answer it -- a
 * trader with three good weeks and four bad ones looks busy either way, and
 * only the running total says which won.
 *
 * Deliberately unlabelled and unscaled. At this size an axis would be
 * illegible and a number would be a claim; the shape is the whole content.
 */
export function Sparkline({
  values,
  width = 96,
  height = 26,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) return null;

  let running = 0;
  const cumulative = values.map((v) => (running += v));

  const min = Math.min(0, ...cumulative);
  const max = Math.max(0, ...cumulative);
  const span = max - min || 1;

  const x = (i: number) => (i / (cumulative.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2);

  const line = cumulative.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const last = cumulative[cumulative.length - 1]!;
  const tone = last >= 0 ? "var(--pos)" : "var(--neg)";
  const zeroY = y(0);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
      aria-hidden
    >
      <line x1="0" y1={zeroY} x2={width} y2={zeroY} stroke="var(--grid)" strokeWidth="1" />
      <path d={`${line} L ${width - 1} ${zeroY} L 1 ${zeroY} Z`} fill={tone} opacity="0.1" />
      <path d={line} fill="none" stroke={tone} strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx={x(cumulative.length - 1)} cy={y(last)} r="1.9" fill={tone} />
    </svg>
  );
}
