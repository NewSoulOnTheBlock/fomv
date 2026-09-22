import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";

import { DEFAULT_FEE_TERMS } from "@engine/follow/fees.js";
import { LISTING_TERMS } from "@engine/platform/listing.js";
import { Address, Panel, PanelBody, PanelHead, ScoreBar, SectionRule, Stat, Tag } from "@/components/term";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { bandColor, bps, count, pct, ratio, relative, score, signOf, signedUsd } from "@/lib/format";
import { href } from "@/lib/router";
import type { AppData, RosterEntry, TraderProfile } from "@/lib/types";

/**
 * The roster.
 *
 * # Why this page argues before it lists
 *
 * There is one trader on it. A grid of cards would make that look like a
 * shortage; a short argument followed by one dense record makes it look like
 * an editorial decision, which is what it is. The claim the page has to land
 * before anything else is that FOMV grades traders rather than ranking them by
 * P&L — a visitor who reads the number as a leaderboard position has
 * misunderstood the product in the first five seconds.
 *
 * Each record therefore leads with the Edge Score and shows realised P&L as
 * the last figure on the row, in smaller type than the grade. That ordering is
 * the argument.
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

      <SectionRule aside={`${data.roster.length} listed`}>The roster</SectionRule>

      <div className="space-y-3">
        {data.roster.map((entry) => (
          <TraderRecord
            key={entry.leader}
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
      <ListingPitch seats={LISTING_TERMS.maxRoster} listed={data.roster.length} />
    </div>
  );
}

function Masthead({ count: listed }: { count: number }) {
  return (
    <div className="pt-12 pb-10 md:pt-16 md:pb-14 border-b border-border">
      <div className="max-w-3xl">
        <div className="term-label mb-4">
          copy-trading · solana · {listed} trader{listed === 1 ? "" : "s"}
        </div>
        <h1 className="text-3xl sm:text-[40px] leading-[1.08] font-semibold tracking-[-0.03em]">
          Follow a graded trader
          <br />
          from your own wallet.
        </h1>
        <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground max-w-xl">
          A short roster of traders, audited on five dimensions of skill rather than ranked by
          profit. Authorise FOMV to mirror one of them and their swaps are copied into{" "}
          <span className="text-foreground">your</span> wallet, sized by portfolio weight — so your
          position scales to your balance, not theirs.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[15px] text-foreground">
              {bps(DEFAULT_FEE_TERMS.tradeFeeBps)}
            </span>
            <span className="term-label">per mirrored trade</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[15px] text-foreground">$0</span>
            <span className="term-label">to deposit or withdraw</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[15px] text-pos">self</span>
            <span className="term-label">custody, always</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One trader, as a record rather than a card.
 *
 * Full width, hairline-divided, with the grade dial on the left and the figures
 * running across. It is a row in a terminal even though there is currently one
 * of them, so the page does not have to be redesigned at four.
 */
function TraderRecord({
  entry,
  profile,
  loading,
}: {
  entry: RosterEntry;
  profile: TraderProfile | undefined;
  loading: boolean;
}) {
  const p = profile?.profile;
  const edge = p?.edgeScore ?? null;
  const c = p?.core;

  return (
    <Panel className="transition-colors hover:border-[#2a2f39]">
      <PanelHead
        label={
          <span className="flex items-center gap-2.5">
            <span className="text-[13px] font-semibold tracking-normal normal-case text-foreground font-sans">
              {entry.handle}
            </span>
            <Tag>{entry.chain}</Tag>
            <Tag tone={entry.status === "live" ? "live" : "neutral"}>{entry.status}</Tag>
          </span>
        }
        aside={profile ? `audited ${relative(profile.provenance.computedAtMs)}` : undefined}
      />

      <div className="grid md:grid-cols-[220px_1fr] divide-y md:divide-y-0 md:divide-x divide-border">
        {/* The grade. */}
        <div className="p-4 flex md:flex-col items-center md:items-start gap-4 md:gap-3">
          {loading ? (
            <Skeleton className="h-12 w-24" />
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span
                  className="font-mono text-[44px] leading-none font-bold tracking-[-0.04em]"
                  style={{ color: bandColor(edge) }}
                >
                  {score(edge)}
                </span>
                <span className="term-label">/100</span>
              </div>
              <div className="flex flex-col gap-2 md:w-full">
                <span className="term-label">
                  edge score ·{" "}
                  <span style={{ color: bandColor(edge) }}>
                    {p?.grade === "insufficient-data" ? "no grade" : `grade ${p?.grade ?? "—"}`}
                  </span>
                </span>
                <ScoreBar value={edge} className="hidden md:flex w-full" segments={20} />
              </div>
            </>
          )}
        </div>

        {/* The figures. */}
        <div className="min-w-0">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-y divide-border [&>*]:p-3 [&>*]:-mt-px [&>*]:-ml-px">
            <Stat label="profit factor" value={ratio(c?.profitFactor)} size="sm" />
            <Stat label="win rate" value={pct(c?.winRate ?? null)} size="sm" />
            <Stat
              label="max drawdown"
              value={pct(c?.maxDrawdown ?? null)}
              size="sm"
              tone={c?.maxDrawdown != null && c.maxDrawdown > 0.3 ? "var(--warn)" : undefined}
            />
            <Stat label="round trips" value={count(c?.closedEpisodes)} size="sm" />
            <Stat
              label="realised p&l"
              value={signedUsd(c?.realizedPnlUsd ?? null, { compact: true })}
              size="sm"
              tone={
                signOf(c?.realizedPnlUsd) ? `var(--${signOf(c?.realizedPnlUsd)})` : undefined
              }
            />
          </div>

          <div className="p-3 border-t border-border flex flex-wrap items-center gap-x-4 gap-y-2">
            <Address value={entry.leader} />
            <span className="text-faint text-[11px]">·</span>
            <span className="term-label">fee {bps(DEFAULT_FEE_TERMS.tradeFeeBps)} / trade</span>
            <Button asChild size="sm" variant="outline" className="ml-auto font-mono text-[12px]">
              <a href={href(`/t/${entry.leader}`)}>
                Open audit
                <ArrowRight />
              </a>
            </Button>
          </div>
        </div>
      </div>

      {entry.note && (
        <div className="border-t border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
          {entry.note}
        </div>
      )}
    </Panel>
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
      `${bps(DEFAULT_FEE_TERMS.tradeFeeBps)} of the notional actually filled, and nothing under $${DEFAULT_FEE_TERMS.minChargeableUsd}. No deposit fee, no exit fee, nothing while you sit still.`,
    ],
  ];

  return (
    <>
      <SectionRule>How following works</SectionRule>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-border border border-border">
        {steps.map(([n, title, body]) => (
          <div key={n} className="bg-card p-4">
            <div className="font-mono text-[11px] text-primary">{n}</div>
            <h3 className="mt-2 text-[13px] font-semibold">{title}</h3>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * The trader-side funnel entry.
 *
 * Placed at the bottom of the roster rather than in the hero on purpose. The
 * pitch to a trader is "look at how these people are presented, you could be
 * one of them" — which only works after they have seen a record. Leading with
 * it would ask for an application before showing what a listing looks like.
 */
function ListingPitch({ seats, listed }: { seats: number; listed: number }) {
  return (
    <>
      <SectionRule aside={`${Math.max(0, seats - listed)} seats open`}>Trade your own book?</SectionRule>
      <Panel>
        <div className="grid md:grid-cols-[1fr_auto] gap-6 p-5 md:items-center">
          <div className="max-w-2xl">
            <h3 className="text-[17px] font-semibold tracking-tight">
              Get audited, get listed, get followed.
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              We run the same five-dimension audit on your wallet that you see above, publish it
              whatever it says, and configure the mirror runner to your book. You keep trading your
              own account exactly as you do now — followers mirror it from their own wallets, and
              nothing about your keys or your positions changes.
            </p>
            <p className="mt-2 text-[12px] text-faint">
              The roster is capped at {seats}. Applications go to a call, not to a queue.
            </p>
          </div>
          <Button asChild size="lg" className="font-mono shrink-0">
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
