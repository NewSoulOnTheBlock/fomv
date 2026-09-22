# FOMV - Fear of Missing Vault

Pooled copy-trading vaults over [fomo](https://fomo.family) trader accounts,
on a curated roster.

Deposit into a trader's vault. The vault mirrors that trader's on-chain swaps,
bounded by published guardrails. Depositors hold shares; the leader earns a
performance fee on new profit only.

fomo's own copy trading is per-account: your money, your wallet, your strategy
slot. There is no pooled vehicle, no shares, no NAV, no fee split. That gap is
what this builds.

## Why a vault is not a copy bot

A copy bot mirrors **notional**: the leader spent $4,000, so you spend $4,000
(times a multiplier). That breaks the moment capital is pooled, because the
vault's equity moves independently of the leader's — deposits arrive,
withdrawals leave, and P&L diverges.

A vault mirrors **portfolio weight**:

```
leader committed 4% of their book  ->  vault commits 4% of vault equity
```

Scale-invariant, survives deposits mid-position, and means a $2k depositor and
a $2m depositor get the same strategy rather than the same dollar amounts.

### Entries and exits need opposite rules

This asymmetry is load-bearing, and getting it wrong is the classic copy-bot bug.

| | Sized from | Why |
|---|---|---|
| **Entry** | Leader's **portfolio weight** | Their conviction is a fraction of their book, not a dollar amount |
| **Exit** | Leader's **position fraction** | "Sold 60% of their position" maps onto the vault's holding whatever it is now worth |

If a position has 10x'd since entry, portfolio-weight logic would compute an
exit dollar amount unrelated to what the vault actually holds. Position
fraction always lands correctly.

## The guardrails

Guardrails restrict **risk-taking**, never **risk-reduction**. Every rule below
that blocks a buy deliberately does not block a sell — including the deny list,
because deny-listing an asset must not trap depositors inside it.

### Sizing
| Guardrail | Default | Bounds |
|---|---|---|
| `exposureScalar` | 1.0 | Risk appetite vs the leader's |
| `maxPositionPct` | 15% | Concentration in any one asset |
| `maxPositions` | 20 | Tail of illiquid dust |
| `quoteReservePct` | 5% | Exits and gas never depend on selling first |
| `dailyDeployPct` | 100% | How fast a tilting or hijacked leader can rotate the book |
| `minTradeUsd` | $25 | Trades not worth their own gas |

### Token safety
| Guardrail | Default | Catches |
|---|---|---|
| `requireSellSimulation` | on | Honeypots — probed at **worst-case position size**, not a nominal unit |
| `requireFreezeAuthorityRenounced` | on | A live freeze authority strands every depositor at once |
| `requireMintAuthorityRenounced` | on | Supply inflation |
| `maxPctOfLiquidity` | 1% | The vault being its own adverse price move |
| `minLiquidityUsd` | $25k | Pools too thin to exit |
| `minTokenAgeSec` | 300s | Set to 0 for an explicit sniper vault |
| `maxTopHolderConcentration` | 50% | Rug setup |
| `requireHolderData` | on | Trading blind when the RPC cannot measure concentration |

### Execution — the honest answer to "how fast?"

You cannot promise to beat the leader's fill. What you *can* promise is a bound
on the cost of being slow:

| Guardrail | Default | Bounds |
|---|---|---|
| `maxLeaderPriceDriftBps` | 300 | **If the price already ran 3% past the leader's fill, skip.** Better no position than buying their exit liquidity |
| `maxTradeAgeMs` | 20s | Never chase a stale signal |
| `maxSlippageBps` | 150 | Applied to price *impact* as well as quote deviation |
| `reentryCooldownSec` | 60 | Churn from a leader flip-flopping |

### Circuit breakers
| Breaker | Default | Effect |
|---|---|---|
| `maxDrawdownPct` | 35% | **Flatten** the book, not merely freeze it |
| `dailyLossLimitPct` | 15% | Block new risk for the UTC day; exits still allowed |
| `leaderCollapsePct` | 50% | Stop following a leader who is being liquidated or compromised |
| `maxPriceStalenessMs` | 30s | Never size against stale marks |
| `paused` | off | Operator kill switch — stops everything |

## Share accounting

The part that makes it a vault rather than a bot. All of it runs on 1e18
fixed-point bigint, because a 1e-16 float error repeated across thousands of
deposits silently mints shares out of nothing and every existing depositor pays.

**Anti-dilution levy.** A deposit into a fully-invested vault forces the vault
to go buy the whole book at market. Without a levy the incoming member gets
shares at a clean NAV while existing members silently eat the slippage. The
levy prices that cost, is paid by whoever causes it, and stays in the vault for
the members who bore it. It scales with how invested the vault actually is —
depositing into a vault sitting in USDC forces no trading and costs nothing.

**Per-lot high-water marks.** Each deposit is its own lot with its own HWM,
consumed FIFO. A single share-weighted average HWM lets a member top up after a
drawdown to drag their own mark down, then pay fees on gains that merely
recover earlier losses. Lots defeat that. There is a test for exactly this case.

**Fees crystallise as share transfers,** not cash. Nothing leaves the vault, no
position must be liquidated to pay a fee, and NAV per share does not jump on
the fee event — the leader simply ends up owning more of the same pool.

## Architecture

```
chains/solana/watcher.ts    leader swaps, from net balance deltas
chains/solana/marketdata.ts portfolio valuation + token safety
chains/solana/jupiter.ts    quoting, sell-simulation, execution
     |
mirror/sizing.ts            weights -> USD (entries), fractions (exits)
mirror/guardrails.ts        the tables above
mirror/engine.ts            planCycle: trades -> intents, budgets composed
     |
vault/ledger.ts             shares, NAV, levy, HWM fees
runner.ts                   one tick: poll -> plan -> execute -> record
```

### Swap detection reads balance deltas, not DEX logs

fomo routes through aggregators, so one user action can touch Raydium, Meteora,
Orca and a pump.fun curve in a single transaction, each emitting a different
event shape. Net balance deltas are venue-agnostic and collapse multi-hop routes
for free: `USDC -> SOL -> BONK` nets to exactly `(-USDC, +BONK)`, so the
intermediate SOL leg can never be mirrored as a trade of its own. Decoding
per-leg events and mirroring each is how a copy bot ends up buying the router's
intermediate token and immediately re-selling it.

## The platform

FOMV is a roster, not a marketplace. A small number of leaders are graded,
listed and cranked; everyone else is watched. Two revenue lines pay for it, and
they are enforced in deliberately different places.

| | Charged | Enforced by | Why there |
|---|---|---|---|
| **Listing fee** | Once, to list a trader | The crank | A vault without a manager posting NAV cannot settle a deposit. Declining to crank an unpaid vault is sufficient. |
| **Withdrawal fee** | On every exit | The program | `initiate_withdrawal` is permissionless. An app-side skim would be bypassed by calling the program directly. |

### The withdrawal fee is taken in shares

Exits are in-kind: burning X% of the shares pays out X% of *every* token the
vault holds. A fee denominated in tokens would therefore mean paying the
treasury a slice of each memecoin in the book and funding an associated token
account for every one of them.

Instead the program transfers the fee portion of the presented shares to the
treasury and burns only the remainder. One transfer, no new accounts, the book
untouched, and the treasury redeems in-kind later through the same claim path as
any other holder. It is the same move `vault/ledger.ts` already makes for the
performance fee.

The fee is **floored**, not rounded up. Fees elsewhere in this codebase round
toward the pool because the counterparty *is* the pool; here the counterparty is
FOMV, and rounding a one-share exit up would hand the platform all of it.

### What a depositor can verify without trusting us

- **A ceiling in code.** `MAX_WITHDRAW_FEE_BPS` is 200. Moving it needs a
  program upgrade, not a config change, so a compromised authority key cannot
  charge more than 2% on the way out.
- **A fee fixed at listing.** Each vault snapshots its own `withdraw_fee_bps`.
  Repricing the platform never reaches a vault that is already live.
- **A one-way ratchet.** `set_vault_withdraw_fee` may only *lower* a vault's
  fee. The app flags any observed increase as an anomaly, because the program
  cannot produce one.
- **Exits that do not depend on us.** Suspending a listing stops deposits, never
  withdrawals: in-kind redemption needs no NAV and no manager.

### Choosing the roster

```bash
# Grade candidates on copyability and propose a roster. Read-only.
bun run src/cli.ts score --candidates <addr,addr,addr> --seats 3
```

Capacity gates before rank. A trader scoring 95 who breaks at $30k is not a
better listing than one scoring 70 who absorbs $2m - they are a vault that fills
up and then loses to its own price impact.

Two approximations the output states for itself, both one-directional:

- **Capacity uses today's pools**, not the pools at each trade, because there is
  no archival liquidity index here.
- **Peak weight uses today's book**, not the book at each trade. A trader whose
  account grew over the window has their early weights understated, which
  overstates capacity. Rebuilding equity trade by trade is the honest fix.

Where a value genuinely cannot be measured it stays `null` and the candidate is
failed on it, rather than being scored against a guess.

One caveat the output repeats: capacity is computed against pools as they are
*now*, not as they were at each trade, because there is no archival liquidity
index here. Read it as an order of magnitude.

## The app

`app/` is a Vite + React front end with Privy social sign-in, so a depositor
never needs to own a wallet first: signing in with Google creates an embedded
Solana wallet for them.

```bash
bun run build:appdata          # regenerate app/public/data from state/profiles
cd app && bun install && bun run dev
```

Set `VITE_PRIVY_APP_ID` in `app/.env.local`. Without it sign-in is disabled and
nothing else is: the dashboard reads static JSON and stays fully usable.

Two properties the app holds onto:

- **The fee arithmetic is imported, not reimplemented.** `VaultPanel` calls the
  same `quoteWithdrawal` the vault runs, aliased as `@engine` in
  `vite.config.ts`. A quoted number and a charged number that came from two
  code paths would eventually disagree.
- **It refuses to fake a settlement.** While `programDeployed` is false the
  deposit and withdraw actions are disabled and say why. Quoting a fee exactly
  is honest; simulating a transfer that cannot happen is not.

## The trader dashboard

A P&L leaderboard rewards whoever took the most risk and survived. The
dashboard is built around a **Trader Edge Score** instead, so "made $24,630" is
never the headline.

Five dimensions, each 0-100, over the ten metrics beneath them:

| Dimension | Built from |
|---|---|
| Profitability | Profit factor, **median** ROI per trade |
| Risk Management | Max drawdown, avg win vs avg loss, position sizing, return-per-unit-of-scatter |
| Entry Skill | Return at +1h/+6h/+24h, share of entries that later ran +25/+50/+100% |
| Exit Skill | Share of the available move captured, premature-exit rate |
| Consistency | Profitable weeks, variation between them, share of tokens profitable |

### Where the prices come from

Entry and exit quality ask what a token did *after* the trader acted, which a
trade log cannot answer -- it needs prices at moments the trader did nothing.

The original answer was the trader's own later fills. Real prices, and biased
in a way that matters: a trader acts when price moves, so the only prices ever
observed are the ones that provoked a trade. Capture ratio computed against
that sample asks "did you sell near the best price you yourself traded at",
which is close to a tautology, and `medianTimeToPeakSec` collapsed to zero
because the entry fill was often the only observation in the window.

`src/marketdata` replaces it with real candles, keeping the fills underneath:

| | |
|---|---|
| Default | **GeckoTerminal**, no API key, ~30 calls/min |
| Upgrade | **Birdeye** with `BIRDEYE_API_KEY` -- token-level rather than per-pool, so a token that migrated venues keeps one series |
| Off | `FOMV_PRICE_FEED=none`, and the provenance says the grade rests on fills |

Three things the layer does that are easy to get wrong:

- **Picks the deepest pool, not the first.** GeckoTerminal serves OHLCV per
  pool and does *not* return pools in liquidity order. Taking the first result
  works on most tokens and silently prices the rest off a thin market.
- **Peaks come from candle highs, point prices from candle closes.** A close is
  the only value in a candle that is a price at a stated time; interpolating
  between open and close would manufacture precision the feed does not have.
- **Caches everything closed.** A closed candle is a fact, so only the open one
  is refetched. Without that, re-running a profile costs the same minutes of
  rate-limited paging as the first run, which is how a scoring window quietly
  stays at five days for ever.

Both layers are combined so point lookups take the first source that answers
and **peaks take the maximum across both** -- each is a price that genuinely
traded, and a fill inside a candle can reveal a spike its resolution smoothed
away.

### Three rules that shape the numbers

**Medians, not means.** This trader's mean ROI is 1352% and their median is
172%: one moonshot on a small position. Scoring the mean ranks a lottery ticket
above a repeatable process, which is the exact failure the dashboard exists to
avoid. Capture ratio is a median too, and clamped per episode, because it is
unbounded below and one catastrophic exit would otherwise define the dimension.

**Skill is reported separately from exposure.** Two traders earn the same
dollars; one on 4% position sizes and the other on 40%. For a pooled vault that
difference *is* the product, because exposure decides what a depositor's
drawdown feels like whatever the return.

**Nothing unmeasurable is scored as zero.** A dimension that cannot be measured
renders as a hatched bar and the Edge Score is re-weighted over the rest, so a
missing feed lowers confidence rather than quietly becoming a bad grade.

### Episodes that straddle the window

The one that cost real debugging. A history window has an edge, and positions
opened before it get sold inside it - arriving with a cost basis that was never
observed. On an 18-hour sample this affected **15 of 24 closed positions**, and
it drove median capture ratio negative for a trader with a 79% win rate.

The signature is quantities: a complete round trip balances, a straddling one
sells far more than it bought. Those episodes are excluded from every metric
rather than corrected, counted as `straddlingEpisodes`, and reported as a gap
telling you to widen the window.

## Running it

```bash
bun install

# Value a leader's book and see their portfolio weights
bun run src/cli.ts inspect --leader <address>

# Replay their recent swaps against a hypothetical vault.
# Prints what the vault would have done, and why it skipped the rest.
bun run src/cli.ts simulate --leader <address> --equity 50000

# Poll continuously. Dry-run unless --live AND a key is present.
bun run src/cli.ts watch --leader <address> --equity 50000 --interval 10

bun test
```

### RPC requirements

Free endpoints are not sufficient, and the system tells you so rather than
silently degrading:

- `api.mainnet-beta.solana.com` refuses **batched** transaction reads
- `solana-rpc.publicnode.com` refuses **indexed** methods (`getTokenLargestAccounts`, token-account enumeration)

Use a real provider (Helius, Triton, QuickNode). `SOLANA_TX_RPC_URL` can point
transaction history at a different endpoint from account state, which is what a
production deployment wants anyway — archival history is the expensive half.

Polling is the floor, not the ceiling. Front the watcher with Yellowstone/Geyser
or a Helius webhook for sub-second detection; the extraction logic is a pure
module and is identical either way.

## Status

Working and tested end to end against Solana mainnet: real swaps extracted,
weights sized, live Jupiter quotes, guardrails enforced. 104 tests, clean
`tsc`, and the Anchor program type-checks.

**Not yet built:**
- An SBF build. The program passes `cargo check`, which validates every account
  constraint, but `anchor build` has not been run and no IDL is emitted, so
  compute and account-size budgets are unverified. It has never been deployed.
- A client for the program. Nothing yet builds `initialize_platform`,
  `initialize_vault` or `initiate_withdrawal` transactions; `src/platform`
  models the economics and predicts what the program will charge.
- Deposit/withdrawal plumbing wiring `vault/ledger.ts` to actual transfers.
- The FOMV front end.
- EVM chains. fomo also trades Base, BNB, Ethereum, Monad and Robinhood Chain.
  `ChainAdapter` is the seam; the mirror and ledger layers are chain-agnostic.
- Persistence. `RunnerState` is in-memory; it needs a durable store so the
  cursor and the processed-trade set survive a restart.

## Disclaimers

Copy-trading replicates another account's transactions at the operator's sole
direction. This is not investment advice. Operating a pooled vehicle that takes
other people's money is a regulated activity in most jurisdictions — get advice
before accepting a single outside deposit.
