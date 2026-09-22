import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";

import { Audit } from "@/components/trader/Audit";
import { FollowPanel } from "@/components/follow/FollowPanel";
import { Address, Callout, Panel, PanelBody, PanelHead, Tag } from "@/components/term";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { relative, shortAddress } from "@/lib/format";
import { href } from "@/lib/router";
import type { AppData, TraderProfile } from "@/lib/types";

/**
 * One trader: the audit on the left, the decision on the right.
 *
 * The follow panel is sticky on wide screens and sits directly under the
 * masthead on narrow ones. That placement is the point of the page — the
 * argument for following someone is the audit, so the control to do it has to
 * stay reachable while the argument is being read, rather than waiting at the
 * bottom of two thousand pixels of metrics.
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
      <div className="pt-12">
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

  return (
    <div className="pt-6">
      <a
        href={href("/")}
        className="inline-flex items-center gap-1 font-mono text-[12px] text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        roster
      </a>

      <div className="mt-4 pb-6 border-b border-border flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[28px] leading-none font-semibold tracking-[-0.03em]">
              {entry.handle}
            </h1>
            <Tag>{entry.chain}</Tag>
            <Tag tone={entry.status === "live" ? "live" : "neutral"}>{entry.status}</Tag>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            <Address value={entry.leader} lead={8} tail={8} />
            {profile && (
              <span className="term-label">
                audit refreshed {relative(profile.provenance.computedAtMs)}
              </span>
            )}
          </div>
        </div>

        <div className="flex gap-6">
          <div>
            <div className="term-label">custody</div>
            <div className="font-mono text-[15px] text-pos mt-0.5">self</div>
          </div>
          <div>
            <div className="term-label">deposit fee</div>
            <div className="font-mono text-[15px] mt-0.5">none</div>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_352px] gap-6 items-start">
        <div className="min-w-0 order-2 lg:order-1">
          {profile && <Audit data={profile} />}

          {missing && (
            <Panel className="mt-6">
              <PanelHead label="no audit yet" />
              <PanelBody className="space-y-2">
                <p className="text-[13px] text-muted-foreground">
                  This trader is on the roster but their profile has not been computed into the
                  site data.
                </p>
                <pre className="bg-muted border border-border p-3 text-[11px] font-mono overflow-x-auto">
                  bun run src/cli.ts profile --candidates {entry.leader}
                  {"\n"}bun run build:appdata
                </pre>
              </PanelBody>
            </Panel>
          )}

          {!profile && !missing && (
            <div className="mt-6 space-y-3">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          )}
        </div>

        <div className="order-1 lg:order-2 lg:sticky lg:top-20 space-y-3">
          <FollowPanel vault={entry} />

          {entry.elsewhere && entry.elsewhere.length > 0 && (
            <Panel>
              <PanelHead label="addresses not mirrored" aside={`${entry.elsewhere.length}`} />
              <PanelBody className="space-y-3">
                {entry.elsewhere.map((e) => (
                  <div key={e.address}>
                    <Address value={e.address} />
                    <p className="mt-1 text-[11px] leading-relaxed text-faint">{e.note}</p>
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
