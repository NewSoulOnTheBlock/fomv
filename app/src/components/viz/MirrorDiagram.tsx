import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * What actually happens when you follow someone.
 *
 * # Why the hero is a diagram and not a sentence
 *
 * The single hardest thing to believe about this product is that a server can
 * trade your wallet without being able to take anything out of it. Written as
 * a sentence it is a claim, and a reader who does not already trust us has no
 * way to check it. Drawn as a mechanism it is a *shape*: the leader's swap
 * enters, passes a gate, and arrives at your wallet -- and the only line
 * leaving your wallet loops back to you, because there is nowhere else for it
 * to go. The absence is the argument, and an absence can be drawn.
 *
 * The pulses are not decoration either. They travel the same path a trade
 * does, they stop at the gate, and a rejected one dies there. Someone who
 * watches the hero for four seconds has seen the guardrails work.
 */
export function MirrorDiagram({ className }: { className?: string }) {
  const uid = useId().replace(/[:]/g, "");

  // One coordinate system for the whole drawing, so the pulse paths and the
  // boxes cannot drift apart when either is adjusted.
  const W = 760;
  const H = 210;
  const laneY = 105;

  const leader = { x: 20, y: laneY - 30, w: 150, h: 60 };
  const gate = { x: 300, y: laneY - 46, w: 160, h: 92 };
  const wallet = { x: 590, y: laneY - 30, w: 150, h: 60 };

  const inPath = `M ${leader.x + leader.w} ${laneY} L ${gate.x} ${laneY}`;
  const outPath = `M ${gate.x + gate.w} ${laneY} L ${wallet.x} ${laneY}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={cn("w-full h-auto", className)}
      role="img"
      aria-label="A leader's swap passes the published guardrails and is mirrored into your own wallet. Nothing leaves it."
    >
      <defs>
        <marker
          id={`arrow-${uid}`}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--faint)" />
        </marker>
        <filter id={`soft-${uid}`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Lanes. */}
      <path d={inPath} stroke="var(--rule)" strokeWidth="1" fill="none" markerEnd={`url(#arrow-${uid})`} />
      <path d={outPath} stroke="var(--rule)" strokeWidth="1" fill="none" markerEnd={`url(#arrow-${uid})`} />

      {/* Trades in flight. Staggered, so the lane is never empty and never busy. */}
      {[0, 1.9, 3.4].map((delay, i) => (
        <circle
          key={`in-${i}`}
          r="3"
          fill="var(--amber)"
          filter={`url(#soft-${uid})`}
          style={{
            offsetPath: `path("${inPath}")`,
            animation: `travel 2.6s ${delay}s linear infinite`,
          }}
        />
      ))}
      {[0.9, 2.8].map((delay, i) => (
        <circle
          key={`out-${i}`}
          r="3"
          fill="var(--pos)"
          filter={`url(#soft-${uid})`}
          style={{
            offsetPath: `path("${outPath}")`,
            animation: `travel 2.6s ${delay}s linear infinite`,
          }}
        />
      ))}

      <Box x={leader.x} y={leader.y} w={leader.w} h={leader.h} label="graded trader" value="their swap" />

      {/* The gate. Taller and amber-edged: it is the only thing here that decides. */}
      <g>
        <rect
          x={gate.x}
          y={gate.y}
          width={gate.w}
          height={gate.h}
          fill="var(--card)"
          stroke="var(--amber)"
          strokeWidth="1"
          opacity="0.95"
        />
        <text
          x={gate.x + gate.w / 2}
          y={gate.y + 20}
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize="9"
          letterSpacing="0.16em"
          fill="var(--amber)"
        >
          GUARDRAILS
        </text>
        {["size ≤ 15% of book", "liquidity ≥ $25k", "drift ≤ 3%"].map((line, i) => (
          <text
            key={line}
            x={gate.x + 12}
            y={gate.y + 40 + i * 15}
            fontFamily="var(--font-mono)"
            fontSize="9.5"
            fill="var(--muted-foreground)"
          >
            {line}
          </text>
        ))}
      </g>

      <Box x={wallet.x} y={wallet.y} w={wallet.w} h={wallet.h} label="your wallet" value="your keys" accent />

      {/* The line that does not exist. */}
      <g>
        <path
          d={`M ${wallet.x + wallet.w / 2} ${wallet.y + wallet.h} q 0 34 -40 34 L ${gate.x + gate.w + 26} ${laneY + 60}`}
          stroke="var(--rule)"
          strokeWidth="1"
          strokeDasharray="3 4"
          fill="none"
        />
        <text
          x={gate.x + gate.w + 20}
          y={laneY + 64}
          textAnchor="end"
          fontFamily="var(--font-mono)"
          fontSize="9"
          letterSpacing="0.1em"
          fill="var(--faint)"
        >
          NO PATH OUT — FOMV CANNOT TRANSFER
        </text>
      </g>
    </svg>
  );
}

function Box({
  x,
  y,
  w,
  h,
  label,
  value,
  accent,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="var(--card)"
        stroke={accent ? "var(--pos)" : "var(--rule)"}
        strokeWidth="1"
        opacity={accent ? 0.9 : 1}
      />
      <text
        x={x + 12}
        y={y + 24}
        fontFamily="var(--font-mono)"
        fontSize="9"
        letterSpacing="0.16em"
        fill="var(--faint)"
      >
        {label.toUpperCase()}
      </text>
      <text
        x={x + 12}
        y={y + 43}
        fontFamily="var(--font-mono)"
        fontSize="12"
        fill={accent ? "var(--pos)" : "var(--foreground)"}
      >
        {value}
      </text>
    </g>
  );
}
