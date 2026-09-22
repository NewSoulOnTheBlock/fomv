import { type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { EMPTY, bandOf } from "@/lib/format";

/**
 * The vocabulary the whole interface is written in.
 *
 * # Two families, one rule
 *
 * Anything the product *asserts* is set in the display serif. Anything it
 * *measured* is set in the monospace. Nothing crosses over. The page is
 * therefore readable as a document -- claim, then evidence -- before a word of
 * it has been read, which is the only typographic decision here that is doing
 * real work.
 *
 * # There are no badges
 *
 * There used to be pill-shaped chips for chain, listing status, custody and so
 * on. They were the least considered thing on the page and the most visible:
 * six small rounded rectangles of different colours, scattered, each shouting
 * a word. Status is a *field* like any other, so it is now set as one -- a
 * dim monospace key beside its value, in the same grammar as every other fact
 * on the site. A state that genuinely needs attention gets a lit dot, and
 * nothing else does.
 */

/* ---------------------------------------------------------------- panels -- */

export function Panel({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & React.ComponentProps<"section">) {
  return (
    <section className={cn("border border-border bg-card/80 backdrop-blur-[2px]", className)} {...rest}>
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
        "flex h-10 items-center justify-between gap-3 border-b border-border px-4",
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
    <div className={cn("term-rule mb-5 mt-16", className)}>
      <h2 className="flex items-baseline gap-4">
        {index && <span className="font-mono text-[12px] text-primary">{index}</span>}
        <span className="display text-[clamp(1.5rem,2.5vw,2.05rem)] text-foreground">{children}</span>
      </h2>
      {aside && <span className="term-label order-last shrink-0 pl-3">{aside}</span>}
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
    sm: "text-[15px]",
    md: "text-[22px]",
    lg: "text-[clamp(2.5rem,4.4vw,3.5rem)]",
  } as const;
  return (
    <div className={cn("min-w-0", className)}>
      <div className="term-label truncate">{label}</div>
      <div
        className={cn("mt-2 font-mono leading-[0.98] tracking-[-0.02em]", sizes[size])}
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </div>
      {sub && <div className="mt-2 text-[12px] leading-snug text-faint">{sub}</div>}
    </div>
  );
}

/** A key and a value joined by a dotted leader, as on a printed statement. */
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
    <div className={cn("flex items-baseline py-[6px] text-[14px]", className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="term-leader" aria-hidden />
      <span className="shrink-0 font-mono" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
    </div>
  );
}

/**
 * A run of facts as one monospace line: `solana · approved · audited 3h ago`.
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
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {shown.map((f, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && (
            <span aria-hidden className="text-faint/60">
              ·
            </span>
          )}
          <span className="font-mono text-[12px] tracking-[0.04em] text-muted-foreground">{f}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * A lit indicator, for the one state on a page that is genuinely live.
 *
 * Deliberately the only thing left that resembles a badge, and deliberately
 * almost nothing: a dot and a word. If two of these ever appear on one screen,
 * one of them is wrong.
 */
export function Lamp({
  on = true,
  tone = "pos",
  children,
  className,
}: {
  on?: boolean;
  tone?: "pos" | "amber" | "neg";
  children: ReactNode;
  className?: string;
}) {
  const colour = tone === "pos" ? "var(--pos)" : tone === "neg" ? "var(--neg)" : "var(--amber)";
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden
        className={cn("size-[5px] rounded-full", on && "term-blink")}
        style={{
          background: on ? colour : "var(--faint)",
          boxShadow: on ? `0 0 8px ${colour}` : undefined,
        }}
      />
      <span
        className="font-mono text-[11px] uppercase tracking-[0.16em]"
        style={{ color: on ? colour : "var(--faint)" }}
      >
        {children}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ bars -- */

const SEGMENTS = 28;

/**
 * A 0-100 score as discrete blocks.
 *
 * A smooth bar invites the eye to read a precise position off it, which these
 * scores do not support -- they are a grade, not a measurement to three
 * figures. Blocks quantise the claim to roughly what it can carry.
 *
 * `null` is hatched, never empty, because an empty bar is indistinguishable
 * from a score of zero.
 */
export function ScoreBar({
  value,
  className,
  segments = SEGMENTS,
  /** Light the segments in sequence on mount, like a needle sweeping. */
  animate = false,
}: {
  value: number | null;
  className?: string;
  segments?: number;
  animate?: boolean;
}) {
  const band = bandOf(value);
  const lit = value === null ? 0 : Math.round((Math.max(0, Math.min(100, value)) / 100) * segments);

  return (
    <div
      className={cn("flex h-3.5 gap-[2px]", className)}
      role="img"
      aria-label={value === null ? "not measured" : `${Math.round(value)} out of 100`}
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={cn(
            "flex-1 rounded-[1px]",
            value === null && "opacity-70",
            animate && "segment-in",
          )}
          style={{
            // Capped total stagger: a bar that takes longer than a tenth of a
            // second to fill stops being an instrument and starts being a wait.
            ...(animate ? { "--seg-delay": `${Math.min(i * 9, 110)}ms` } : null),
            background:
              value === null
                ? "repeating-linear-gradient(135deg, var(--band-none) 0 2px, transparent 2px 4px)"
                : i < lit
                  ? `var(--band-${band})`
                  : "var(--grid)",
            boxShadow: value !== null && i === lit - 1 ? `0 0 8px var(--band-${band})` : undefined,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

/** A small bar chart of signed buckets, for per-period P&L. */
export function BucketBars({ values, className }: { values: number[]; className?: string }) {
  const peak = Math.max(1, ...values.map((v) => Math.abs(v)));
  return (
    <div className={cn("flex h-14 items-center gap-[3px]", className)} aria-hidden>
      {values.map((v, i) => {
        const h = Math.max(2, (Math.abs(v) / peak) * 26);
        return (
          <div key={i} className="flex h-full min-w-[3px] max-w-[28px] flex-1 flex-col justify-center">
            <div className="flex flex-1 items-end">
              {v > 0 && <div className="w-full rounded-[1px] bg-pos" style={{ height: h }} />}
            </div>
            <div className="h-px bg-grid" />
            <div className="flex flex-1 items-start">
              {v < 0 && <div className="w-full rounded-[1px] bg-neg" style={{ height: h }} />}
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
    note: "border-l-primary/70 bg-primary/[0.035]",
    warn: "border-l-warn/70 bg-warn/[0.04]",
    gap: "border-l-border text-muted-foreground",
  } as const;
  return (
    <div
      className={cn("border-l-2 py-2.5 pl-4 pr-2 text-[14px] leading-relaxed", tones[tone], className)}
    >
      {children}
    </div>
  );
}

/** The dash that stands for every unmeasured value in the app. */
export function Empty() {
  return <span className="text-faint">{EMPTY}</span>;
}
