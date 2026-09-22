import { Panel, PanelBody, PanelHead } from "@/components/term";
import { cn } from "@/lib/utils";
import type { PriceSource } from "@/lib/types";

/**
 * Where the prices behind entry and exit quality came from.
 *
 * # Why this is on the page and not only in the provenance
 *
 * Those two dimensions ask what a token did *after* the trader acted, which a
 * trade log cannot answer. There are two possible sources and they do not mean
 * the same thing. Candles observe every interval whether or not anyone traded
 * in it. The trader's own fills observe only the moments that provoked a
 * trade -- and a trader acts when price moves, so that sample is biased toward
 * flattering them. Capture ratio measured against it is close to asking "did
 * you sell near the best price you yourself traded at".
 *
 * A reader comparing two traders is therefore entitled to know which they are
 * looking at, in the same eyeline as the numbers it changes. Burying it in a
 * caveat list at the bottom of the page would be technically honest and
 * practically not.
 */
export function PriceSourceNote({
  source,
  className,
}: {
  source: PriceSource | undefined;
  className?: string;
}) {
  // A profile computed before the feed existed does not record its source.
  // Saying so is the only honest option: assuming "fills" would be right today
  // and wrong the moment an older file from a run that did have a feed is
  // restored, and the claim would be unverifiable either way.
  if (!source) {
    return (
      <Panel className={className}>
        <PanelHead label="price source" aside="not recorded" />
        <PanelBody>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            This profile was computed before the price source was recorded, so the two figures
            above cannot be attributed to either the market or the trader's own fills. Re-run{" "}
            <code className="font-mono text-foreground">cli.ts profile</code> to get an attributed
            reading.
          </p>
        </PanelBody>
      </Panel>
    );
  }

  if (source.degraded) {
    return (
      <Panel className={cn("border-warn/30", className)}>
        <PanelHead label="price source" aside="observed fills" className="border-warn/20" />
        <PanelBody className="space-y-2">
          <p className="text-[17px] leading-relaxed text-foreground">
            The two figures above were measured against{" "}
            <span className="text-warn">this trader's own fills</span>, not against the market.
          </p>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            No candle feed was configured when this profile was computed, so the only prices
            available after an entry are ones the trader themselves traded at. They act when price
            moves, which biases both dimensions in their favour — read them as an upper bound
            rather than a measurement.
          </p>
        </PanelBody>
      </Panel>
    );
  }

  const pct = source.tokensRequested
    ? Math.round((source.tokensCovered / source.tokensRequested) * 100)
    : 0;

  return (
    <Panel className={className}>
      <PanelHead label="price source" aside={source.feed} />
      <PanelBody className="space-y-3">
        <p className="text-[17px] leading-relaxed">
          Measured against <span className="text-pos">the market</span>, not against their own
          fills.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <Figure label="resolution" value={readable(source.resolution)} />
          <Figure label="candles" value={source.candles.toLocaleString()} />
          <Figure
            label="token coverage"
            value={`${source.tokensCovered}/${source.tokensRequested}`}
            sub={`${pct}%`}
          />
        </div>
        <p className="text-[13px] leading-relaxed text-faint">
          A peak between entry and exit is taken from the high of the candle containing it, so it
          includes moves the trader slept through. Any token the feed could not serve falls back to
          their fills, and is counted in the coverage above.
        </p>
      </PanelBody>
    </Panel>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="term-label">{label}</div>
      <div className="mt-2.5 font-mono text-[26px] leading-none">{value}</div>
      {sub && <div className="mt-2 text-[12px] text-faint">{sub}</div>}
    </div>
  );
}

/** `minute15` is how the engine names it; `15m candles` is how a person does. */
function readable(resolution: string | null): string {
  if (!resolution) return "—";
  const m = /^(minute|hour|day)(\d+)$/.exec(resolution);
  if (!m) return resolution;
  const unit = m[1] === "minute" ? "m" : m[1] === "hour" ? "h" : "d";
  return `${m[2]}${unit}`;
}
