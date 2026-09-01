# fomo-vaults

Pooled copy-trading vaults over [fomo](https://fomo.family) trader accounts.

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
weights sized, live Jupiter quotes, guardrails enforced. 57 tests.

**Not yet built:**
- Custody. The vault currently assumes a keypair it controls. A real product
  needs either a program-owned vault with on-chain share accounting, or a
  regulated custodial arrangement. This is the decision that gates launch.
- Deposit/withdrawal plumbing wiring `vault/ledger.ts` to actual transfers.
- EVM chains. fomo also trades Base, BNB, Ethereum, Monad and Robinhood Chain.
  `ChainAdapter` is the seam; the mirror and ledger layers are chain-agnostic.
- Persistence. `RunnerState` is in-memory; it needs a durable store so the
  cursor and the processed-trade set survive a restart.

## Disclaimers

Copy-trading replicates another account's transactions at the operator's sole
direction. This is not investment advice. Operating a pooled vehicle that takes
other people's money is a regulated activity in most jurisdictions — get advice
before accepting a single outside deposit.
