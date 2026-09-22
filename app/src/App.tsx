import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";

import { ApplyPage } from "@/components/apply/ApplyPage";
import { DocsPage } from "@/components/docs/DocsPage";
import { RosterPage } from "@/components/roster/RosterPage";
import { TraderPage } from "@/components/trader/TraderPage";
import { Shell } from "@/components/layout/Shell";
import { Callout, Panel, PanelBody, PanelHead } from "@/components/term";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { operatorHint } from "@/lib/operator";
import { href, useRoute, useScrollReset } from "@/lib/router";
import type { AppData, TraderProfile } from "@/lib/types";

/**
 * Routing and the one fetch the whole site depends on.
 *
 * `app.json` is loaded once here rather than per page. It is small, every
 * route needs part of it, and fetching it inside each screen would make the
 * status strip flicker between pages for no gain.
 *
 * The apply route is deliberately reachable while that fetch is in flight or
 * has failed: a trader following a link from a DM should never land on a
 * loading spinner or an error, because their page does not depend on the
 * roster data at all.
 */
export function App() {
  const route = useRoute();
  const [data, setData] = useState<AppData | null>(null);
  const [profiles, setProfiles] = useState<Record<string, TraderProfile>>({});
  const [error, setError] = useState<string | null>(null);

  useScrollReset(JSON.stringify(route));

  useEffect(() => {
    let cancelled = false;
    fetch("data/app.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`app.json: ${r.status}`))))
      .then(async (d: AppData) => {
        if (cancelled) return;
        setData(d);
        // Loaded here rather than in the roster, because the ticker in the
        // chrome needs them on every route and two components fetching the
        // same files would double the requests to show one figure.
        const rows = await Promise.all(
          d.roster.map(async (r) => {
            try {
              const res = await fetch(`data/profiles/${r.leader}.json`);
              return res.ok ? ([r.leader, (await res.json()) as TraderProfile] as const) : null;
            } catch {
              return null;
            }
          }),
        );
        if (cancelled) return;
        setProfiles(
          Object.fromEntries(rows.filter((x): x is readonly [string, TraderProfile] => x !== null)),
        );
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Shell route={route} data={data} profiles={profiles}>
      {route.name === "apply" ? (
        <ApplyPage />
      ) : route.name === "docs" ? (
        // Like the apply page, this reads nothing from app.json, so it stays
        // reachable while that fetch is in flight or has failed.
        <DocsPage />
      ) : error ? (
        <DataError message={error} />
      ) : !data ? (
        <Loading />
      ) : route.name === "trader" ? (
        <TraderPage data={data} leader={route.leader} />
      ) : route.name === "not-found" ? (
        <NotFound path={route.path} />
      ) : (
        <RosterPage data={data} profiles={profiles} />
      )}
    </Shell>
  );
}

function Loading() {
  return (
    <div className="space-y-5 pt-20">
      <Skeleton className="h-14 w-96 max-w-full" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-44 w-full mt-10" />
    </div>
  );
}

/**
 * The roster could not be loaded.
 *
 * The underlying message is a fetch error with a status code in it. That is
 * exactly what the operator needs and exactly what a visitor cannot use, so it
 * goes to the console and the page says the one useful thing instead: this is
 * ours, not yours, and the rest of the site still works.
 */
function DataError({ message }: { message: string }) {
  operatorHint(
    "data",
    `${message} — the roster and every audit are read from static JSON. Run ` +
      "`bun run build:appdata` from the repository root.",
  );

  return (
    <div className="pt-16">
      <Panel>
        <PanelHead label="roster unavailable" />
        <PanelBody className="space-y-4">
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            The roster could not be loaded just now. This is a fault on our side rather than
            anything you did — it is usually brief.
          </p>
          <Button asChild variant="outline" size="sm">
            <a href={href("/apply")}>Get listed instead</a>
          </Button>
        </PanelBody>
      </Panel>
    </div>
  );
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="pt-12">
      <Panel>
        <PanelHead label="404" />
        <PanelBody className="space-y-4">
          <p className="text-[13px] text-muted-foreground">
            Nothing at <span className="font-mono text-foreground">{path}</span>.
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
