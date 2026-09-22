import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";

import { DEFAULT_FEE_TERMS } from "@engine/follow/fees.js";
import { LISTING_TERMS } from "@engine/platform/listing.js";
import { EdgeGlyph } from "@/components/viz/EdgePentagon";
import { MirrorDiagram } from "@/components/viz/MirrorDiagram";
import { Sparkline } from "@/components/viz/Sparkline";
import { FactLine, Panel, PanelBody, SectionRule } from "@/components/term";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { dimensionsFor } from "@/lib/dimensions";
import { bandColor, bps, count, pct, ratio, relative, score, signOf, signedUsd } from "@/lib/format";
import { href } from "@/lib/router";
import type { AppData, RosterEntry, TraderProfile } from "@/lib/types";

/**
 * The roster.
 *
 * # The order of the argument
 *
 * A visitor arrives believing one of two wrong things: that this is a
 * leaderboard, or that it is custodial. The page answers both before it lists
 * anyone -- the headline says *graded*, and the diagram under it shows the
 * trade arriving in a wallet with no line leaving it. Only then does it show
 * traders, and each record leads with the Edge shape rather than with P&L.
 *
 * That ordering is the whole design. A roster that opened with a number would
 * be read as a ranking no matter what the copy said.
 */
export function RosterPage({ data }: { data: AppData }) {
  const [profiles, setProfiles] = useState<Record<string, TraderProfile>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      data.roster.map(async (r) => {
        try {
          const res = await fetch(`data/profiles/${r.leader}.json`);
          return res.ok ? ([r.leader, (await res.json()) as TraderProfile] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      setProfiles(
        Object.fromEntries(rows.filter((x): x is readonly [string, TraderProfile] => x !== null)),
      );
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [data]);

  return (
    <div>
      <Masthead count={data.roster.length} />

      <SectionRule index="01" aside={`${data.roster.length} of ${LISTING_TERMS.maxRoster} seats`}>
        The roster
      </SectionRule>

      <div className="space-y-4">
        {data.roster.map((entry, i) => (
          <TraderRecord
            key={entry.leader}
            index={i + 1}
            entry={entry}
            profile={profiles[entry.leader]}
            loading={!loaded}
          />
        ))}
        {data.roster.length === 0 && (
          <Panel>
            <PanelBody className="text-[13px] text-muted-foreground">
              No traders listed yet.
            </PanelBody>
          </Panel>
        )}
      </div>

      <HowItWorks />
      <ListingPitch listed={data.roster.length} />
    </div>
  );
}

function Masthead({ count: listed }: { count: number }) {
  return (
    <section className="border-b border-border pb-16 pt-14 md:pt-20">
      {/*
        The headline gets the full measure rather than a column beside the
        diagram. At this size a 500px column breaks "Follow a trader" across
        two lines and the whole thing reads as text that did not fit; given
        the width it breaks where it was written to break.
      */}
      <div className="rise step-1">
        <div className="term-label mb-8">
          copy-trading · solana · {listed} graded trader{listed === 1 ? "" : "s"}
        </div>

        <h1 className="display max-w-[17ch] text-[clamp(2.6rem,5.6vw,4.4rem)]">
          Follow a trader who has been <span className="display-em">measured</span>.
        </h1>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] lg:items-center">
        <div className="rise step-2">
          <p className="text-[17px] leading-[1.6] text-muted-foreground">
            A short roster, audited on five dimensions of skill rather than ranked by profit.
            Authorise one of them and their swaps are mirrored into{" "}
            <span className="text-foreground">your</span> wallet at their portfolio weight — so
            your position scales to your balance, not theirs.
          </p>

        </div>

        {/*
          Hidden below md. The drawing is 760 units wide and its labels are set
          at 9px; at phone width it renders those at under 5px, which is not a
          smaller diagram but an unreadable one. The four steps below say the
          same thing in words, which is the right medium at that size.
        */}
        <div className="rise step-3 relative hidden md:block">
          <div
            className="pointer-events-none absolute -inset-y-16 inset-x-0 -z-10 opacity-70"
            style={{
              background: "radial-gradient(60% 60% at 50% 50%, var(--amber-glow), transparent 70%)",
            }}
            aria-hidden
          />
          <MirrorDiagram />
        </div>
      </div>

      {/* The three numbers that answer "what does this cost me", given a band
          of their own rather than squeezed beside the copy. */}
      <div className="rise step-4 term-divided mt-12 grid border-t border-border sm:grid-cols-3">
        <Headline value={bps(DEFAULT_FEE_TERMS.tradeFeeBps)} label="per mirrored trade" />
        <Headline value="$0" label="to start or stop" />
        <Headline value="self" label="custody, always" tone="var(--pos)" />
      </div>
    </section>
  );
}

function Headline({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div className="py-7 pr-6 first:pl-0 sm:pl-7">
      <div className="font-mono text-[28px] leading-none tracking-[-0.02em]" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <div className="term-label mt-2.5">{label}</div>
    </div>
  );
}

/**
 * One trader, as a record rather than a card.
 *
 * The Edge shape sits on the left at glyph size and is the first thing read,
 * which is the point: two traders with the same score and different shapes are
 * different products, and a number cannot say so. Realised P&L is the last
 * figure on the row and set no larger than the rest.
 */
function TraderRecord({
  index,
  entry,
  profile,
  loading,
}: {
  index: number;
  entry: RosterEntry;
  profile: TraderProfile | undefined;
  loading: boolean;
}) {
  const p = profile?.profile;
  const c = p?.core;
  const edge = p?.edgeScore ?? null;
  const dims = dimensionsFor(p?.dimensions);
  const buckets = c?.consistency.bucketPnlUsd ?? [];

  return (
    <Panel className="group rise step-2 relative overflow-hidden transition-colors hover:border-[#2c2c36]">
      {/* One amber rule that grows down the leading edge. The only hover
          flourish in the product, on the only thing that is a link. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-px origin-top scale-y-0 bg-primary transition-transform duration-500 ease-out group-hover:scale-y-100"
      />
      <a href={href(`/t/${entry.leader}`)} className="block focus-visible:outline-none">
        <div className="grid gap-6 p-5 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center">
          {/* Identity and shape. */}
          <div className="flex items-center gap-6">
            <span className="term-label hidden w-6 shrink-0 md:block">
              {String(index).padStart(2, "0")}
            </span>
            {loading ? (
              <Skeleton className="size-[58px]" />
            ) : (
              <EdgeGlyph dimensions={dims} score={edge} size={58} />
            )}
            <div className="min-w-0">
              <div className="display truncate text-[clamp(1.6rem,2.5vw,2.1rem)]">{entry.handle}</div>
              <FactLine
                className="mt-1.5"
                facts={[
                  entry.chain,
                  `listing ${entry.status}`,
                  profile && `audited ${relative(profile.provenance.computedAtMs)}`,
                ]}
              />
            </div>
          </div>

          {/* The reading. */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4 md:justify-self-end">
            <Cell
              label="edge"
              value={score(edge)}
              tone={bandColor(edge)}
              sub={p?.grade === "insufficient-data" ? "no grade" : `grade ${p?.grade ?? "—"}`}
            />
            <Cell label="profit factor" value={ratio(c?.profitFactor)} sub={`win ${pct(c?.winRate ?? null)}`} />
            <Cell
              label="max drawdown"
              value={pct(c?.maxDrawdown ?? null)}
              sub={`${count(c?.closedEpisodes)} round trips`}
            />
            <Cell
              label="realised"
              value={signedUsd(c?.realizedPnlUsd ?? null, { compact: true })}
              tone={signOf(c?.realizedPnlUsd) ? `var(--${signOf(c?.realizedPnlUsd)})` : undefined}
              sub={buckets.length >= 2 ? <Sparkline values={buckets} width={78} height={20} /> : undefined}
            />
          </div>

          <div className="hidden shrink-0 items-center gap-2 font-mono text-[13px] text-muted-foreground transition-colors group-hover:text-primary md:flex">
            open
            <ArrowRight className="size-3.5" />
          </div>
        </div>
      </a>

      {entry.note && (
        <p className="border-t border-border px-6 py-3.5 text-[13px] leading-relaxed text-faint">
          {entry.note}
        </p>
      )}
    </Panel>
  );
}

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="min-w-[104px]">
      <div className="term-label">{label}</div>
      <div className="mt-2 font-mono text-[23px] leading-none tracking-[-0.02em]" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {sub !== undefined && <div className="mt-2 text-[12px] text-faint">{sub}</div>}
    </div>
  );
}

function HowItWorks() {
  const steps: [string, string, string][] = [
    [
      "01",
      "Sign in",
      "Google, X, Discord or email. A Solana wallet is created for you — you do not need one first, and nobody but you can move what is in it.",
    ],
    [
      "02",
      "Authorise signing",
      "You grant permission to sign swaps on that wallet. Not transfers. FOMV cannot send your funds anywhere, and you can withdraw the permission at any moment.",
    ],
    [
      "03",
      "The trader trades",
      "Their swap is detected from on-chain balance deltas, checked against the guardrails on their page, and mirrored into your wallet at their portfolio weight.",
    ],
    [
      "04",
      "You pay per trade",
      `${bps(DEFAULT_FEE_TERMS.tradeFeeBps)} of the notional actually filled, half of it to the trader, nothing under $${DEFAULT_FEE_TERMS.minChargeableUsd}. Nothing while you sit still.`,
    ],
  ];

  return (
    <>
      <SectionRule index="02">How following works</SectionRule>
      <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(([n, title, body]) => (
          <div key={n} className="bg-card p-6">
            <div className="font-mono text-[13px] text-primary">{n}</div>
            <h3 className="display mt-3 text-[23px]">{title}</h3>
            <p className="mt-2.5 text-[14px] leading-relaxed text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
    </>
  );
}

function ListingPitch({ listed }: { listed: number }) {
  const open = Math.max(0, LISTING_TERMS.maxRoster - listed);
  return (
    <>
      <SectionRule index="03" aside={`${open} seats open`}>
        Trade your own book?
      </SectionRule>
      <Panel>
        <div className="grid items-center gap-8 p-8 md:grid-cols-[1fr_auto]">
          <div className="max-w-2xl">
            <h3 className="display text-[clamp(1.8rem,3.2vw,2.5rem)]">
              Get audited. Get listed. Get <span className="display-em">followed</span>.
            </h3>
            <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
              We run the same five-dimension audit on your wallet that you see above, publish it
              whatever it says, and configure the mirror runner to your book. You keep trading your
              own account exactly as you do now — followers mirror it from their own wallets, and
              nothing about your keys or your positions changes.
            </p>
            <p className="mt-4 text-[14px] text-faint">
              The roster is capped at {LISTING_TERMS.maxRoster}. Applications go to a call, not to a
              queue.
            </p>
          </div>
          <Button asChild size="lg" className="shrink-0 font-mono">
            <a href={href("/apply")}>
              Apply to be listed
              <ArrowRight />
            </a>
          </Button>
        </div>
      </Panel>
    </>
  );
}
