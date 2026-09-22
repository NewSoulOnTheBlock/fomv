import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";

import { ApplyPage } from "@/components/apply/ApplyPage";
import { RosterPage } from "@/components/roster/RosterPage";
import { TraderPage } from "@/components/trader/TraderPage";
import { Shell } from "@/components/layout/Shell";
import { Callout, Panel, PanelBody, PanelHead } from "@/components/term";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { href, useRoute, useScrollReset } from "@/lib/router";
import type { AppData } from "@/lib/types";

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
  const [error, setError] = useState<string | null>(null);

  useScrollReset(JSON.stringify(route));

  useEffect(() => {
    fetch("data/app.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`app.json: ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <Shell route={route} data={data}>
      {route.name === "apply" ? (
        <ApplyPage />
      ) : error ? (
        <DataError message={error} />
      ) : !data ? (
        <Loading />
      ) : route.name === "trader" ? (
        <TraderPage data={data} leader={route.leader} />
      ) : route.name === "not-found" ? (
        <NotFound path={route.path} />
      ) : (
        <RosterPage data={data} />
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

function DataError({ message }: { message: string }) {
  return (
    <div className="pt-12">
      <Panel>
        <PanelHead label="no site data" />
        <PanelBody className="space-y-3">
          <Callout tone="warn">{message}</Callout>
          <p className="text-[13px] text-muted-foreground">
            The roster and every audit are read from static JSON. Generate it from the repository
            root:
          </p>
          <pre className="bg-muted border border-border p-3 text-[11px] font-mono overflow-x-auto">
            bun run build:appdata
          </pre>
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
