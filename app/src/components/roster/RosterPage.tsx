import { ArrowRight } from "lucide-react";

import { DEFAULT_FEE_TERMS } from "@engine/follow/fees.js";
import { LISTING_TERMS } from "@engine/platform/listing.js";
import { EdgeGlyph } from "@/components/viz/EdgePentagon";
import { TraderDeck } from "@/components/roster/TraderDeck";
import { DataSources } from "@/components/DataSources";
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
export function RosterPage({
  data,
  profiles,
}: {
  data: AppData;
  profiles: Record<string, TraderProfile>;
}) {
  // Fetched once in App and passed down: the ticker in the chrome needs the
  // same files on every route.
  const loaded = Object.keys(profiles).length > 0 || data.roster.length === 0;

  return (
    <div>
      <Masthead roster={data.roster} profiles={profiles} />

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

function Masthead({
  roster,
  profiles,
}: {
  roster: RosterEntry[];
  profiles: Record<string, TraderProfile>;
}) {
  return (
    <section className="border-b border-separator pb-16 pt-14 md:pt-20">
      <div className="rise step-1 text-center">
        <h1 className="mx-auto max-w-[19ch] text-[clamp(2.5rem,5.4vw,4.25rem)] font-semibold">
          Follow a trader who has been <span className="text-gradient">measured</span>.
        </h1>
        <p className="mx-auto mt-7 max-w-2xl text-[17px] leading-[1.6] text-muted-foreground">
          A short roster, audited on five dimensions of skill rather than ranked by profit. Their
          swaps are mirrored into <span className="text-foreground">your</span> wallet at their
          portfolio weight — so your position scales to your balance, not theirs.
        </p>
      </div>

      {/* The deck is the product: the people, and how few of them there are. */}
      <TraderDeck roster={roster} profiles={profiles} className="rise step-2 mt-10" />

      <div className="rise step-4 term-divided material mt-12 grid rounded-xl sm:grid-cols-3">
        <Headline value={bps(DEFAULT_FEE_TERMS.tradeFeeBps)} label="per mirrored trade" />
        <Headline value="$0" label="to start or stop" />
        <Headline value="self" label="custody, always" tone="var(--pos)" />
      </div>

      <DataSources className="rise step-5 mt-10" />
    </section>
  );
}

function Headline({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div className="px-6 py-6">
      <div className="tnum text-[30px] font-semibold leading-none tracking-[-0.035em]" style={tone ? { color: tone } : undefined}>
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
    <Panel className="group rise step-2 pressable relative overflow-hidden hover:border-white/20 hover:shadow-[inset_0_1px_0_var(--highlight),var(--shadow-lift)]">
      {/* One lit rule that grows down the leading edge. The only hover
          flourish in the product, on the only thing that is a link. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[2px] origin-top scale-y-0 rounded-full transition-transform duration-500 ease-out group-hover:scale-y-100"
        style={{ background: "var(--brand-gradient)" }}
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
              <div className="truncate text-[clamp(1.45rem,2.2vw,1.85rem)] font-semibold tracking-[-0.03em]">{entry.handle}</div>
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
        <p className="border-t border-separator px-5 py-3.5 text-[13px] leading-relaxed text-faint">
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
      <div className="tnum mt-2 text-[23px] font-semibold leading-none tracking-[-0.035em]" style={tone ? { color: tone } : undefined}>
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(([n, title, body]) => (
          <div key={n} className="material rounded-xl p-6">
            <div className="inline-flex size-7 items-center justify-center rounded-full bg-primary/12 font-mono text-[11px] text-primary">{n}</div>
            <h3 className="mt-4 text-[19px] font-semibold">{title}</h3>
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
            <h3 className="text-[clamp(1.6rem,2.8vw,2.2rem)] font-semibold">
              Get audited. Get listed. Get <span className="text-gradient">followed</span>.
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
