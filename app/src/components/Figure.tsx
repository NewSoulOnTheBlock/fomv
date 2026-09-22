import { useMemo } from "react";

import { CountingNumber } from "@/components/animate-ui/primitives/texts/counting-number";
import { EMPTY } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A measured figure that settles into place.
 *
 * # Why the numbers move
 *
 * Not because motion is fashionable. This product presents itself as an
 * instrument, and an instrument does not print a reading instantly -- a needle
 * swings and comes to rest. A figure that counts up and stops says "this was
 * measured" in a way that a figure which is simply there does not, and it says
 * it before a word of the copy has been read.
 *
 * It is also strictly bounded: each figure animates once, on mount, and never
 * again. A number that re-animates every render is a distraction attached to
 * data that did not change.
 *
 * # Why it parses a string instead of taking a number
 *
 * Every call site already formats through `lib/format`, which is where the
 * em-dash rule, the sign handling and the compacting live. Taking a raw number
 * here would mean reimplementing all of that or passing a formatter to every
 * call -- and the first time the two drifted, a figure would render one way in
 * a card and another in a table.
 *
 * So it takes the finished string, splits off the numeric core, animates that,
 * and puts the prefix and suffix back untouched. `+$39.7k` animates the 39.7
 * and keeps the `+$` and the `k`. An em dash has no numeric core and is
 * rendered exactly as it arrived, which is how the "never draw a gap as a
 * zero" rule survives contact with this component.
 */

/** `+$39.7k` -> `+$` / `39.7` / `k`. */
const PARTS = /^([^0-9]*?)(-?[\d,]+(?:\.\d+)?)(.*)$/;

export function Figure({
  children,
  className,
  delay = 0,
}: {
  /** An already-formatted string from `lib/format`. */
  children: string;
  className?: string;
  delay?: number;
}) {
  const parsed = useMemo(() => {
    if (!children || children === EMPTY) return null;
    const m = PARTS.exec(children);
    if (!m) return null;
    const [, prefix, core, suffix] = m;
    const value = Number(core!.replace(/,/g, ""));
    if (!Number.isFinite(value)) return null;
    // Trailing zeros are significant here: `1.30` is a profit factor to two
    // places, and animating it as `1.3` would quietly change what it claims.
    const decimals = core!.includes(".") ? core!.split(".")[1]!.length : 0;
    // A grouped number is rendered as it arrived. `CountingNumber` formats
    // with `toFixed` and has no thousands separator, so animating `2,085`
    // would show `2085` for the duration and snap back at the end -- a
    // formatting change disguised as motion.
    if (core!.includes(",")) return null;
    return { prefix: prefix ?? "", value, suffix: suffix ?? "", decimals };
  }, [children]);

  if (!parsed) {
    return <span className={cn("tnum", className)}>{children}</span>;
  }

  return (
    <span className={cn("tnum", className)}>
      {parsed.prefix}
      <CountingNumber
        number={parsed.value}
        decimalPlaces={parsed.decimals}
        delay={delay}
        // Slow and heavily damped: this should read as settling, not as a
        // slot machine. A springy counter on a P&L figure looks like a game.
        transition={{ stiffness: 80, damping: 40 }}
      />
      {parsed.suffix}
    </span>
  );
}
