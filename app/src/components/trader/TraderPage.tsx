import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";

import { Audit } from "@/components/trader/Audit";
import { EdgePentagon } from "@/components/viz/EdgePentagon";
import { FollowPanel } from "@/components/follow/FollowPanel";
import { CopyAddress } from "@/components/CopyAddress";
import { Callout, FactLine, Panel, PanelBody, PanelHead, Stat } from "@/components/term";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { dimensionsFor } from "@/lib/dimensions";
import { bandColor, count, pct, ratio, relative, score, shortAddress, signOf, signedUsd } from "@/lib/format";
import { href } from "@/lib/router";
import type { AppData, TraderProfile } from "@/lib/types";

/**
 * One trader: the instrument first, the evidence under it, the decision beside.
 *
 * The pentagon is given a full-width band at the top rather than a card,
 * because it is the page's thesis and everything below is support. The follow
 * panel is sticky on wide screens: the argument for following someone is two
 * thousand pixels long, and the control to act on it should not be waiting at
 * the bottom of them.
 */
export function TraderPage({ data, leader }: { data: AppData; leader: string }) {
  const entry = data.roster.find((r) => r.leader === leader);
  const [profile, setProfile] = useState<TraderProfile | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setProfile(null);
    setMissing(false);
    fetch(`data/profiles/${leader}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("missing"))))
      .then(setProfile)
      .catch(() => setMissing(true));
  }, [leader]);

  if (!entry) {
    return (
      <div className="pt-16">
        <Panel>
          <PanelHead label="unknown trader" />
          <PanelBody className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
              No trader with address{" "}
              <span className="font-mono">{shortAddress(leader, 8, 8)}</span> is on the roster.
            </p>
            <Button asChild variant="outline" size="sm">
              <a href={href("/")}>
                <ChevronLeft />
                Back to the roster
              </a>
            </Button>
          </PanelBody>
        </Panel>
      </div>
    );
  }

  const p = profile?.profile;
  const c = p?.core;

  return (
    <div className="pt-7">
      <a
        href={href("/")}
        className="inline-flex items-center gap-1 font-mono text-[12px] text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        roster
      </a>

      {/* The instrument band. */}
      <section className="rise step-1 mt-5 border-b border-border pb-10">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <h1 className="display text-[clamp(2.5rem,5.5vw,3.75rem)]">{entry.handle}</h1>
            <FactLine
              className="mt-3"
              facts={[
                entry.chain,
                `listing ${entry.status}`,
                profile && `audited ${relative(profile.provenance.computedAtMs)}`,
                profile && `${count(profile.provenance.trades)} swaps decoded`,
              ]}
            />
            <div className="mt-4">
              <CopyAddress address={entry.leader} lead={10} tail={10} />
            </div>

            <div className="mt-9 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
              <Stat
                label="edge score"
                value={
                  <span className="bloom" style={{ color: bandColor(p?.edgeScore ?? null) }}>
                    {score(p?.edgeScore ?? null)}
                  </span>
                }
                size="lg"
                sub={p?.grade === "insufficient-data" ? "not enough data to grade" : `grade ${p?.grade ?? "—"}`}
              />
              <Stat label="profit factor" value={ratio(c?.profitFactor)} sub={`win rate ${pct(c?.winRate ?? null)}`} />
              <Stat
                label="max drawdown"
                value={pct(c?.maxDrawdown ?? null)}
                sub={`${count(c?.closedEpisodes)} complete round trips`}
              />
              <Stat
                label="realised p&l"
                value={signedUsd(c?.realizedPnlUsd ?? null, { compact: true })}
                tone={signOf(c?.realizedPnlUsd) ? `var(--${signOf(c?.realizedPnlUsd)})` : undefined}
                sub="deliberately not the headline"
              />
            </div>
          </div>

          <div className="justify-self-center lg:justify-self-end">
            {profile ? (
              <EdgePentagon
                dimensions={dimensionsFor(p?.dimensions)}
                score={p?.edgeScore ?? null}
                size={340}
              />
            ) : (
              <Skeleton className="size-[340px] rounded-none" />
            )}
          </div>
        </div>
      </section>

      <div className="mt-2 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_356px]">
        <div className="order-2 min-w-0 lg:order-1">
          {profile && <Audit data={profile} />}

          {missing && (
            <Panel className="mt-10">
              <PanelHead label="no audit yet" />
              <PanelBody className="space-y-3">
                <p className="text-[13px] text-muted-foreground">
                  This trader is on the roster but their profile has not been computed into the
                  site data.
                </p>
                <pre className="overflow-x-auto border border-border bg-muted p-3 font-mono text-[11px]">
                  bun run src/cli.ts profile --candidates {entry.leader}
                  {"\n"}bun run build:appdata
                </pre>
              </PanelBody>
            </Panel>
          )}

          {!profile && !missing && (
            <div className="mt-10 space-y-4">
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-72 w-full" />
            </div>
          )}
        </div>

        <div className="order-1 space-y-4 lg:order-2 lg:sticky lg:top-24">
          <FollowPanel vault={entry} />

          {entry.elsewhere && entry.elsewhere.length > 0 && (
            <Panel>
              <PanelHead label="addresses not mirrored" aside={`${entry.elsewhere.length}`} />
              <PanelBody className="space-y-4">
                {entry.elsewhere.map((e) => (
                  <div key={e.address}>
                    <CopyAddress address={e.address} lead={8} tail={8} />
                    <p className="mt-1.5 text-[11px] leading-relaxed text-faint">{e.note}</p>
                  </div>
                ))}
              </PanelBody>
            </Panel>
          )}

          {entry.note && (
            <Panel>
              <PanelHead label="listing note" />
              <PanelBody>
                <Callout tone="gap">{entry.note}</Callout>
              </PanelBody>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
