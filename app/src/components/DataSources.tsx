import { cn } from "@/lib/utils";

/**
 * Where the numbers on this site come from, credited.
 *
 * # Why this is not decoration
 *
 * Every figure FOMV publishes is a claim about somebody's trading, made in
 * public, under their handle. The least a page making those claims can do is
 * say where it got them, in the same place it makes them.
 *
 * It is also the cheapest possible integrity check. A reader who knows the
 * prices came from on-chain candles rather than from the trader's own
 * screenshots can judge the grade for themselves; a reader who is told nothing
 * has to trust us, and this product's whole position is that they should not
 * have to.
 *
 * Listed here rather than typed into a footer so that adding a source is one
 * line, and so nothing can claim a provider the code does not actually call.
 */

interface Source {
  name: string;
  what: string;
  href?: string;
}

const SOURCES: Source[] = [
  {
    name: "Solana",
    what: "every trade, read from on-chain balance changes",
  },
  {
    name: "GeckoTerminal",
    what: "historical candles behind entry and exit quality",
    href: "https://www.geckoterminal.com",
  },
  {
    name: "DexScreener",
    what: "current prices, pool depth and token age",
    href: "https://dexscreener.com",
  },
  {
    name: "Jupiter",
    what: "quotes, sell simulation and execution",
    href: "https://jup.ag",
  },
];

export function DataSources({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-x-2 gap-y-2", className)}>
      <span className="term-label">data from</span>
      {SOURCES.map((s, i) => (
        <span key={s.name} className="flex items-center gap-2">
          {i > 0 && (
            <span aria-hidden className="text-faint/40">
              ·
            </span>
          )}
          {s.href ? (
            <a
              href={s.href}
              target="_blank"
              rel="noreferrer noopener"
              title={s.what}
              className="font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {s.name}
            </a>
          ) : (
            <span title={s.what} className="font-mono text-[11px] text-muted-foreground">
              {s.name}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
