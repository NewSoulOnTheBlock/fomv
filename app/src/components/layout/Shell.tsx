import { type ReactNode } from "react";

import { AccountChip } from "@/components/AccountChip";
import { Ticker } from "@/components/layout/Ticker";
import { cn } from "@/lib/utils";
import { href, type Route } from "@/lib/router";
import type { AppData, TraderProfile } from "@/lib/types";

/**
 * The frame every page sits in.
 *
 * # What used to be here
 *
 * A hairline readout strip sat above the header restating the network, the
 * roster count, the fee and the custody model on every route. Every figure on
 * it was true and read from the data file, and it was still clutter: three of
 * the four are answered by the hero's own figures a screen-height below, and a
 * bar of small grey type above the masthead is the first thing a visitor's eye
 * has to learn to skip.
 *
 * Nothing was lost by removing it. `custody: self` -- the one genuinely
 * load-bearing claim -- is still above the fold, set at 30px in the hero band
 * where it can actually be read.
 */

const NAV: { label: string; path: string; match: Route["name"][] }[] = [
  { label: "Roster", path: "/", match: ["roster", "trader"] },
  { label: "How it works", path: "/docs", match: ["docs"] },
  { label: "Get listed", path: "/apply", match: ["apply"] },
];

export function Shell({
  route,
  data,
  profiles,
  children,
}: {
  route: Route;
  data: AppData | null;
  profiles: Record<string, TraderProfile>;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Fixed, behind everything, and inert. See `.aurora` in styles.css. */}
      <div className="aurora" aria-hidden>
        <span className="a1" />
        <span className="a2" />
        <span className="a3" />
      </div>
      <div className="dither" aria-hidden />
      <Ticker data={data} profiles={profiles} />

      <Header route={route} />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-5 pb-24 sm:px-8">{children}</main>
      <Footer />
    </div>
  );
}

function Header({ route }: { route: Route }) {
  return (
    <header className="sticky top-0 z-30 border-b border-separator bg-background/60 backdrop-blur-2xl">
      

      <div className="relative mx-auto flex h-[68px] max-w-[1200px] items-center gap-2 px-5 sm:gap-10 sm:px-8">
        <a href={href("/")} className="group flex shrink-0 items-center gap-3">
          <img
            src="/mark-72.png"
            srcSet="/mark-72.png 1x, /mark-144.png 2x"
            alt=""
            width={30}
            height={30}
            decoding="async"
            className="block size-[30px] shrink-0"
          />
          <span className="hidden flex-col leading-none sm:flex">
            <span className="text-[21px] font-bold leading-none tracking-[-0.03em]">
              FOM<span className="text-primary">V</span>
            </span>
            <span className="term-label mt-1 hidden md:block">fear of missing vault</span>
          </span>
        </a>

        {/*
          Three items plus a wordmark plus a sign-in control do not fit at
          phone width. The nav scrolls inside itself rather than pushing the
          page wider, which keeps every destination reachable without hiding
          any of them behind a menu nobody opens.
        */}
        <nav
          className="-mx-1 flex min-w-0 shrink items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Main"
        >
          {NAV.map((item) => {
            const active = item.match.includes(route.name);
            return (
              <a
                key={item.path}
                href={href(item.path)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "whitespace-nowrap rounded-full px-3 py-1.5 text-[13.5px] font-medium transition-all sm:px-4 sm:text-[14px]",
                  active
                    ? "bg-white/[0.08] text-foreground shadow-[inset_0_1px_0_var(--highlight)]"
                    : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                )}
              >
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
    <footer className="mt-auto border-t border-separator">
      <div className="mx-auto grid max-w-[1200px] gap-8 px-5 py-12 sm:px-8 md:grid-cols-[1fr_auto] md:items-start">
        <div className="max-w-2xl space-y-4">
          <div className="text-[19px] font-bold tracking-[-0.03em]">FOMV</div>
          <p className="text-[13px] leading-relaxed text-faint">
            Copy-trading replicates another account's transactions at the operator's sole
            direction. Nothing here is investment advice, and a published grade is a measurement of
            the past, not a forecast. Authorising FOMV lets it sign swaps on your wallet under the
            guardrails printed on each trader's page; it does not permit transfers to any other
            address, and you can withdraw it at any time.
          </p>
        </div>
        <nav className="flex gap-x-7 gap-y-2.5 text-[13px] md:flex-col" aria-label="Footer">
          <a href={href("/")} className="text-muted-foreground hover:text-foreground">
            Roster
          </a>
          <a href={href("/docs")} className="text-muted-foreground hover:text-foreground">
            How it works
          </a>
          <a href={href("/apply")} className="text-muted-foreground hover:text-foreground">
            Get listed
          </a>
          <a
            href="https://fomo.family"
            target="_blank"
            rel="noreferrer noopener"
            className="group inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
          >
            {/* The mark ships pale lavender on transparent; dimmed to sit with
                the rest of the footer and lit on hover like the label. */}
            <img
              src="/logos/fomo.png"
              alt=""
              width={17}
              height={11}
              decoding="async"
              loading="lazy"
              className="h-[11px] w-auto opacity-55 transition-opacity group-hover:opacity-100"
            />
            fomo ↗
          </a>
        </nav>
      </div>

      {/*
        A partnership credit, kept apart from the data attribution on the
        roster page on purpose. That line says where the numbers came from and
        every name on it is a provider the code actually calls; this one says
        who FOMV is built with. Running them together would turn a credit into
        a claim about the pipeline.
      */}
      <div className="border-t border-separator">
        <a
          href="https://www.fomoscan.sh"
          target="_blank"
          rel="noreferrer noopener"
          className="group mx-auto flex max-w-[1200px] items-center justify-center gap-2.5 px-5 py-5 sm:px-8"
        >
          <span className="term-label">powered by</span>
          {/* The icon has no alpha -- it is a square with its own dark ground.
              Rounded and ringed so the edge reads as deliberate rather than as
              a sprite that failed to cut out. */}
          <img
            src="/logos/fomoscan.webp"
            alt=""
            width={18}
            height={18}
            decoding="async"
            loading="lazy"
            className="size-[18px] rounded-[5px] ring-1 ring-white/10"
          />
          <span className="font-mono text-[13px] text-muted-foreground transition-colors group-hover:text-foreground">
            fomoscan
          </span>
        </a>
      </div>
    </footer>
  );
}
