import type { DimensionName, TraderProfile } from "../lib/types";
import { bandOf, duration, EMPTY, pct, ratio, relative, score, span, usd } from "../lib/format";

/**
 * The trader ability dashboard.
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
 */

const DIMENSION_LABELS: Record<DimensionName, { title: string; icon: string; blurb: string }> = {
  entry: { title: "Entry Skill", icon: "🎯", blurb: "Where the token went after they bought" },
  profitability: { title: "Profitability", icon: "💰", blurb: "Profit factor and the typical trade's return" },
  risk: { title: "Risk Management", icon: "🛡️", blurb: "Drawdown, position size, and win-versus-loss size" },
  exit: { title: "Exit Skill", icon: "🚪", blurb: "How much of the available move they actually took" },
  consistency: { title: "Consistency", icon: "🧠", blurb: "Stability across time and across tokens" },
};

const ORDER: DimensionName[] = ["profitability", "risk", "entry", "exit", "consistency"];

export function Dashboard({ data }: { data: TraderProfile }) {
  const { profile: p, provenance: prov } = data;
  const c = p.core;
  const band = bandOf(p.edgeScore);

  return (
    <div>
      <EdgeHeadline data={data} />

      <h2>Ability dimensions</h2>
      <div className="card">
        {ORDER.map((name) => (
          <Dimension key={name} name={name} value={p.dimensions[name]} profile={data} />
        ))}
        <p className="small faint" style={{ marginTop: "1rem", marginBottom: 0 }}>
          A hatched bar is a dimension that could not be measured from the available data. The Edge
          Score is re-weighted over the dimensions that were, so a gap lowers confidence rather than
          silently scoring zero.
        </p>
      </div>

      <h2>The ten core metrics</h2>
      <div className="metrics">
        <Metric
          n="01"
          k="Realized P&L"
          v={usd(c.realizedPnlUsd)}
          note={
            c.straddlingEpisodes > 0
              ? `${c.closedEpisodes} complete round trips · ${c.straddlingEpisodes} excluded`
              : `${c.closedEpisodes} complete round trips`
          }
        />
        <Metric n="02" k="Win Rate" v={pct(c.winRate)} note={`${c.openEpisodes} still open`} />
        <Metric
          n="03"
          k="Profit Factor"
          v={ratio(c.profitFactor)}
          note={c.profitFactor === null ? "no losing trades yet to divide by" : "gross profit ÷ gross loss"}
        />
        <Metric
          n="04"
          k="Avg ROI / Trade"
          v={pct(c.medianRoi, 0)}
          note={`median; mean is ${pct(c.avgRoi, 0)}`}
        />
        <Metric
          n="05"
          k="Risk-Adjusted Return"
          v={ratio(c.roiStability)}
          note="mean ROI ÷ its own scatter"
        />
        <Metric
          n="06"
          k="Max Drawdown"
          v={pct(c.maxDrawdown)}
          note={c.maxDrawdownUsd === null ? "never above water" : `${usd(c.maxDrawdownUsd)} off peak`}
          band={c.maxDrawdown === null ? "none" : c.maxDrawdown > 0.4 ? "bad" : c.maxDrawdown > 0.2 ? "warn" : "good"}
        />
        <Metric
          n="07"
          k="Avg Win vs Avg Loss"
          v={ratio(c.rewardToRisk)}
          note={`${usd(c.avgWinUsd, { compact: true })} vs ${usd(c.avgLossUsd, { compact: true })}`}
          band={c.rewardToRisk === null ? "none" : c.rewardToRisk >= 1 ? "good" : "warn"}
        />
        <Metric
          n="08"
          k="Entry Quality"
          v={pct(p.entry.roiByHorizon["3600"] ?? null, 0)}
          note={`+1h after entry · ${p.entry.sampleSize}/${p.entry.population} judged`}
        />
        <Metric
          n="09"
          k="Exit Quality"
          v={pct(p.exit.captureRatio, 0)}
          note={`of the available move · ${p.exit.sampleSize}/${p.exit.population} judged`}
        />
        <Metric
          n="10"
          k="Consistency"
          v={p.dimensions.consistency === null ? EMPTY : score(p.dimensions.consistency)}
          note={`${c.consistency.buckets} time bucket${c.consistency.buckets === 1 ? "" : "s"} observed`}
        />
      </div>

      <h2>Skill versus exposure</h2>
      <SkillExposure data={data} />

      <div className="grid cols-2" style={{ marginTop: "1rem" }}>
        <EntryDetail data={data} />
        <ExitDetail data={data} />
      </div>

      {(p.flags.length > 0 || p.gaps.length > 0) && (
        <>
          <h2>What to read carefully</h2>
          <div className="card">
            {p.flags.map((f) => (
              <div className="callout flag" key={f}>
                {f}
              </div>
            ))}
            {p.gaps.map((g) => (
              <div className="callout gap" key={g}>
                {g}
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Where these numbers come from</h2>
      <div className="card">
        <div className="grid cols-4" style={{ marginBottom: "1rem" }}>
          <Stat k="Swaps decoded" v={prov.trades.toLocaleString()} />
          <Stat k="Window" v={span(prov.windowFromMs, prov.windowToMs)} />
          <Stat k="Tokens priced" v={prov.tokensPriced.toLocaleString()} />
          <Stat k="Price observations" v={prov.priceObservations.toLocaleString()} />
          <Stat
            k="Round trips used"
            v={`${c.closedEpisodes}`}
            sub={c.straddlingEpisodes > 0 ? `${c.straddlingEpisodes} excluded as incomplete` : "all complete"}
          />
          <Stat k="Still open" v={`${c.openEpisodes}`} sub="not counted in realised P&L" />
        </div>
        {prov.caveats.map((cv) => (
          <div className="callout gap" key={cv}>
            {cv}
          </div>
        ))}
        <p className="small faint" style={{ marginBottom: 0 }}>
          Book value {usd(prov.equityUsd, { compact: true })} · computed {relative(prov.computedAtMs)} ·{" "}
          <span className={`band-${band}`}>grade {p.grade}</span>
        </p>
      </div>
    </div>
  );
}

function EdgeHeadline({ data }: { data: TraderProfile }) {
  const { profile: p, provenance: prov } = data;
  const c = p.core;
  const band = bandOf(p.edgeScore);

  return (
    <div className="card edge">
      <div className="edge-dial">
        <div className="value" style={{ color: `var(--${band})` }}>
          {score(p.edgeScore)}
        </div>
        <div className="of">out of 100</div>
        <div className="grade" style={{ color: `var(--${band})` }}>
          {p.grade === "insufficient-data" ? "not enough data" : `grade ${p.grade}`}
        </div>
      </div>

      <div>
        <h3 style={{ marginBottom: "1rem" }}>Trader Edge Score</h3>
        <div className="headline">
          <Item k="Trades" v={prov.trades.toLocaleString()} />
          <Item k="Win rate" v={pct(c.winRate, 1)} />
          <Item k="Profit factor" v={ratio(c.profitFactor)} />
          <Item k="Median ROI" v={pct(c.medianRoi, 0)} />
          <Item k="Max drawdown" v={pct(c.maxDrawdown)} />
          <Item k="Entry efficiency" v={pct(pctOf(p.dimensions.entry), 0)} />
          <Item k="Exit efficiency" v={pct(pctOf(p.dimensions.exit), 0)} />
        </div>
        <p className="small faint" style={{ marginTop: "1rem", marginBottom: 0 }}>
          Realised P&L over this window was {usd(c.realizedPnlUsd)} — deliberately not the headline.
        </p>
      </div>
    </div>
  );
}

/** Dimension scores are 0-100; the headline shows them as efficiencies. */
function pctOf(v: number | null): number | null {
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
  const meta = DIMENSION_LABELS[name];
  const band = bandOf(value);
  return (
    <div className="dim">
      <div className="row">
        <span className="name">
          {meta.icon} {meta.title}
        </span>
        <span className="val" style={{ color: value === null ? "var(--text-faint)" : `var(--${band})` }}>
          {score(value)}
        </span>
      </div>
      <div className="track">
        {value === null ? (
          <div className="hatch" />
        ) : (
          <div className="fill" style={{ width: `${Math.max(1.5, value)}%`, background: `var(--${band})` }} />
        )}
      </div>
      <div className="why">{value === null ? unmeasuredReason(name, profile) : meta.blurb}</div>
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
    <div className="card">
      <p className="small muted" style={{ marginTop: 0 }}>
        The same dollars earned on 4% position sizes and on 40% position sizes are not the same
        result. For a pooled vault the difference is the whole product: exposure decides what a
        depositor's drawdown feels like, whatever the return.
      </p>
      <div className="grid cols-4">
        <Stat k="Typical position" v={pct(s.avgPeakWeight, 3)} sub="of the trader's book" />
        <Stat k="Largest position" v={pct(s.maxPeakWeight, 3)} sub="peak weight in one name" />
        <Stat k="Median trade ROI" v={pct(c.medianRoi, 0)} sub="selection, not sizing" />
        <Stat
          k="Top trade's share"
          v={pct(s.topEpisodeShare, 0)}
          sub={s.concentrated ? "one position carries the record" : "profit is spread across trades"}
        />
      </div>
      {s.concentrated && (
        <div className="callout flag" style={{ marginBottom: 0 }}>
          A single position accounts for {pct(s.topEpisodeShare, 0)} of all profit. That is a result,
          not yet a demonstrated process.
        </div>
      )}
    </div>
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
    <div className="card">
      <h3>🎯 Entry skill detail</h3>
      <div className="quote" style={{ borderTop: "none", paddingTop: 0 }}>
        {horizons.map(([k, label]) => (
          <div className="line" key={k}>
            <span className="muted">Return {label} after entry</span>
            <span className="v">{pct(e.roiByHorizon[k] ?? null, 1)}</span>
          </div>
        ))}
        {multiples.map(([k, label]) => (
          <div className="line" key={k}>
            <span className="muted">Entries that later hit {label}</span>
            <span className="v">{pct(e.hitRateByMultiple[k] ?? null, 0)}</span>
          </div>
        ))}
        <div className="line">
          <span className="muted">Median time to peak</span>
          <span className="v">{duration(e.medianTimeToPeakSec)}</span>
        </div>
      </div>
      <p className="small faint" style={{ marginBottom: 0 }}>
        {e.sampleSize} of {e.population} entries had prices observable afterwards.
      </p>
    </div>
  );
}

function ExitDetail({ data }: { data: TraderProfile }) {
  const x = data.profile.exit;
  return (
    <div className="card">
      <h3>🚪 Exit skill detail</h3>
      <div className="quote" style={{ borderTop: "none", paddingTop: 0 }}>
        <div className="line">
          <span className="muted">Upside captured (median)</span>
          <span className="v">{pct(x.captureRatio, 0)}</span>
        </div>
        <div className="line">
          <span className="muted">Same figure, mean</span>
          <span className="v">{pct(x.captureRatioMean, 0)}</span>
        </div>
        <div className="line">
          <span className="muted">Move left on the table after exit</span>
          <span className="v">{pct(x.avgReturnAfterExit, 1)}</span>
        </div>
        <div className="line">
          <span className="muted">Exits followed by a further rise</span>
          <span className="v">{pct(x.prematureExitRate, 0)}</span>
        </div>
      </div>
      <p className="small faint" style={{ marginBottom: 0 }}>
        {x.sampleSize} of {x.population} exits had prices observable afterwards. Each episode's
        capture is clamped before aggregation so one catastrophic exit cannot define the dimension.
      </p>
    </div>
  );
}

function Metric({
  n,
  k,
  v,
  note,
  band,
}: {
  n: string;
  k: string;
  v: string;
  note?: string;
  band?: "good" | "ok" | "warn" | "bad" | "none";
}) {
  return (
    <div className="metric">
      <div className="n">{n}</div>
      <div className="k">{k}</div>
      <div className="v" style={band && band !== "none" ? { color: `var(--${band})` } : undefined}>
        {v}
      </div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div>
      <div className="stats-k faint small" style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontSize: "0.7rem" }}>
        {k}
      </div>
      <div className="mono" style={{ fontSize: "1.1rem", marginTop: "0.15rem" }}>
        {v}
      </div>
      {sub && <div className="faint small">{sub}</div>}
    </div>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div className="item">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
