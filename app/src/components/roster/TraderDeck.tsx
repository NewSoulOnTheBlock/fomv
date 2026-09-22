import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Plus } from "lucide-react";

import { LISTING_TERMS } from "@engine/platform/listing.js";
import { EdgePentagon } from "@/components/viz/EdgePentagon";
import { Sparkline } from "@/components/viz/Sparkline";
import { dimensionsFor } from "@/lib/dimensions";
import { bandColor, count, pct, ratio, relative, score, signOf, signedUsd } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { RosterEntry, TraderProfile } from "@/lib/types";

/**
 * The roster as a hand of cards.
 *
 * # Why a deck and not a list
 *
 * The list further down the page is the better tool for comparing traders, and
 * this is not competing with it. What a fanned deck does that a list cannot is
 * say *how few of them there are* before a single figure has been read. A
 * roster of eight is the product's central claim -- these people were chosen --
 * and a claim that has to be read is weaker than one you can count.
 *
 * # The empty seats are real
 *
 * Cards for unfilled places are not padding to make the fan look fuller. The
 * roster is genuinely capped, the remaining places are genuinely open, and a
 * trader looking at this page is the person who should act on that. So they
 * are drawn as what they are -- outlined, unlit, and a link to apply -- which
 * makes the hero carry both audiences at once without a second section.
 *
 * # The face is the pentagon
 *
 * Not an avatar. A profile picture says who someone is and this product's
 * entire argument is that who they are does not matter; the shape of what they
 * have done does. It is also the only mark here that stays legible at card
 * size, which is what lets the deck be scanned rather than read.
 */

interface DeckCard {
  key: string;
  entry?: RosterEntry;
  profile?: TraderProfile;
}

export function TraderDeck({
  roster,
  profiles,
  className,
}: {
  roster: RosterEntry[];
  profiles: Record<string, TraderProfile>;
  className?: string;
}) {
  const cards = useMemo<DeckCard[]>(() => {
    const filled = roster.map((entry) => ({
      key: entry.leader,
      entry,
      profile: profiles[entry.leader],
    }));
    // Enough empty seats to make a hand, never more than are actually open.
    const open = Math.max(0, LISTING_TERMS.maxRoster - roster.length);
    const ghosts = Array.from({ length: Math.min(open, 4) }, (_, i) => ({ key: `open-${i}` }));
    return [...filled, ...ghosts];
  }, [roster, profiles]);

  // The centre of the fan, which is also the only one that is readable.
  // Opens on the first listed trader: the roster's order is an editorial
  // decision, and overriding it can land a visitor on the one card with no
  // grade on it.
  const [active, setActive] = useState(0);

  useEffect(() => {
    setActive(0);
  }, [roster.length]);

  // Wraps. A fan that stops at the ends spreads one way only, so the first
  // and last cards sit in a lopsided composition with nothing on one side --
  // and the first card is the one everybody sees.
  const move = useCallback(
    (delta: number) => setActive((i) => (i + delta + cards.length) % cards.length),
    [cards.length],
  );

  return (
    <div className={cn("select-none", className)}>
      <div
        role="group"
        aria-label="The roster"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            move(1);
          }
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            move(-1);
          }
        }}
        // Clipped, so a fan wider than the viewport bleeds off the edge
        // instead of widening the document. Scaled down on small screens for
        // the same reason: a 280px card in a 390px window leaves no fan.
        className="relative mx-auto h-[300px] overflow-hidden sm:h-[380px] lg:h-[440px]"
        style={{ perspective: "1400px" }}
      >
        <div className="absolute inset-0 flex origin-center scale-[0.62] items-center justify-center sm:scale-[0.82] lg:scale-100">
        {cards.map((card, i) => {
          // Signed distance around the ring, shortest way, so every card has
          // neighbours on both sides however few there are.
          const n = cards.length;
          let offset = i - active;
          if (offset > n / 2) offset -= n;
          if (offset < -n / 2) offset += n;
          const distance = Math.abs(offset);
          // Cards fan outward and lean away. Beyond the third the shape is
          // already read, so the rest are parked rather than spread further.
          // Capped at two each side. Past that the fan is already legible and
          // the extra cards only crowd the one being read.
          const spread = Math.sign(offset) * Math.min(distance, 2);
          return (
            <Card
              key={card.key}
              card={card}
              focused={offset === 0}
              onFocus={() => setActive(i)}
              style={{
                transform: `translateX(${spread * 205}px) translateZ(${-distance * 150}px) rotateY(${-spread * 19}deg) scale(${1 - Math.min(distance, 3) * 0.07})`,
                zIndex: cards.length - distance,
                opacity: distance > 2 ? 0 : 1,
                pointerEvents: distance > 2 ? "none" : undefined,
                // Dimmed enough to recede, not so far that a card stops looking
                // like a card. At a third off they read as black rectangles.
                filter: offset === 0 ? undefined : `brightness(${1 - Math.min(distance, 2) * 0.2})`,
              }}
            />
          );
        })}
        </div>
      </div>

      {/* A position readout rather than dots: with eight seats, dots stop being
          countable at exactly the size where counting was the point. */}
      <div className="mt-2 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => move(-1)}
          aria-label="Previous trader"
          className="rounded-full p-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowRight className="size-4 rotate-180" />
        </button>
        <span className="term-label tabular-nums">
          {active + 1} / {cards.length}
        </span>
        <button
          type="button"
          onClick={() => move(1)}
          aria-label="Next trader"
          className="rounded-full p-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

function Card({
  card,
  focused,
  onFocus,
  style,
}: {
  card: DeckCard;
  focused: boolean;
  onFocus: () => void;
  style: React.CSSProperties;
}) {
  const base =
    "absolute h-[400px] w-[262px] rounded-2xl text-left transition-all duration-500 ease-out " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

  if (!card.entry) {
    return (
      <a
        href={href("/apply")}
        onMouseEnter={onFocus}
        onFocus={onFocus}
        style={style}
        className={cn(
          base,
          "flex flex-col items-center justify-center gap-4 border border-dashed",
          "border-white/15 bg-[#121218]",
          focused && "border-primary/45 bg-[#15121f]",
        )}
      >
        <span className="flex size-12 items-center justify-center rounded-full border border-dashed border-white/20">
          <Plus className="size-4 text-muted-foreground" />
        </span>
        <span className="term-label">seat open</span>
        {focused && (
          <span className="max-w-[190px] text-center text-[13px] leading-snug text-muted-foreground">
            The roster is capped at {LISTING_TERMS.maxRoster}. Apply to be audited.
          </span>
        )}
      </a>
    );
  }

  const { entry, profile } = card;
  const p = profile?.profile;
  const c = p?.core;
  const edge = p?.edgeScore ?? null;
  const buckets = c?.consistency.bucketPnlUsd ?? [];
  const pnl = c?.realizedPnlUsd ?? null;

  return (
    <a
      href={href(`/t/${entry.leader}`)}
      onMouseEnter={onFocus}
      onFocus={onFocus}
      style={style}
      className={cn(
        base,
        "deck-card flex flex-col overflow-hidden",
        focused && "deck-card-focused",
      )}
    >
      <div className="flex items-center justify-between border-b border-separator px-4 py-3">
        <span className="truncate text-[15px] font-semibold tracking-[-0.02em]">
          {entry.handle}
        </span>
        {/* The grade as a letter, in its own band colour. It is the one thing
            on the card that can be read at any distance in the fan. */}
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md font-mono text-[13px] font-semibold"
          style={{
            color: bandColor(edge),
            background: `color-mix(in oklab, ${bandColor(edge)} 14%, transparent)`,
          }}
        >
          {p && p.grade !== "insufficient-data" ? p.grade : "—"}
        </span>
      </div>

      <div className="relative flex flex-1 items-center justify-center py-1">
        {focused && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background: `radial-gradient(58% 55% at 50% 45%, ${
                edge === null ? "rgba(255,255,255,0.05)" : "var(--brand-soft)"
              }, transparent 70%)`,
            }}
          />
        )}
        <EdgePentagon
          dimensions={dimensionsFor(p?.dimensions)}
          score={edge}
          size={196}
          labels={false}
        />
      </div>

      {/* The curve runs the full width under the shape, the way a card puts a
          chart under a portrait. Below two periods there is no curve to draw
          and a flat line would imply one. */}
      {/*
        Drawn only when there is a curve to draw. Not drawing it is already the
        honest answer; captioning the absence turns a card into an apology, and
        the trader's own page explains the threshold properly.
      */}
      {buckets.length >= 2 && (
        <div className="-mb-px">
          <Sparkline values={buckets} width={260} height={34} className="w-full" />
        </div>
      )}

      <div className="grid grid-cols-2 border-t border-separator">
        <div className="border-r border-separator px-4 py-3">
          <div className="term-label">edge</div>
          <div
            className="tnum mt-1.5 text-[28px] font-semibold leading-none tracking-[-0.04em]"
            style={{ color: bandColor(edge) }}
          >
            {score(edge)}
          </div>
          <div className="mt-1.5 text-[11px] text-faint">
            {c ? `${count(c.closedEpisodes)} round trips` : "not audited"}
          </div>
        </div>
        <div className="px-4 py-3">
          <div className="term-label">realised</div>
          <div
            className="tnum mt-1.5 text-[20px] font-semibold leading-none tracking-[-0.03em]"
            style={{ color: signOf(pnl) ? `var(--${signOf(pnl)})` : undefined }}
          >
            {signedUsd(pnl, { compact: true })}
          </div>
          <div className="mt-1.5 text-[11px] text-faint">
            {c ? `pf ${ratio(c.profitFactor)} · win ${pct(c.winRate)}` : "—"}
          </div>
        </div>
      </div>

      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{
          background:
            edge === null
              ? "rgba(255,255,255,0.03)"
              : `color-mix(in oklab, ${bandColor(edge)} 11%, transparent)`,
          borderTop: `1px solid ${
            edge === null ? "var(--separator)" : `color-mix(in oklab, ${bandColor(edge)} 24%, transparent)`
          }`,
        }}
      >
        <span className="term-label" style={{ color: bandColor(edge), opacity: 0.85 }}>
          {entry.chain}
        </span>
        <span className="term-label">
          {profile ? `audited ${relative(profile.provenance.computedAtMs)}` : "audit pending"}
        </span>
      </div>
    </a>
  );
}
