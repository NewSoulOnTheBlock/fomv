import { useCallback, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { EMPTY, bandOf, shortAddress } from "@/lib/format";

/**
 * The vocabulary the whole interface is written in.
 *
 * Everything below is a terminal convention rather than a card-and-shadow one,
 * and the reason is the product: FOMV publishes a grade, a set of guardrails
 * and a fee, and asks someone to authorise a server to sign trades on their
 * wallet. The job of the surface is to look like instrumentation you can
 * audit, not like a landing page trying to sell you something.
 *
 * Two rules run through all of it:
 *
 * - **Amber is for interface, green and red are for signs.** A control can be
 *   amber; a number is only ever coloured by what it means. This is why there
 *   is no "primary" styling on a statistic anywhere in the app.
 * - **A missing value is drawn as missing.** `EMPTY` is an em dash, an
 *   unmeasured bar is hatched. Neither is ever rendered as a zero, because a
 *   gap that looks like a measurement is worse than a visible hole.
 */

/* ---------------------------------------------------------------- panels -- */

export function Panel({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & React.ComponentProps<"section">) {
  return (
    <section
      className={cn("border border-border bg-card", className)}
      {...rest}
    >
      {children}
    </section>
  );
}

/**
 * A panel's title bar: a label on the left, an optional readout on the right.
 *
 * Deliberately the same height and weight everywhere. Panels that size their
 * own headers to their importance turn a dense page into a ransom note.
 */
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
        "flex h-9 items-center justify-between gap-3 border-b border-border px-3",
        className,
      )}
    >
      <span className="term-label truncate">{label}</span>
      {aside !== undefined && (
        <span className="font-mono text-[11px] text-muted-foreground shrink-0">{aside}</span>
      )}
    </div>
  );
}

export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("p-3 sm:p-4", className)}>{children}</div>;
}

/** A page-level section heading: marker, name, hairline to the right margin. */
export function SectionRule({
  children,
  aside,
  className,
}: {
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("term-rule mt-10 mb-3", className)}>
      <h2 className="term-label !text-[11px] !text-foreground">
        <span className="mr-2 text-primary">▸</span>
        {children}
      </h2>
      {aside && (
        <span className="term-label order-last shrink-0 pl-3">{aside}</span>
      )}
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
  /** Colours the figure. Reserved for signed quantities and score bands. */
  tone?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizes = {
    sm: "text-[13px]",
    md: "text-lg",
    lg: "text-2xl",
  } as const;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="term-label truncate">{label}</div>
      <div
        className={cn("font-mono leading-tight tracking-tight mt-1", sizes[size])}
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] leading-snug text-faint">{sub}</div>}
    </div>
  );
}

/**
 * A row of statistics divided by hairlines.
 *
 * The divider is what makes a strip of numbers read as a readout rather than a
 * sentence. `cols` is capped per breakpoint by the caller.
 */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "term-divided grid [&>*]:px-3 [&>*]:py-2.5 [&>*:first-child]:pl-0",
        className,
      )}
    >
      {children}
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
    <div className={cn("flex items-baseline py-[5px] text-[13px]", className)}>
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="term-leader" aria-hidden />
      <span className="font-mono shrink-0" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ bars -- */

const SEGMENTS = 28;

/**
 * A 0-100 score as discrete blocks.
 *
 * A smooth progress bar invites the eye to read a precise position off it,
 * which these scores do not support — they are a grade, not a measurement to
 * three figures. Blocks quantise the claim to roughly what it can carry, and
 * they are the one visual in the app that is genuinely a terminal idiom rather
 * than a terminal-flavoured one.
 *
 * `null` renders as hatched blocks and never as an empty bar, because an empty
 * bar is indistinguishable from a score of zero.
 */
export function ScoreBar({
  value,
  className,
  segments = SEGMENTS,
}: {
  value: number | null;
  className?: string;
  segments?: number;
}) {
  const band = bandOf(value);
  const lit = value === null ? 0 : Math.round((Math.max(0, Math.min(100, value)) / 100) * segments);

  return (
    <div
      className={cn("flex gap-[2px] h-2.5", className)}
      role="img"
      aria-label={value === null ? "not measured" : `${Math.round(value)} out of 100`}
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={cn("flex-1 rounded-[1px]", value === null && "opacity-70")}
          style={{
            background:
              value === null
                ? // Hatching, so "unmeasured" cannot be mistaken for "empty".
                  "repeating-linear-gradient(135deg, var(--band-none) 0 2px, transparent 2px 4px)"
                : i < lit
                  ? `var(--band-${band})`
                  : "var(--grid)",
          }}
        />
      ))}
    </div>
  );
}

/** A small bar chart of signed buckets, for per-period P&L. */
export function BucketBars({
  values,
  className,
}: {
  values: number[];
  className?: string;
}) {
  const peak = Math.max(1, ...values.map((v) => Math.abs(v)));

  return (
    <div className={cn("flex items-center gap-[3px] h-14", className)} aria-hidden>
      {values.map((v, i) => {
        const h = Math.max(2, (Math.abs(v) / peak) * 26);
        return (
          <div key={i} className="flex-1 min-w-[3px] max-w-[28px] flex flex-col justify-center h-full">
            <div className="flex-1 flex items-end">
              {v > 0 && <div className="w-full rounded-[1px] bg-pos" style={{ height: h }} />}
            </div>
            <div className="h-px bg-grid" />
            <div className="flex-1 flex items-start">
              {v < 0 && <div className="w-full rounded-[1px] bg-neg" style={{ height: h }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- badges -- */

/**
 * A status chip.
 *
 * Square, hairline, monospace. Radix's `Badge` is a pill with a filled
 * background, which reads as a notification rather than a field value — this
 * is the one place the registry component is deliberately not used.
 */
export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "live" | "warn" | "accent";
  className?: string;
}) {
  const tones = {
    neutral: "border-border text-muted-foreground",
    live: "border-pos/40 text-pos",
    warn: "border-warn/40 text-warn",
    accent: "border-primary/40 text-primary",
  } as const;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 border px-1.5 py-[1px]",
        "font-mono text-[10px] uppercase tracking-[0.12em] whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {tone === "live" && <span className="term-blink size-1 rounded-full bg-pos" aria-hidden />}
      {children}
    </span>
  );
}

/* --------------------------------------------------------------- address -- */

/** A truncated address with a copy button that confirms in place. */
export function Address({
  value,
  lead = 6,
  tail = 6,
  className,
}: {
  value: string;
  lead?: number;
  tail?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {
        // Clipboard access can be denied outright. The address is on screen
        // either way, so this is a convenience failing, not the feature.
      },
    );
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      aria-label={`Copy address ${value}`}
      className={cn(
        "group inline-flex min-w-0 max-w-full items-center gap-1.5 font-mono text-[12px] text-muted-foreground",
        "transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none",
        className,
      )}
    >
      {shortAddress(value, lead, tail)}
      {copied ? (
        <Check className="size-3 text-pos" aria-hidden />
      ) : (
        <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60" aria-hidden />
      )}
    </button>
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
    note: "border-l-primary/60 bg-primary/[0.03]",
    warn: "border-l-warn/70 bg-warn/[0.04]",
    gap: "border-l-border bg-transparent text-muted-foreground",
  } as const;

  return (
    <div className={cn("border-l-2 py-2 pl-3 pr-2 text-[13px] leading-relaxed", tones[tone], className)}>
      {children}
    </div>
  );
}

/** The dash that stands for every unmeasured value in the app. */
export function Empty() {
  return <span className="text-faint">{EMPTY}</span>;
}
