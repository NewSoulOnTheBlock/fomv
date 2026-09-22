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
import { PriceSourceNote } from "@/components/trader/PriceSourceNote";
import { WithheldGrade } from "@/components/trader/WithheldGrade";
import { DIMENSION_META } from "@/lib/dimensions";
import { PENTAGON_ORDER } from "@/components/viz/EdgePentagon";
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
import { DEFAULT_ABILITY } from "@engine/scoring/ability.js";
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

const ORDER: DimensionName[] = PENTAGON_ORDER;

/**
 * Closed round trips the scorer needs before it will grade at all.
 *
 * Mirrors `DEFAULT_ABILITY.minClosedEpisodes`. Read from the engine rather
 * than typed here, so the number the page promises and the number the scorer
 * enforces cannot drift apart.
 */
const MIN_CLOSED_EPISODES = DEFAULT_ABILITY.minClosedEpisodes;

export function Audit({ data }: { data: TraderProfile }) {
  const { profile: p, provenance: prov } = data;
  const c = p.core;
  // The scorer withholds every dimension together below the floor, so one
  // null is the same signal as five.
  const withheld = p.grade === "insufficient-data";
  // The refusal is the headline of its own block above; repeating it here
  // would be the third place the same sentence appears on one page.
  const shownFlags = p.flags.filter((f) => !(withheld && /closed positions/i.test(f)));

  return (
    <div>
      <SectionRule index="01" aside={withheld ? "withheld" : "0-100 each"}>
        Ability dimensions
      </SectionRule>
      {withheld ? (
        // One statement of the refusal, not five repetitions of a non-answer.
        <WithheldGrade
          core={c}
          required={MIN_CLOSED_EPISODES}
          reason={p.flags.find((f) => /closed positions/i.test(f))}
        />
      ) : (
        <Panel>
          <div className="divide-y divide-border">
            {ORDER.map((name) => (
              <Dimension key={name} name={name} value={p.dimensions[name]} profile={data} />
            ))}
          </div>
          <div className="border-t border-border px-5 py-4 text-[14px] leading-relaxed text-faint">
            A hatched bar is a dimension that could not be measured from the available data. The
            Edge Score is re-weighted over the dimensions that were, so a gap lowers confidence
            rather than silently scoring zero.
          </div>
        </Panel>
      )}

      <SectionRule index="02" aside="ten figures">The core metrics</SectionRule>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-px bg-border border border-border">
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
        <Metric
          n="10"
          k="Consistency"
          v={p.dimensions.consistency === null ? EMPTY : score(p.dimensions.consistency)}
          note={`${c.consistency.buckets} time ${c.consistency.buckets === 1 ? "bucket" : "buckets"} observed`}
        />
      </div>

      <SectionRule index="03">Skill versus exposure</SectionRule>
      <SkillExposure data={data} />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <EntryDetail data={data} />
        <ExitDetail data={data} />
      </div>
      <PriceSourceNote source={prov.priceSource} className="mt-4" />

      {c.consistency.bucketPnlUsd.length > 0 && (
        <>
          <SectionRule
            index="04"
            aside={`${c.consistency.buckets} ${c.consistency.buckets === 1 ? "period" : "periods"}`}
          >
            Consistency over time
          </SectionRule>
          <Panel>
            <PanelBody>
              {c.consistency.bucketPnlUsd.length >= 3 ? (
                <BucketBars values={c.consistency.bucketPnlUsd} />
              ) : (
                <p className="text-[12px] leading-relaxed text-faint">
                  Too few periods to plot. A chart of one observation draws a shape that is not
                  there, so the figures are given on their own until there are at least three.
                </p>
              )}
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

      {(shownFlags.length > 0 || p.gaps.length > 0) && (
        <>
          <SectionRule index="05" aside={`${shownFlags.length + p.gaps.length} items`}>
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

      <SectionRule index="06" aside={`computed ${relative(prov.computedAtMs)}`}>
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
        <div className="border-t border-border px-5 py-4 text-[14px] text-faint">
          Book value {usd(prov.equityUsd, { compact: true })} at the time of the audit. Every figure
          above is derived from on-chain history, not self-reported.
        </div>
      </Panel>
    </div>
  );
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
  const meta = DIMENSION_META[name];

  return (
    <div className="grid items-center gap-x-5 gap-y-3 px-5 py-4 sm:grid-cols-[48px_1fr_auto]">
      <span className="font-mono text-[12px] tracking-[0.12em] text-faint">{meta.code}</span>

      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className="text-[16px] font-medium">{meta.label}</span>
          <span
            className="font-mono text-[18px] sm:hidden"
            style={{ color: value === null ? "var(--faint)" : bandColor(value) }}
          >
            {score(value)}
          </span>
        </div>
        <ScoreBar value={value} animate />
        <div className="mt-2.5 text-[13px] leading-snug text-faint">
          {value === null ? unmeasuredReason(name, profile) : meta.blurb}
        </div>
      </div>

      <span
        className="hidden w-14 text-right font-mono text-[24px] leading-none tabular-nums sm:block"
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
      <div className="border-b border-border px-5 py-4 text-[15px] leading-relaxed text-muted-foreground">
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
        <p className="mt-4 text-[13px] leading-snug text-faint">
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
        <p className="mt-4 text-[13px] leading-snug text-faint">
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
    <div className="bg-card p-5">
      {/* Reserved for two lines, so a label that wraps does not push its own
          figure out of line with the rest of the row. */}
      <div className="flex min-h-[26px] items-start justify-between gap-2">
        <span className="term-label">{k}</span>
        <span className="font-mono text-[10px] text-faint">{n}</span>
      </div>
      <div
        className="mt-2.5 font-mono text-[26px] leading-none tracking-[-0.03em]"
        style={tone ? { color: tone } : undefined}
      >
        {v === EMPTY ? <span className="text-faint">{EMPTY}</span> : v}
      </div>
      {note && <div className="mt-3 text-[12.5px] leading-snug text-faint">{note}</div>}
    </div>
  );
}
