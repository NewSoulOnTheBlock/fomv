import { type ReactNode } from "react";
import { ArrowRight, Check, X } from "lucide-react";

import { DEFAULT_FEE_TERMS, MAX_TRADE_FEE_BPS } from "@engine/follow/fees.js";
import { DEFAULT_POLICY } from "@engine/policy.js";
import { DEFAULT_ABILITY } from "@engine/scoring/ability.js";
import { LISTING_BAR, LISTING_TERMS } from "@engine/platform/listing.js";
import { MirrorDiagram } from "@/components/viz/MirrorDiagram";
import { PENTAGON_ORDER } from "@/components/viz/EdgePentagon";
import { Callout, Panel, PanelBody, PanelHead, SectionRule } from "@/components/term";
import { Button } from "@/components/ui/button";
import { DIMENSION_META } from "@/lib/dimensions";
import { bps, pct, usd } from "@/lib/format";
import { href } from "@/lib/router";

/**
 * How the thing works, written out.
 *
 * # Why every number on this page is imported
 *
 * A documentation page is the easiest place in a product for a figure to go
 * stale, because nothing breaks when it does. The copy still renders, the
 * sentence still parses, and it is simply no longer true -- so somebody reads
 * that the cap is 15% long after it became 10%, and the page they trusted is
 * the reason they were wrong.
 *
 * So the guardrail tables, the fee, the grading floor and the listing bar are
 * read from the modules that enforce them. Changing a policy default changes
 * this page in the same commit, and there is no way to change one without the
 * other.
 */

const SIZING = DEFAULT_POLICY.sizing;
const SAFETY = DEFAULT_POLICY.safety;
const EXEC = DEFAULT_POLICY.execution;
const BREAKERS = DEFAULT_POLICY.breakers;

export function DocsPage() {
  return (
    <div>
      <Masthead />

      <SectionRule index="01">What it does</SectionRule>
      <Prose>
        <p>
          A trader you have never met makes a swap. Within seconds the same swap is made from{" "}
          <Em>your</Em> wallet — not because you copied their dollar amount, but because the
          position they took was a certain fraction of their book, and FOMV takes that same
          fraction of yours.
        </p>
        <p>
          You never deposit anything. There is no pool, no share price, no net asset value, and no
          moment where FOMV is holding your money. Your position sits in a wallet only you can
          withdraw from, and you can end the arrangement in one click.
        </p>
      </Prose>

      <div className="mt-8 hidden md:block">
        <Panel>
          <PanelBody className="py-8">
            <MirrorDiagram />
          </PanelBody>
        </Panel>
      </div>

      <SectionRule index="02">Weight, not dollars</SectionRule>
      <Prose>
        <p>This is the part that makes it work, and the part copy bots get wrong.</p>
        <p>
          A copy bot mirrors <Em>notional</Em>: the trader spent $4,000, so you spend $4,000. That
          breaks immediately. A trader with a $2m book putting $4,000 into something has risked
          0.2% of what they have; if your wallet holds $5,000, the same $4,000 is 80% of everything
          you own. You have not copied their trade — you have taken a wildly different one that
          happens to share a ticker.
        </p>
        <p>
          FOMV mirrors <Em>portfolio weight</Em>. They committed 4% of their book, so you commit 4%
          of yours. It is scale-invariant: a $2,000 follower and a $2m follower get the same
          strategy rather than the same dollar amounts.
        </p>
      </Prose>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Panel>
          <PanelHead label="entering" aside="from their weight" />
          <PanelBody>
            <p className="text-[14px] leading-relaxed text-muted-foreground">
              Their conviction is a fraction of their book, not a dollar amount, so an entry is
              sized from the share of their portfolio they just committed.
            </p>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHead label="exiting" aside="from their position" />
          <PanelBody>
            <p className="text-[14px] leading-relaxed text-muted-foreground">
              "Sold 60% of their position" maps onto whatever yours is now worth. If a token has
              ten-x'd since entry, weight-based maths would compute an exit amount unrelated to
              what you actually hold. Position fraction always lands correctly.
            </p>
          </PanelBody>
        </Panel>
      </div>

      <SectionRule index="03">What you authorise</SectionRule>
      <Prose>
        <p>
          Signing in creates a Solana wallet for you — you do not need one first. Authorising
          grants FOMV permission to <Em>sign swaps</Em> on it. That permission is narrower than it
          sounds, and the boundary is the whole product.
        </p>
      </Prose>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Panel>
          <PanelHead label="it can" />
          <div className="inset-rows px-1 pb-1 [--row-inset:2.75rem] [--row-inset-end:1rem]">
            <Permit allowed>Swap one token for another inside your wallet</Permit>
            <Permit allowed>Do so only within the guardrails below</Permit>
          </div>
        </Panel>
        <Panel>
          <PanelHead label="it cannot" />
          <div className="inset-rows px-1 pb-1 [--row-inset:2.75rem] [--row-inset-end:1rem]">
            <Permit>Send your funds to any other address</Permit>
            <Permit>See or export your private key</Permit>
            <Permit>Keep signing after you revoke</Permit>
            <Permit>Stop you withdrawing, at any moment</Permit>
          </div>
        </Panel>
      </div>

      <Callout tone="note" className="mt-4">
        The failure mode of a compromised FOMV is <Em>bad trading</Em>, not theft. Which is why the
        guardrails below matter more than any promise on this page: they are the actual bound on
        what can go wrong.
      </Callout>

      <SectionRule index="04" aside="current defaults">The guardrails</SectionRule>
      <Prose>
        <p>
          Every rule here restricts <Em>risk-taking</Em> and never <Em>risk-reduction</Em>. Each
          one that blocks a buy deliberately does not block a sell — including the deny list,
          because deny-listing an asset must not trap you inside it.
        </p>
      </Prose>

      <div className="mt-6 space-y-4">
        <Rules
          label="sizing"
          rows={[
            ["Most of your wallet in one token", pct(SIZING.maxPositionPct, 0), "Concentration"],
            ["Most positions at once", String(SIZING.maxPositions), "A tail of illiquid dust"],
            ["Held back in cash", pct(SIZING.quoteReservePct, 0), "Exits and gas never depend on selling first"],
            ["Smallest trade placed", usd(SIZING.minTradeUsd), "Trades not worth their own gas"],
            ["Most of the book deployed in a day", pct(SIZING.dailyDeployPct, 0), "How fast a tilting or hijacked trader can rotate you"],
          ]}
        />
        <Rules
          label="token safety"
          rows={[
            ["Minimum pool depth", usd(SAFETY.minLiquidityUsd, { compact: true }), "Pools too thin to exit"],
            ["Most of a pool one trade may be", pct(SAFETY.maxPctOfLiquidity, 0), "Being your own adverse price move"],
            ["Minimum token age", `${SAFETY.minTokenAgeSec / 60} min`, "The first minutes of a launch"],
            ["Most of supply in the top holders", pct(SAFETY.maxTopHolderConcentration, 0), "A rug setup"],
            ["Sell simulated before buying", SAFETY.requireSellSimulation ? "always" : "off", "Honeypots, probed at worst-case size"],
            ["Mint and freeze authority", SAFETY.requireMintAuthorityRenounced ? "renounced" : "not checked", "Supply inflation, and funds frozen in place"],
          ]}
        />
        <Rules
          label="execution"
          rows={[
            ["Skip if price ran past their fill by", bps(EXEC.maxLeaderPriceDriftBps), "Better no position than buying their exit liquidity"],
            ["Skip a signal older than", `${EXEC.maxTradeAgeMs / 1000}s`, "Never chase a stale trade"],
            ["Most slippage accepted", bps(EXEC.maxSlippageBps), "Applied to price impact too, not just quote deviation"],
            ["Wait before re-entering a token", `${EXEC.reentryCooldownSec}s`, "Churn from a trader flip-flopping"],
          ]}
        />
        <Rules
          label="circuit breakers"
          rows={[
            ["Flatten everything at a drawdown of", pct(BREAKERS.maxDrawdownPct, 0), "Sells, rather than merely stopping"],
            ["Stop new risk after a daily loss of", pct(BREAKERS.dailyLossLimitPct, 0), "Exits still allowed"],
            ["Stop following if their book falls", pct(BREAKERS.leaderCollapsePct, 0), "A trader being liquidated or compromised"],
            ["Refuse to size against prices older than", `${BREAKERS.maxPriceStalenessMs / 1000}s`, "Never trade on a stale mark"],
          ]}
        />
      </div>

      <SectionRule index="05">How a trader is graded</SectionRule>
      <Prose>
        <p>
          A profit-and-loss leaderboard rewards whoever took the most risk and happened to survive.
          FOMV publishes an <Em>Edge Score</Em> instead: five dimensions, each out of 100, computed
          from on-chain history rather than from anything the trader tells us.
        </p>
      </Prose>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PENTAGON_ORDER.map((key) => (
          <div key={key} className="material rounded-xl p-5">
            <div className="term-label">{DIMENSION_META[key].code}</div>
            <h3 className="mt-2.5 text-[17px] font-semibold">{DIMENSION_META[key].label}</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
              {DIMENSION_META[key].blurb}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-8 space-y-4">
        <Rule
          title="Medians, not means"
          body="One trader on the roster has a mean return per trade of 1352% and a median of 172% — one moonshot on a small position. Scoring the mean ranks a lottery ticket above a repeatable process, which is the exact failure the score exists to avoid."
        />
        <Rule
          title="Skill is reported separately from exposure"
          body="Two traders earn the same dollars, one on 4% positions and the other on 40%. For someone mirroring them that difference is the whole product, because exposure decides what a drawdown feels like whatever the return."
        />
        <Rule
          title="Nothing unmeasurable is scored as zero"
          body="A dimension that cannot be measured is drawn hatched and the score is re-weighted over the rest, so a missing feed lowers confidence rather than quietly becoming a bad grade."
        />
      </div>

      <Callout tone="gap" className="mt-4">
        Below {DEFAULT_ABILITY.minClosedEpisodes} complete round trips no grade is published at
        all, and every dimension is withheld together. A profit factor over eight trades is one
        good afternoon or one bad one, and a partial grade invites exactly the comparison it cannot
        support.
      </Callout>

      <SectionRule index="06">Where the numbers come from</SectionRule>
      <div className="grid gap-4 md:grid-cols-2">
        <Source
          label="trades"
          title="Balance deltas, not venue events"
          body="One swap can touch four venues in a single transaction, each emitting a different event shape. Net balance changes are venue-agnostic and collapse multi-hop routes for free: USDC → SOL → BONK nets to exactly (−USDC, +BONK), so the intermediate leg can never be mirrored as a trade of its own. Decoding per-leg events and mirroring each is how a copy bot ends up buying the router's intermediate token and immediately selling it back."
        />
        <Source
          label="prices"
          title="Candles, with their own fills underneath"
          body="Entry and exit quality ask what a token did after the trader acted — a question a trade log cannot answer, because it needs prices at moments they did nothing. Using their own later fills is the obvious shortcut and it is biased: a trader acts when price moves, so the only prices ever observed are the ones that provoked a trade. Every audit states which source it rests on."
        />
      </div>

      <SectionRule index="07">What it costs</SectionRule>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <PanelHead label="the fee" />
          <PanelBody className="space-y-5">
            <div className="flex items-baseline gap-3">
              <span className="tnum text-[42px] font-semibold leading-none tracking-[-0.04em]">
                {bps(DEFAULT_FEE_TERMS.tradeFeeBps)}
              </span>
              <span className="text-[14px] text-muted-foreground">of each mirrored trade</span>
            </div>
            <div className="space-y-2.5 text-[14px]">
              <Line k="Of which, to the trader" v={bps(DEFAULT_FEE_TERMS.tradeFeeBps / 2)} />
              <Line
                k={`Trades under ${usd(DEFAULT_FEE_TERMS.minChargeableUsd)}`}
                v="free"
                tone="var(--pos)"
              />
              <Line k="To start, stop, deposit or withdraw" v="nothing" tone="var(--pos)" />
              <Line k="While you simply hold" v="nothing" tone="var(--pos)" />
              <Line k="Ceiling in code" v={bps(MAX_TRADE_FEE_BPS)} />
            </div>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHead label="why notional and not profit" />
          <PanelBody className="space-y-3 text-[14px] leading-relaxed text-muted-foreground">
            <p>
              A performance fee is the fairer instrument and it is unavailable here for a
              structural reason worth stating plainly: measuring profit needs a cost basis, and a
              wallet you also trade yourself has no cost basis we can defend. You could buy the
              same token by hand an hour later, and any profit figure would be partly yours and
              partly ours with no way to separate them.
            </p>
            <p>
              Notional is observable, attributable, and cannot be gamed by anything you do outside
              the mirror. <Em>It is also worse for you in a losing month</Em> — which is the honest
              trade, and the reason the rate is low and half of it goes to the trader.
            </p>
          </PanelBody>
        </Panel>
      </div>

      <SectionRule index="08">What it is not</SectionRule>
      <Prose>
        <p>
          FOMV does not pick trades, does not predict anything, and does not promise that a graded
          trader will keep performing. A published grade is a measurement of the past. It is
          computed from real history, and it is still only history.
        </p>
        <p>
          Mirroring is also always second. A trade is detected after it lands, checked, and then
          placed — so your fill is never better than theirs and is sometimes worse. What <Em>can</Em>{" "}
          be bounded is the cost of being second, which is what the price-drift and trade-age
          guardrails do: past those limits the trade is skipped rather than chased.
        </p>
        <p>
          Copy-trading replicates another account's transactions at the operator's sole direction.
          Nothing here is investment advice.
        </p>
      </Prose>

      <SectionRule index="09">Getting listed</SectionRule>
      <Prose>
        <p>
          The roster is capped at {LISTING_TERMS.maxRoster} and is an editorial decision rather
          than a marketplace. Applications go to a call, not to a queue, and the audit runs against
          your real history before we speak — a weak grade gets published rather than withheld.
        </p>
        <p>
          The bar, stated so it can be judged before spending half an hour on a call:{" "}
          {LISTING_BAR.minClosedTrades} or more closed round trips, a book of at least{" "}
          {usd(LISTING_BAR.minBookUsd, { compact: true })}, and{" "}
          {LISTING_BAR.supportedChains.join(", ")} — the only chain there is an adapter for today.
        </p>
      </Prose>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <a href={href("/apply")}>
            Apply to be listed
            <ArrowRight />
          </a>
        </Button>
        <Button asChild size="lg" variant="outline">
          <a href={href("/")}>See the roster</a>
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- pieces -- */

function Masthead() {
  return (
    <div className="rise step-1 border-b border-separator pb-12 pt-14">
      <h1 className="max-w-3xl text-[clamp(2.3rem,4.8vw,3.75rem)] font-semibold">
        How FOMV <span className="text-gradient">works</span>.
      </h1>
      <p className="mt-8 max-w-2xl text-[17px] leading-[1.6] text-muted-foreground">
        Every figure on this page is read from the code that enforces it — the guardrails, the fee,
        the grading floor. A documentation page is the easiest place in a product for a number to
        go stale, because nothing breaks when it does.
      </p>
    </div>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-2xl space-y-4 text-[16px] leading-[1.65] text-muted-foreground">
      {children}
    </div>
  );
}

function Em({ children }: { children: ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

function Rules({ label, rows }: { label: string; rows: [string, string, string][] }) {
  return (
    <Panel>
      <PanelHead label={label} />
      <div className="inset-rows px-1 pb-1 [--row-inset:1.25rem] [--row-inset-end:1rem]">
        {rows.map(([what, value, why]) => (
          <div
            key={what}
            className="grid gap-x-6 gap-y-1.5 rounded-lg px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.1fr)] sm:items-baseline"
          >
            <span className="text-[14px]">{what}</span>
            <span className="tnum text-[15px] font-semibold text-primary sm:text-right">
              {value}
            </span>
            <span className="text-[13px] leading-snug text-faint">{why}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Rule({ title, body }: { title: string; body: string }) {
  return (
    <div className="material rounded-xl p-5">
      <h3 className="text-[17px] font-semibold">{title}</h3>
      <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function Source({ label, title, body }: { label: string; title: string; body: string }) {
  return (
    <Panel>
      <PanelHead label={label} />
      <PanelBody>
        <h3 className="text-[17px] font-semibold">{title}</h3>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">{body}</p>
      </PanelBody>
    </Panel>
  );
}

function Permit({ allowed = false, children }: { allowed?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg px-4 py-3">
      {allowed ? (
        <Check className="mt-0.5 size-4 shrink-0 text-pos" aria-hidden />
      ) : (
        <X className="mt-0.5 size-4 shrink-0 text-neg" aria-hidden />
      )}
      <span className="text-[14px] leading-snug text-secondary-foreground">{children}</span>
    </div>
  );
}

function Line({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="tnum font-medium" style={tone ? { color: tone } : undefined}>
        {v}
      </span>
    </div>
  );
}
