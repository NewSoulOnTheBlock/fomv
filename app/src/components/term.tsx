import { type ReactNode } from "react";

import { Figure } from "@/components/Figure";
import { cn } from "@/lib/utils";
import { EMPTY, bandOf } from "@/lib/format";

/**
 * The vocabulary the whole interface is written in.
 *
 * # Two voices, one rule
 *
 * Prose and headings are set in the sans; anything *measured* is set in the
 * mono, or in the sans with tabular figures when it needs to be large. The
 * split is what lets a reader tell a claim from a reading without being told,
 * and it survived the move from a terminal look to a material one because it
 * was never about the terminal.
 *
 * # There are no badges
 *
 * Status is a field like any other and is set as one. What is left is a single
 * lit lamp for the one state on a page that is genuinely live; if two ever
 * appear at once, one of them is wrong.
 */

/* ---------------------------------------------------------------- panels -- */

export function Panel({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & React.ComponentProps<"section">) {
  return (
    <section className={cn("material rounded-xl", className)} {...rest}>
      {children}
    </section>
  );
}

/** A panel's title bar: a label on the left, an optional readout on the right. */
export function PanelHead({
  label,
  aside,
  className,
}: {
  label: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[46px] items-center justify-between gap-3 border-b border-separator px-5 py-3",
        className,
      )}
    >
      <span className="term-label truncate">{label}</span>
      {aside !== undefined && (
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{aside}</span>
      )}
    </div>
  );
}

export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("p-5", className)}>{children}</div>;
}

/**
 * A page-level section heading.
 *
 * Numbered, because the trader page is an assay with sections rather than a
 * feed with headings, and a reader who scrolls back should be able to find
 * their place by index rather than by remembering a phrase.
 */
export function SectionRule({
  index,
  children,
  aside,
  className,
}: {
  index?: string;
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 mt-16 flex items-center gap-4", className)}>
      <h2 className="flex items-center gap-3">
        {index && (
          <span className="rounded-md bg-primary/12 px-2 py-0.5 font-mono text-[11px] text-primary">
            {index}
          </span>
        )}
        <span className="text-[clamp(1.35rem,2.2vw,1.75rem)] font-semibold">{children}</span>
      </h2>
      {aside && <span className="term-label ml-auto shrink-0">{aside}</span>}
    </div>
  );
}

/* ------------------------------------------------------------ statistics -- */

export function Stat({
  label,
  value,
  sub,
  tone,
  size = "md",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** Reserved for signed quantities and score bands. Never for emphasis. */
  tone?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizes = {
    sm: "text-[17px] font-medium",
    md: "text-[24px] font-semibold",
    lg: "text-[clamp(2.75rem,5vw,3.75rem)] font-semibold",
  } as const;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="term-label truncate">{label}</div>
      <div
        className={cn("tnum mt-2 leading-[1.05] tracking-[-0.035em]", sizes[size])}
        style={tone ? { color: tone } : undefined}
      >
        {/* Strings go through `Figure` so the reading settles; anything else
            is already a node the caller composed and is left alone. */}
        {typeof value === "string" ? <Figure>{value}</Figure> : value}
      </div>
      {sub && <div className="mt-1.5 text-[12.5px] leading-snug text-faint">{sub}</div>}
    </div>
  );
}

/** A key and a value on one row, as a grouped list sets them. */
export function LeaderRow({
  label,
  value,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4 py-2.5 text-[14px]", className)}>
      <span className="min-w-0 text-muted-foreground">{label}</span>
      <span
        className="tnum shrink-0 font-medium"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * A run of facts as one line: `solana · listing approved · audited 3h ago`.
 *
 * This is what replaced the badges. The same words, in the same place, reading
 * as a byline instead of as six competing buttons.
 */
export function FactLine({
  facts,
  className,
}: {
  facts: (ReactNode | null | undefined | false)[];
  className?: string;
}) {
  const shown = facts.filter(Boolean);
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1", className)}>
      {shown.map((f, i) => (
        <span key={i} className="flex items-center gap-2.5">
          {i > 0 && (
            <span aria-hidden className="text-faint/50">
              ·
            </span>
          )}
          <span className="text-[13px] text-muted-foreground">{f}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * A lit indicator, for the one state on a page that is genuinely live.
 *
 * Deliberately the only thing left that resembles a badge, and deliberately
 * almost nothing: a dot and a word.
 */
export function Lamp({
  on = true,
  tone = "pos",
  children,
  className,
}: {
  on?: boolean;
  tone?: "pos" | "brand" | "neg";
  children: ReactNode;
  className?: string;
}) {
  const colour = tone === "pos" ? "var(--pos)" : tone === "neg" ? "var(--neg)" : "var(--brand)";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-separator bg-white/[0.04] px-2.5 py-1",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-[6px] rounded-full", on && "term-blink")}
        style={{
          background: on ? colour : "var(--faint)",
          boxShadow: on ? `0 0 10px ${colour}` : undefined,
        }}
      />
      <span
        className="font-mono text-[10.5px] uppercase tracking-[0.1em]"
        style={{ color: on ? colour : "var(--faint)" }}
      >
        {children}
      </span>
    </span>
  );
}

/* ----------------------------------------------------------------- bars -- */

/**
 * A 0-100 score as a capsule meter.
 *
 * The terminal pass drew this as twenty-eight discrete blocks, which quantised
 * the claim honestly and looked like a load gauge. A continuous track reads as
 * one quantity rather than a count, which is what a score is, and the figure
 * beside it carries the precision the bar no longer implies.
 *
 * `null` is hatched, never empty, because an empty track is indistinguishable
 * from a score of zero. That rule outranks any amount of tidiness.
 */
export function ScoreBar({
  value,
  className,
  animate = false,
}: {
  value: number | null;
  className?: string;
  /** Fill from the left on mount, in one spring. */
  animate?: boolean;
}) {
  const band = bandOf(value);
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));

  return (
    <div
      className={cn("material-inset h-2 overflow-hidden rounded-full", className)}
      role="img"
      aria-label={value === null ? "not measured" : `${Math.round(value)} out of 100`}
    >
      {value === null ? (
        <div
          className="h-full w-full opacity-70"
          style={{
            background:
              "repeating-linear-gradient(135deg, var(--band-none) 0 2px, transparent 2px 5px)",
          }}
        />
      ) : (
        <div
          className={cn("h-full rounded-full", animate && "meter-fill")}
          style={{
            width: `${Math.max(pct, 1.5)}%`,
            background: `linear-gradient(90deg, color-mix(in oklab, var(--band-${band}) 72%, transparent), var(--band-${band}))`,
            boxShadow: `0 0 12px color-mix(in oklab, var(--band-${band}) 45%, transparent)`,
          }}
        />
      )}
    </div>
  );
}

/** A small bar chart of signed buckets, for per-period P&L. */
export function BucketBars({ values, className }: { values: number[]; className?: string }) {
  const peak = Math.max(1, ...values.map((v) => Math.abs(v)));
  return (
    <div className={cn("flex h-14 items-center gap-[3px]", className)} aria-hidden>
      {values.map((v, i) => {
        const h = Math.max(3, (Math.abs(v) / peak) * 26);
        return (
          <div key={i} className="flex h-full min-w-[4px] max-w-[26px] flex-1 flex-col justify-center">
            <div className="flex flex-1 items-end">
              {v > 0 && <div className="w-full rounded-full bg-pos" style={{ height: h }} />}
            </div>
            <div className="h-px bg-separator" />
            <div className="flex flex-1 items-start">
              {v < 0 && <div className="w-full rounded-full bg-neg" style={{ height: h }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- states -- */

export function Callout({
  tone = "note",
  children,
  className,
}: {
  tone?: "note" | "warn" | "gap";
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    note: "bg-primary/[0.07] text-foreground",
    warn: "bg-warn/[0.08] text-foreground",
    gap: "bg-white/[0.035] text-muted-foreground",
  } as const;
  return (
    <div className={cn("rounded-lg px-4 py-3 text-[14px] leading-relaxed", tones[tone], className)}>
      {children}
    </div>
  );
}

/** The dash that stands for every unmeasured value in the app. */
export function Empty() {
  return <span className="text-faint">{EMPTY}</span>;
}
