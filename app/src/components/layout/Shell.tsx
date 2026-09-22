import { type ReactNode } from "react";

import { DEFAULT_FEE_TERMS } from "@engine/follow/fees.js";
import { AccountChip } from "@/components/AccountChip";
import { Tag } from "@/components/term";
import { cn } from "@/lib/utils";
import { bps, relative } from "@/lib/format";
import { href, type Route } from "@/lib/router";
import type { AppData } from "@/lib/types";

/**
 * The frame every page sits in.
 *
 * # The status strip
 *
 * The thin bar above the header is the one piece of pure theatre in the app,
 * and it earns its place by being true: every figure on it is read from the
 * data file rather than written into the markup. It states the four things a
 * visitor would otherwise have to hunt for — which network, how many traders,
 * what it costs, and who holds the funds — and it states them before the
 * product has finished making its argument.
 *
 * `CUSTODY SELF` is the most important string on the page and it is deliberate
 * that it appears above the fold on every route.
 */

const NAV: { label: string; path: string; match: Route["name"][] }[] = [
  { label: "Roster", path: "/", match: ["roster", "trader"] },
  { label: "Get listed", path: "/apply", match: ["apply"] },
];

export function Shell({
  route,
  data,
  children,
}: {
  route: Route;
  data: AppData | null;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <StatusStrip data={data} />
      <Header route={route} />
      <main className="flex-1 w-full max-w-[1180px] mx-auto px-4 sm:px-6 pb-20">{children}</main>
      <Footer />
    </div>
  );
}

function StatusStrip({ data }: { data: AppData | null }) {
  const cells: [string, ReactNode][] = [
    ["net", data?.platform.cluster ?? "—"],
    ["roster", data ? `${data.roster.length}/${data.platform.maxLiveVaults}` : "—"],
    ["fee", `${bps(DEFAULT_FEE_TERMS.tradeFeeBps)} / trade`],
    ["custody", <span className="text-pos">self</span>],
  ];

  return (
    <div className="border-b border-border bg-[#060709]">
      <div className="max-w-[1180px] mx-auto px-4 sm:px-6 h-7 flex items-center gap-4 overflow-x-auto">
        {cells.map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5 shrink-0">
            <span className="term-label">{k}</span>
            <span className="font-mono text-[11px] text-secondary-foreground">{v}</span>
          </span>
        ))}
        <span className="ml-auto shrink-0 term-label hidden sm:block">
          data {data ? relative(data.generatedAtMs) : "—"}
        </span>
      </div>
    </div>
  );
}

function Header({ route }: { route: Route }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-sm">
      {/* The grid sits behind the chrome only. Full-page it becomes noise the
          moment real figures are laid over it. */}
      <div className="absolute inset-0 term-grid opacity-[0.55] pointer-events-none" aria-hidden />

      <div className="relative max-w-[1180px] mx-auto px-4 sm:px-6 h-14 flex items-center gap-4 sm:gap-8">
        <a href={href("/")} className="flex items-baseline gap-2.5 shrink-0 group">
          <span className="font-mono text-[17px] font-bold tracking-[-0.03em]">
            FOM<span className="text-primary">V</span>
          </span>
          <span className="term-label hidden md:block transition-colors group-hover:text-muted-foreground">
            fear of missing vault
          </span>
        </a>

        <nav className="flex items-center gap-1" aria-label="Main">
          {NAV.map((item) => {
            const active = item.match.includes(route.name);
            return (
              <a
                key={item.path}
                href={href(item.path)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "px-2.5 py-1 font-mono text-[12px] tracking-wide transition-colors",
                  "border-b-2 -mb-px",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <AccountChip />
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border mt-auto">
      <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-8 grid gap-6 md:grid-cols-[1fr_auto] md:items-start">
        <div className="max-w-2xl space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-bold">FOMV</span>
            <Tag>non-custodial</Tag>
            <Tag>solana only</Tag>
          </div>
          <p className="text-[12px] leading-relaxed text-faint">
            Copy-trading replicates another account's transactions at the operator's sole
            direction. Nothing here is investment advice, and a published grade is a measurement
            of the past, not a forecast. Delegation authorises FOMV to sign swaps on your wallet
            under the guardrails on each trader's page; it does not permit transfers to any other
            address, and you can withdraw it at any time.
          </p>
        </div>
        <nav className="flex md:flex-col gap-x-5 gap-y-1.5 text-[12px]" aria-label="Footer">
          <a href={href("/")} className="text-muted-foreground hover:text-foreground">
            Roster
          </a>
          <a href={href("/apply")} className="text-muted-foreground hover:text-foreground">
            Get listed
          </a>
          <a
            href="https://fomo.family"
            target="_blank"
            rel="noreferrer noopener"
            className="text-muted-foreground hover:text-foreground"
          >
            fomo ↗
          </a>
        </nav>
      </div>
    </footer>
  );
}
