import {
  BucketBars,
  Callout,
  LeaderRow,
  Panel,
  PanelBody,
  PanelHead,
  ScoreBar,
  SectionRule,
  Stat,
} from "@/components/term";
import {
  bandColor,
  count,
  duration,
  EMPTY,
  pct,
  ratio,
  relative,
  score,
  signOf,
  signedUsd,
  span,
  usd,
} from "@/lib/format";
import type { DimensionName, TraderProfile } from "@/lib/types";

/**
 * The trader ability audit.
 *
 * Built around one claim: a P&L figure is not a measurement of skill. The Edge
 * Score is the centrepiece precisely so that "made $24,630" is never the
 * headline, and every panel below exists to say something P&L cannot --
 * whether the wins outweigh the losses, how much of the book was risked to get
 * them, how deep the hole got on the way, and how much of any of it is
 * repeatable.
 *
 * Unmeasured values render as an em dash and unmeasured dimensions render as a
 * hatched bar. Neither is ever drawn as a zero.
 *
 * The dimension icons are three-letter codes rather than emoji. An emoji in a
 * column of figures is the single loudest thing on the page and it is attached
 * to the least quantitative part of it; a code is legible at 10px, sorts, and
 * does not render differently on two operating systems.
 */

const DIMENSIONS: Record<DimensionName, { code: string; title: string; blurb: string }> = {
  profitability: {
    code: "PRF",
    title: "Profitability",
    blurb: "Profit factor and the typical trade's return",
  },
  risk: {
    code: "RSK",
    title: "Risk management",
    blurb: "Drawdown, position size, and win-versus-loss size",
  },
  entry: {
    code: "ENT",
    title: "Entry skill",
    blurb: "Where the token went after they bought",
  },
  exit: {
    code: "EXT",
    title: "Exit skill",
    blurb: "How much of the available move they actually took",
  },
  consistency: {
    code: "CNS",
    title: "Consistency",
    blurb: "Stability across time and across tokens",
  },
};

const ORDER: DimensionName[] = ["profitability", "risk", "entry", "exit", "consistency"];

export function Audit({ data }: { data: TraderProfile }) {
  const { profile: p, provenance: prov } = data;
  const c = p.core;

  return (
    <div>
      <EdgeHeadline data={data} />

      <SectionRule aside="0-100 each">Ability dimensions</SectionRule>
      <Panel>
        <div className="divide-y divide-border">
          {ORDER.map((name) => (
            <Dimension key={name} name={name} value={p.dimensions[name]} profile={data} />
          ))}
        </div>
        <div className="border-t border-border px-4 py-3 text-[12px] leading-relaxed text-faint">
          A hatched bar is a dimension that could not be measured from the available data. The Edge
          Score is re-weighted over the dimensions that were, so a gap lowers confidence rather
          than silently scoring zero.
        </div>
      </Panel>

      <SectionRule aside="ten figures">The core metrics</SectionRule>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border">
        <Metric
          n="01"
          k="Realised P&L"
          v={signedUsd(c.realizedPnlUsd)}
          tone={signOf(c.realizedPnlUsd) ? `var(--${signOf(c.realizedPnlUsd)})` : undefined}
          note={
            c.straddlingEpisodes > 0
              ? `${c.closedEpisodes} complete round trips · ${c.straddlingEpisodes} excluded`
              : `${c.closedEpisodes} complete round trips`
          }
        />
        <Metric n="02" k="Win rate" v={pct(c.winRate)} note={`${c.openEpisodes} still open`} />
        <Metric
          n="03"
          k="Profit factor"
          v={ratio(c.profitFactor)}
          note={
            c.profitFactor === null ? "no losing trades yet to divide by" : "gross profit ÷ gross loss"
          }
        />
        <Metric
          n="04"
          k="ROI per trade"
          v={pct(c.medianRoi, 0)}
          note={`median; the mean is ${pct(c.avgRoi, 0)}`}
        />
        <Metric
          n="05"
          k="Risk-adjusted return"
          v={ratio(c.roiStability)}
          note="mean ROI ÷ its own scatter"
        />
        <Metric
          n="06"
          k="Max drawdown"
          v={pct(c.maxDrawdown)}
          note={c.maxDrawdownUsd === null ? "never above water" : `${usd(c.maxDrawdownUsd)} off peak`}
          tone={
            c.maxDrawdown === null
              ? undefined
              : c.maxDrawdown > 0.4
                ? "var(--neg)"
                : c.maxDrawdown > 0.2
                  ? "var(--warn)"
                  : "var(--pos)"
          }
        />
        <Metric
          n="07"
          k="Avg win vs avg loss"
          v={ratio(c.rewardToRisk)}
          note={`${usd(c.avgWinUsd, { compact: true })} against ${usd(c.avgLossUsd, { compact: true })}`}
          tone={c.rewardToRisk === null ? undefined : c.rewardToRisk >= 1 ? "var(--pos)" : "var(--warn)"}
        />
        <Metric
          n="08"
          k="Entry quality"
          v={pct(p.entry.roiByHorizon["3600"] ?? null, 0)}
          note={`+1h after entry · ${p.entry.sampleSize}/${p.entry.population} judged`}
        />
        <Metric
          n="09"
          k="Exit quality"
          v={pct(p.exit.captureRatio, 0)}
          note={`of the available move · ${p.exit.sampleSize}/${p.exit.population} judged`}
        />
      </div>

      <SectionRule>Skill versus exposure</SectionRule>
      <SkillExposure data={data} />

      <div className="grid lg:grid-cols-2 gap-3 mt-3">
        <EntryDetail data={data} />
        <ExitDetail data={data} />
      </div>

      {c.consistency.buckets > 0 && (
        <>
          <SectionRule aside={`${c.consistency.buckets} periods`}>Consistency over time</SectionRule>
          <Panel>
            <PanelBody>
              <BucketBars values={c.consistency.bucketPnlUsd} />
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-4">
                <Stat
                  label="profitable periods"
                  value={pct(c.consistency.profitableBucketRate, 0)}
                  size="sm"
                />
                <Stat
                  label="variation between them"
                  value={ratio(c.consistency.bucketVariation)}
                  size="sm"
                  sub="lower is steadier"
                />
                <Stat
                  label="tokens in profit"
                  value={pct(c.consistency.profitableTokenRate, 0)}
                  size="sm"
                />
              </div>
            </PanelBody>
          </Panel>
        </>
      )}

      {(p.flags.length > 0 || p.gaps.length > 0) && (
        <>
          <SectionRule aside={`${p.flags.length + p.gaps.length} items`}>
            What to read carefully
          </SectionRule>
          <Panel>
            <PanelBody className="space-y-2">
              {p.flags.map((f) => (
                <Callout tone="warn" key={f}>
                  {f}
                </Callout>
              ))}
              {p.gaps.map((g) => (
                <Callout tone="gap" key={g}>
                  {g}
                </Callout>
              ))}
            </PanelBody>
          </Panel>
        </>
      )}

      <SectionRule aside={`computed ${relative(prov.computedAtMs)}`}>
        Where these numbers come from
      </SectionRule>
      <Panel>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-y divide-border [&>*]:p-3 [&>*]:-mt-px [&>*]:-ml-px">
          <Stat label="swaps decoded" value={count(prov.trades)} size="sm" />
          <Stat label="window" value={span(prov.windowFromMs, prov.windowToMs)} size="sm" />
          <Stat label="tokens priced" value={count(prov.tokensPriced)} size="sm" />
          <Stat label="price reads" value={count(prov.priceObservations)} size="sm" />
          <Stat
            label="round trips used"
            value={count(c.closedEpisodes)}
            size="sm"
            sub={c.straddlingEpisodes > 0 ? `${c.straddlingEpisodes} excluded` : "all complete"}
          />
          <Stat
            label="still open"
            value={count(c.openEpisodes)}
            size="sm"
            sub="not in realised P&L"
          />
        </div>
        {prov.caveats.length > 0 && (
          <div className="border-t border-border p-4 space-y-2">
            {prov.caveats.map((cv) => (
              <Callout tone="gap" key={cv}>
                {cv}
              </Callout>
            ))}
          </div>
        )}
        <div className="border-t border-border px-4 py-3 text-[12px] text-faint">
          Book value {usd(prov.equityUsd, { compact: true })} at the time of the audit. Every figure
          above is derived from on-chain history, not self-reported.
        </div>
      </Panel>
    </div>
  );
}

function EdgeHeadline({ data }: { data: TraderProfile }) {
  const { profile: p, provenance: prov } = data;
  const c = p.core;

  return (
    <Panel className="mt-6">
      <PanelHead label="trader edge score" aside={`${count(prov.trades)} swaps decoded`} />
      <div className="grid md:grid-cols-[260px_1fr] divide-y md:divide-y-0 md:divide-x divide-border">
        <div className="p-5 flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono text-[64px] leading-[0.85] font-bold tracking-[-0.05em]"
              style={{ color: bandColor(p.edgeScore) }}
            >
              {score(p.edgeScore)}
            </span>
            <span className="term-label">/100</span>
          </div>
          <ScoreBar value={p.edgeScore} />
          <div
            className="term-label !text-[11px]"
            style={{ color: bandColor(p.edgeScore) }}
          >
            {p.grade === "insufficient-data" ? "not enough data to grade" : `grade ${p.grade}`}
          </div>
        </div>

        <div className="min-w-0">
          <div className="grid grid-cols-2 sm:grid-cols-3 divide-x divide-y divide-border [&>*]:p-3 [&>*]:-mt-px [&>*]:-ml-px">
            <Stat label="win rate" value={pct(c.winRate, 1)} size="sm" />
            <Stat label="profit factor" value={ratio(c.profitFactor)} size="sm" />
            <Stat label="median roi" value={pct(c.medianRoi, 0)} size="sm" />
            <Stat label="max drawdown" value={pct(c.maxDrawdown)} size="sm" />
            <Stat label="entry efficiency" value={pct(asFraction(p.dimensions.entry), 0)} size="sm" />
            <Stat label="exit efficiency" value={pct(asFraction(p.dimensions.exit), 0)} size="sm" />
          </div>
          <div className="border-t border-border px-4 py-3 text-[12px] leading-relaxed text-faint">
            Realised P&L over this window was{" "}
            <span
              className="font-mono"
              style={{ color: signOf(c.realizedPnlUsd) ? `var(--${signOf(c.realizedPnlUsd)})` : undefined }}
            >
              {signedUsd(c.realizedPnlUsd)}
            </span>{" "}
            — deliberately not the headline. A P&L leaderboard rewards whoever took the most risk
            and happened to survive.
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** Dimension scores are 0-100; the headline shows them as efficiencies. */
function asFraction(v: number | null): number | null {
  return v === null ? null : v / 100;
}

function Dimension({
  name,
  value,
  profile,
}: {
  name: DimensionName;
  value: number | null;
  profile: TraderProfile;
}) {
  const meta = DIMENSIONS[name];

  return (
    <div className="grid sm:grid-cols-[52px_1fr_auto] items-center gap-x-4 gap-y-2 px-4 py-3">
      <span className="font-mono text-[11px] tracking-[0.1em] text-faint">{meta.code}</span>

      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className="text-[13px] font-medium">{meta.title}</span>
          <span
            className="font-mono text-[13px] sm:hidden"
            style={{ color: value === null ? "var(--faint)" : bandColor(value) }}
          >
            {score(value)}
          </span>
        </div>
        <ScoreBar value={value} />
        <div className="mt-1.5 text-[11px] leading-snug text-faint">
          {value === null ? unmeasuredReason(name, profile) : meta.blurb}
        </div>
      </div>

      <span
        className="hidden sm:block font-mono text-lg tabular-nums text-right w-12"
        style={{ color: value === null ? "var(--faint)" : bandColor(value) }}
      >
        {score(value)}
      </span>
    </div>
  );
}

function unmeasuredReason(name: DimensionName, data: TraderProfile): string {
  const hit = data.profile.gaps.find((g) => g.toLowerCase().startsWith(gapPrefix(name)));
  return hit ?? "Not measurable from the available data";
}

function gapPrefix(name: DimensionName): string {
  switch (name) {
    case "entry":
      return "entry quality";
    case "exit":
      return "exit quality";
    case "consistency":
      return "consistency";
    case "risk":
      return "max drawdown";
    default:
      return "profit";
  }
}

function SkillExposure({ data }: { data: TraderProfile }) {
  const s = data.profile.skillVsExposure;
  const c = data.profile.core;

  return (
    <Panel>
      <div className="px-4 py-3 border-b border-border text-[12px] leading-relaxed text-muted-foreground">
        The same dollars earned on 4% position sizes and on 40% position sizes are not the same
        result. For someone mirroring this book the difference is the whole product: exposure
        decides what a drawdown feels like, whatever the return.
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y divide-border [&>*]:p-3 [&>*]:-mt-px [&>*]:-ml-px">
        <Stat
          label="typical position"
          value={pct(s.avgPeakWeight, 2)}
          size="sm"
          sub="of the trader's book"
        />
        <Stat
          label="largest position"
          value={pct(s.maxPeakWeight, 2)}
          size="sm"
          sub="peak weight in one name"
        />
        <Stat
          label="median trade roi"
          value={pct(c.medianRoi, 0)}
          size="sm"
          sub="selection, not sizing"
        />
        <Stat
          label="top trade's share"
          value={pct(s.topEpisodeShare, 0)}
          size="sm"
          sub={s.concentrated ? "one position carries the record" : "profit spread across trades"}
          tone={s.concentrated ? "var(--warn)" : undefined}
        />
      </div>
      {s.concentrated && (
        <div className="border-t border-border p-4">
          <Callout tone="warn">
            A single position accounts for {pct(s.topEpisodeShare, 0)} of all profit. That is a
            result, not yet a demonstrated process.
          </Callout>
        </div>
      )}
    </Panel>
  );
}

function EntryDetail({ data }: { data: TraderProfile }) {
  const e = data.profile.entry;
  const horizons: [string, string][] = [
    ["3600", "+1h"],
    ["21600", "+6h"],
    ["86400", "+24h"],
  ];
  const multiples: [string, string][] = [
    ["0.25", "+25%"],
    ["0.5", "+50%"],
    ["1", "+100%"],
  ];

  return (
    <Panel>
      <PanelHead label="ENT · entry skill detail" aside={`${e.sampleSize}/${e.population}`} />
      <PanelBody>
        {horizons.map(([k, label]) => (
          <LeaderRow key={k} label={`Return ${label} after entry`} value={pct(e.roiByHorizon[k] ?? null, 1)} />
        ))}
        {multiples.map(([k, label]) => (
          <LeaderRow
            key={k}
            label={`Entries that later hit ${label}`}
            value={pct(e.hitRateByMultiple[k] ?? null, 0)}
          />
        ))}
        <LeaderRow label="Median time to peak" value={duration(e.medianTimeToPeakSec)} />
        <p className="mt-3 text-[11px] leading-snug text-faint">
          {e.sampleSize} of {e.population} entries had prices observable afterwards.
        </p>
      </PanelBody>
    </Panel>
  );
}

function ExitDetail({ data }: { data: TraderProfile }) {
  const x = data.profile.exit;

  return (
    <Panel>
      <PanelHead label="EXT · exit skill detail" aside={`${x.sampleSize}/${x.population}`} />
      <PanelBody>
        <LeaderRow label="Upside captured (median)" value={pct(x.captureRatio, 0)} />
        <LeaderRow label="The same figure, mean" value={pct(x.captureRatioMean, 0)} />
        <LeaderRow label="Move left on the table after exit" value={pct(x.avgReturnAfterExit, 1)} />
        <LeaderRow label="Exits followed by a further rise" value={pct(x.prematureExitRate, 0)} />
        <p className="mt-3 text-[11px] leading-snug text-faint">
          {x.sampleSize} of {x.population} exits had prices observable afterwards. Each episode's
          capture is clamped before aggregation, so one catastrophic exit cannot define the
          dimension.
        </p>
      </PanelBody>
    </Panel>
  );
}

function Metric({
  n,
  k,
  v,
  note,
  tone,
}: {
  n: string;
  k: string;
  v: string;
  note?: string;
  tone?: string;
}) {
  return (
    <div className="bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="term-label">{k}</span>
        <span className="font-mono text-[10px] text-faint">{n}</span>
      </div>
      <div
        className="mt-1.5 font-mono text-[22px] leading-none tracking-[-0.03em]"
        style={tone ? { color: tone } : undefined}
      >
        {v === EMPTY ? <span className="text-faint">{EMPTY}</span> : v}
      </div>
      {note && <div className="mt-2 text-[11px] leading-snug text-faint">{note}</div>}
    </div>
  );
}
