import { type ReactNode } from "react";

import { DEFAULT_FEE_TERMS } from "@engine/follow/fees.js";
import { LISTING_TERMS } from "@engine/platform/listing.js";
import { AccountChip } from "@/components/AccountChip";
import { cn } from "@/lib/utils";
import { bps, relative } from "@/lib/format";
import { href, type Route } from "@/lib/router";
import type { AppData } from "@/lib/types";

/**
 * The frame every page sits in.
 *
 * # The readout strip
 *
 * The hairline bar above the header is the one flourish in the product, and it
 * earns its place by being true: every figure on it is read from the data file
 * rather than typed into the markup. It answers, before the page has made any
 * argument, the four questions a visitor would otherwise have to hunt for --
 * which network, how many traders, what it costs, and who holds the funds.
 *
 * `CUSTODY SELF` is the most consequential string on the site and it is
 * deliberate that it appears above the fold on every route.
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
    <div className="grain vignette flex min-h-screen flex-col">
      <ReadoutStrip data={data} />
      <Header route={route} />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-5 pb-24 sm:px-8">{children}</main>
      <Footer />
    </div>
  );
}

function ReadoutStrip({ data }: { data: AppData | null }) {
  const cells: [string, ReactNode][] = [
    ["net", data?.platform.cluster ?? "—"],
    ["roster", data ? `${data.roster.length}/${LISTING_TERMS.maxRoster}` : "—"],
    ["fee", `${bps(DEFAULT_FEE_TERMS.tradeFeeBps)} per trade`],
    ["custody", <span className="text-pos">self</span>],
  ];

  return (
    <div className="border-b border-border bg-[#050507]">
      <div className="mx-auto flex h-9 max-w-[1200px] items-center gap-6 overflow-x-auto px-5 sm:px-8">
        {cells.map(([k, v]) => (
          <span key={k} className="flex shrink-0 items-baseline gap-2">
            <span className="term-label">{k}</span>
            <span className="font-mono text-[12px] text-secondary-foreground">{v}</span>
          </span>
        ))}
        <span className="term-label ml-auto hidden shrink-0 sm:block">
          data {data ? relative(data.generatedAtMs) : "—"}
        </span>
      </div>
    </div>
  );
}

function Header({ route }: { route: Route }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="term-grid pointer-events-none absolute inset-0 opacity-50" aria-hidden />

      <div className="relative mx-auto flex h-[68px] max-w-[1200px] items-center gap-4 px-5 sm:gap-10 sm:px-8">
        <a href={href("/")} className="group flex min-w-0 shrink items-center gap-3">
          <img
            src="/mark-72.png"
            srcSet="/mark-72.png 1x, /mark-144.png 2x"
            alt=""
            width={30}
            height={30}
            decoding="async"
            className="block size-[30px] shrink-0"
          />
          <span className="flex flex-col leading-none">
            {/* Bodoni's thins vanish at small sizes on a dark ground, so the
                wordmark is set heavy where body copy is set regular. */}
            <span
              className="display text-[27px] leading-none tracking-[0.01em]"
              // `font-variation-settings` overrides `font-weight` outright, so the
              // weight has to travel on the axis or it silently stays at 400.
              style={{ fontVariationSettings: '"opsz" 96, "wght" 700' }}
            >
              FOM<span className="text-primary">V</span>
            </span>
            <span className="term-label mt-1 hidden md:block">fear of missing vault</span>
          </span>
        </a>

        <nav className="flex shrink-0 items-center gap-1" aria-label="Main">
          {NAV.map((item) => {
            const active = item.match.includes(route.name);
            return (
              <a
                key={item.path}
                href={href(item.path)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "whitespace-nowrap px-2 py-1 font-mono text-[13px] tracking-wide transition-colors sm:px-3",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {active && <span className="mr-1.5 text-primary">▸</span>}
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          <AccountChip />
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="engraved mt-auto">
      <div className="mx-auto grid max-w-[1200px] gap-8 px-5 py-12 sm:px-8 md:grid-cols-[1fr_auto] md:items-start">
        <div className="max-w-2xl space-y-4">
          <div className="display text-[28px]">FOMV</div>
          <p className="text-[13px] leading-relaxed text-faint">
            Copy-trading replicates another account's transactions at the operator's sole
            direction. Nothing here is investment advice, and a published grade is a measurement of
            the past, not a forecast. Authorising FOMV lets it sign swaps on your wallet under the
            guardrails printed on each trader's page; it does not permit transfers to any other
            address, and you can withdraw it at any time.
          </p>
          <div className="flex flex-wrap gap-x-7 gap-y-1 font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
            <span>non-custodial</span>
            <span>solana only</span>
            <span>no deposit</span>
          </div>
        </div>
        <nav className="flex gap-x-7 gap-y-2.5 text-[13px] md:flex-col" aria-label="Footer">
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
