import { useId, useMemo } from "react";

import { cn } from "@/lib/utils";
import { bandOf } from "@/lib/format";
import type { DimensionName } from "@/lib/types";

/**
 * The Edge Score, as an instrument face.
 *
 * # Why a pentagon and not five bars
 *
 * Five bars are five separate readings that happen to be stacked. The claim
 * this product makes is that skill has a *shape* -- that a trader who enters
 * well and exits badly is a different animal from one who is merely mediocre
 * at both, and that the shape is what a follower is buying. A polygon shows
 * the shape; bars show five numbers and leave the reader to build it.
 *
 * It is also the only mark on the site that is recognisable at 40px, which is
 * what lets the roster carry a miniature of each trader's whole profile in a
 * table cell.
 *
 * # The honesty rule, made visual
 *
 * Everywhere else in this app an unmeasured value is an em dash. Here it is a
 * hatched wedge. A radar chart's natural failure mode is to plot a missing
 * axis at the origin, which draws a confident spike *inward* -- indistinguish-
 * able from a measured zero, and far more damning than one. So the polygon is
 * not a polygon at all: it is the union of triangles between *adjacent pairs
 * of measured axes*. Where a dimension is missing, no triangle is drawn and
 * the gap is left open with the hatching behind it. A trader with two gaps
 * gets a shape with two bites out of it, which is exactly what the data says.
 */

export interface EdgeDimension {
  key: DimensionName;
  /** Three-letter code at the vertex. Legible at any size, unlike an emoji. */
  code: string;
  label: string;
  value: number | null;
}

/** Clockwise from the top. The order is fixed so the shape is comparable. */
export const PENTAGON_ORDER: DimensionName[] = [
  "profitability",
  "risk",
  "consistency",
  "exit",
  "entry",
];

const RINGS = [0.2, 0.4, 0.6, 0.8, 1];

export function EdgePentagon({
  dimensions,
  score,
  size = 320,
  labels = true,
  className,
}: {
  dimensions: EdgeDimension[];
  /** Colours the plot by the overall grade band. */
  score: number | null;
  size?: number;
  labels?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/[:]/g, "");
  const band = bandOf(score);

  // The label ring sits outside the plot, so the plot itself shrinks to make
  // room rather than the labels being clipped by the viewBox.
  const pad = labels ? 40 : 6;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - pad;

  const geometry = useMemo(() => {
    const n = dimensions.length;
    return dimensions.map((d, i) => {
      // -90deg puts the first axis at twelve o'clock.
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const unit = { x: Math.cos(angle), y: Math.sin(angle) };
      const frac = d.value === null ? 0 : Math.max(0, Math.min(100, d.value)) / 100;
      return {
        ...d,
        angle,
        unit,
        outer: { x: cx + unit.x * r, y: cy + unit.y * r },
        point: { x: cx + unit.x * r * frac, y: cy + unit.y * r * frac },
        // A measured zero still needs a visible vertex, or it is indis-
        // tinguishable from the hatching it sits under.
        measured: d.value !== null,
      };
    });
  }, [dimensions, cx, cy, r]);

  /** Triangles between adjacent measured axes. The gaps are the point. */
  const wedges = geometry
    .map((a, i) => [a, geometry[(i + 1) % geometry.length]!] as const)
    .filter(([a, b]) => a.measured && b.measured)
    .map(([a, b]) => `M ${cx} ${cy} L ${a.point.x} ${a.point.y} L ${b.point.x} ${b.point.y} Z`);

  /** The outline, drawn only across runs of measured axes. */
  const outline = geometry
    .map((a, i) => [a, geometry[(i + 1) % geometry.length]!] as const)
    .filter(([a, b]) => a.measured && b.measured)
    .map(([a, b]) => `M ${a.point.x} ${a.point.y} L ${b.point.x} ${b.point.y}`)
    .join(" ");

  const ringPath = (frac: number) =>
    geometry
      .map((g, i) => `${i === 0 ? "M" : "L"} ${cx + g.unit.x * r * frac} ${cy + g.unit.y * r * frac}`)
      .join(" ") + " Z";

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className={cn("overflow-visible", className)}
      role="img"
      aria-label={
        dimensions
          .map((d) => `${d.label} ${d.value === null ? "not measured" : Math.round(d.value)}`)
          .join(", ") || "no dimensions"
      }
    >
      <defs>
        <pattern
          id={`hatch-${uid}`}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--band-none)" strokeWidth="1.1" />
        </pattern>
        <radialGradient id={`fill-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={`var(--band-${band})`} stopOpacity="0.42" />
          <stop offset="100%" stopColor={`var(--band-${band})`} stopOpacity="0.13" />
        </radialGradient>
        <filter id={`glow-${uid}`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Hatching for every unmeasured sector, underneath everything. */}
      {geometry.map((g, i) => {
        if (g.measured) return null;
        const prev = geometry[(i - 1 + geometry.length) % geometry.length]!;
        const next = geometry[(i + 1) % geometry.length]!;
        const mid = (a: typeof g, b: typeof g) => ({
          x: cx + ((a.unit.x + b.unit.x) / 2) * r,
          y: cy + ((a.unit.y + b.unit.y) / 2) * r,
        });
        const m1 = mid(prev, g);
        const m2 = mid(g, next);
        return (
          <path
            key={`gap-${g.key}`}
            d={`M ${cx} ${cy} L ${m1.x} ${m1.y} L ${g.outer.x} ${g.outer.y} L ${m2.x} ${m2.y} Z`}
            fill={`url(#hatch-${uid})`}
            opacity={0.5}
          />
        );
      })}

      {/* Calibration rings. Every 20 points, like a gauge face. */}
      {RINGS.map((frac) => (
        <path
          key={frac}
          d={ringPath(frac)}
          fill="none"
          stroke="var(--grid)"
          strokeWidth={frac === 1 ? 1.2 : 1}
        />
      ))}

      {/* Spokes. */}
      {geometry.map((g) => (
        <line
          key={`spoke-${g.key}`}
          x1={cx}
          y1={cy}
          x2={g.outer.x}
          y2={g.outer.y}
          stroke="var(--grid)"
          strokeWidth="1"
        />
      ))}

      {/* The reading. */}
      {wedges.map((d, i) => (
        <path key={`w${i}`} d={d} fill={`url(#fill-${uid})`} />
      ))}
      {outline && (
        <path
          d={outline}
          fill="none"
          stroke={`var(--band-${band})`}
          strokeWidth="1.6"
          strokeLinejoin="round"
          filter={`url(#glow-${uid})`}
        />
      )}

      {/* A vertex dot per measured axis, so a zero is still visible. */}
      {geometry
        .filter((g) => g.measured)
        .map((g) => (
          <circle
            key={`dot-${g.key}`}
            cx={g.point.x}
            cy={g.point.y}
            r={size > 120 ? 3 : 2}
            fill={`var(--band-${band})`}
          />
        ))}

      {labels &&
        geometry.map((g) => {
          const lx = cx + g.unit.x * (r + 22);
          const ly = cy + g.unit.y * (r + 22);
          return (
            <g key={`label-${g.key}`}>
              <text
                x={lx}
                y={ly}
                textAnchor="middle"
                dominantBaseline="middle"
                fontFamily="var(--font-mono)"
                fontSize="10"
                letterSpacing="0.14em"
                fill={g.measured ? "var(--muted-foreground)" : "var(--faint)"}
              >
                {g.code}
              </text>
              <text
                x={lx}
                y={ly + 13}
                textAnchor="middle"
                dominantBaseline="middle"
                fontFamily="var(--font-mono)"
                fontSize="11"
                fill={g.measured ? `var(--band-${bandOf(g.value)})` : "var(--faint)"}
              >
                {g.value === null ? "—" : Math.round(g.value)}
              </text>
            </g>
          );
        })}
    </svg>
  );
}

/**
 * The same instrument at table size.
 *
 * No rings, no labels, heavier stroke: at 44px the calibration web turns into
 * a grey blob and the only thing that survives is the silhouette -- which is
 * the one thing worth carrying into a list anyway.
 */
export function EdgeGlyph({
  dimensions,
  score,
  size = 44,
  className,
}: {
  dimensions: EdgeDimension[];
  score: number | null;
  size?: number;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)} style={{ width: size, height: size }}>
      <EdgePentagon dimensions={dimensions} score={score} size={size} labels={false} />
    </div>
  );
}
