import { useMemo } from "react";

import { DEFAULT_FEE_TERMS } from "@engine/follow/fees.js";
import { LISTING_TERMS } from "@engine/platform/listing.js";
import { bps, relative, score } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AppData, TraderProfile } from "@/lib/types";

/**
 * A running strip of the things that are true right now.
 *
 * # Why a marquee and not the status bar that used to be here
 *
 * A static line of small grey type above a masthead is the first thing a
 * visitor learns to skip -- which is exactly what happened to the one this
 * replaces. Movement is not what makes this different: *content* is. That bar
 * restated configuration. This says what the roster is doing, with figures
 * that change as the data does.
 *
 * # Everything on it is real
 *
 * Nothing here is a slogan. The seat count is the real remainder, the fee is
 * the constant the server charges, each trader's score is their published
 * grade, and the audit age is read from the profile. A ticker of invented
 * phrases is a decoration pretending to be an instrument, and this product
 * cannot afford that particular lie anywhere -- least of all in the first
 * thing on the page.
 */

interface Tick {
  text: string;
  tone?: "pos" | "brand" | "plain";
}

export function Ticker({
  data,
  profiles,
  className,
}: {
  data: AppData | null;
  profiles: Record<string, TraderProfile>;
  className?: string;
}) {
  const ticks = useMemo<Tick[]>(() => {
    const listed = data?.roster.length ?? 0;
    const open = Math.max(0, LISTING_TERMS.maxRoster - listed);

    const out: Tick[] = [
      { text: `${listed} of ${LISTING_TERMS.maxRoster} seats filled` },
      { text: "custody: self, always", tone: "pos" },
      { text: `${bps(DEFAULT_FEE_TERMS.tradeFeeBps)} per mirrored trade` },
      { text: "half of it to the trader", tone: "brand" },
      { text: "no deposit, no lockup", tone: "pos" },
    ];

    for (const entry of data?.roster ?? []) {
      const p = profiles[entry.leader]?.profile;
      const edge = p?.edgeScore ?? null;
      out.push({
        text:
          edge === null
            ? `${entry.handle} — not yet graded`
            : `${entry.handle} — edge ${score(edge)}, grade ${p?.grade}`,
        tone: "brand",
      });
    }

    const newest = Object.values(profiles).sort(
      (a, b) => b.provenance.computedAtMs - a.provenance.computedAtMs,
    )[0];
    if (newest) out.push({ text: `last audit ${relative(newest.provenance.computedAtMs)}` });
    if (open > 0) out.push({ text: `${open} seats open — apply`, tone: "brand" });

    return out;
  }, [data, profiles]);

  if (ticks.length === 0) return null;

  return (
    <div
      className={cn(
        "relative overflow-hidden border-b border-separator bg-black/30 backdrop-blur-xl",
        className,
      )}
      aria-hidden
    >
      {/* The ends fade rather than cut, so the strip reads as something passing
          through the page rather than a box with text sliding inside it. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-background to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-background to-transparent" />

      <div className="flex w-max animate-[marquee_46s_linear_infinite] py-2.5 motion-reduce:animate-none">
        {/* Rendered twice: the animation translates by exactly half its width,
            so the second copy is already in place when the first leaves. */}
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 items-center">
            {ticks.map((t, i) => (
              <span key={`${copy}-${i}`} className="flex items-center">
                <span
                  className={cn(
                    "whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.14em]",
                    t.tone === "pos"
                      ? "text-pos"
                      : t.tone === "brand"
                        ? "text-primary"
                        : "text-muted-foreground",
                  )}
                >
                  {t.text}
                </span>
                <span aria-hidden className="px-5 font-mono text-[11px] text-faint/40">
                  ///
                </span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
