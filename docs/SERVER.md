# Running the FOMV follow server

The server mirrors a curated leader's swaps into subscribers' own wallets. It
never holds a key and never holds funds: each subscriber grants Privy
delegation from the browser, and the server signs trades for them under that
permission.

## What it is, operationally

A **long-running stateful process**. Not a serverless function, not a cron job.
It holds a cursor per subscriber, a SQLite file, and rate-limited RPC
connections — none of which survive being started fresh per request.

> **Run exactly one instance against a given database.** Two would each read the
> same unprocessed trades before either recorded a fill, and mirror everything
> twice. If you want redundancy, run a standby that is not polling.

## Prerequisites

| | |
|---|---|
| Runtime | Bun 1.3+ (or the provided Docker image) |
| RPC | A real Solana provider — Helius, Triton, QuickNode |
| Privy | App id, app secret, and an authorisation keypair |
| Treasury | A Solana address to receive trade fees |

Free RPC endpoints will not do. `api.mainnet-beta.solana.com` refuses batched
transaction reads and `solana-rpc.publicnode.com` refuses the indexed methods
the safety checks need.

## Configuration

Copy `.env.example` to `.env` and fill in the **Follow server** section. The
values with no safe default are `SOLANA_RPC_URL`, `PRIVY_APP_ID`,
`PRIVY_APP_SECRET` and `FOMV_TREASURY`; the process refuses to start without
them rather than booting into a half-configured state.

Two that matter more than they look:

- **`FOMV_ALLOWED_ORIGINS`** — an explicit list, never `*`. These endpoints
  carry a bearer token, and a wildcard would let any page spend a user's
  session.
- **`FOMV_DB_PATH`** — mount a volume. Losing this file loses every subscriber
  cursor and the record of which trades were already mirrored, so the next
  cycle re-reads history it has already acted on.

## Running

```bash
bun install
bun run server            # dry-run: quotes, plans, signs nothing
MODE=live bun run server  # signs real transactions
```

Docker:

```bash
docker build -t fomv-server .
docker run -d --name fomv \
  --env-file .env \
  -v fomv-state:/app/state \
  -p 8080:8080 \
  fomv-server
```

**Dry-run is the default and that is deliberate.** `MODE=live` is required
before a single real transaction is signed. Run dry for a full day first and
read the cycle log: it prints exactly what it would have done.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Liveness |
| GET | `/status` | — | Cycle count, mode, last error, subscriber count |
| GET | `/leaders` | — | Roster |
| GET | `/terms` | — | Current fee terms |
| POST | `/subscribe` | Bearer | Enrol the caller's own wallet |
| POST | `/unsubscribe` | Bearer | Stop following |
| GET | `/me` | Bearer | The caller's subscriptions and fees |

Authenticated routes take a Privy access token as `Authorization: Bearer …`.
The server verifies it against Privy and only ever acts on a wallet belonging
to *that* user — taking a user id from the request body would let anyone enrol
a stranger's wallet, or unsubscribe a paying one.

## Deployment targets

Anywhere that runs a container with a persistent volume: Fly.io, Railway,
Render, a VPS. **Not Vercel** — the web app is deployed there, but a serverless
function cannot hold a polling loop or a SQLite file.

Recommended shape: one small always-on instance, a mounted volume for
`/app/state`, and `MODE` left at `dry-run` until you have watched a day of
cycles.

## Verifying before going live

Work through these in order. Each one fails cheaply; the last one does not.

1. `GET /status` reports `mode: "dry-run"` and a rising `cycles` count.
2. A subscriber appears in `/me` after they complete the consent flow.
3. The cycle log shows planned trades with `filled=0` and no errors.
4. **One delegated signature on devnet.** Privy's Solana signing call has moved
   between SDK versions; it is isolated in `src/server/privy.ts` precisely so
   adjusting it is a one-function change. Prove a signature lands before you
   prove a strategy works.
5. Only then `MODE=live`, with a single subscriber and a small balance.

## What it will not do

Worth stating so nobody goes looking for it:

- **It cannot move funds.** Delegation authorises signing swaps, not transfers
  to arbitrary addresses. The failure mode of a compromised server is bad
  trading, not theft — which is why the guardrails in `src/mirror/guardrails.ts`
  are the thing to review before launch.
- **It does not custody anything.** There is no pooled balance, no shares, no
  NAV. A subscriber's position is their own wallet.
- **It does not collect fees or pay leaders automatically.** Both sides accrue
  in the ledger and are settled separately. Charging inside the swap would let
  a failed fee transfer revert the subscriber's trade — their execution must
  never depend on our invoice.

## Fees

1% of each mirrored trade's filled notional, **split evenly with the trader
being copied**. Trades under $20 are free.

The ledger keeps two views of the same money, because they answer different
questions: `owed` is what each subscriber owes (what an account page shows and
what collection chases), and `payableTo` is what each payee is owed (what the
payout run needs).

Two properties worth knowing before you touch the numbers:

- The platform's share is computed as the **remainder**, not its own
  multiplication, so the halves always sum to exactly what the subscriber was
  charged. Two independent roundings would leave a residue belonging to nobody.
- `FOMV_TRADE_FEE_BPS` defaults to 100, which is also the engine's ceiling. The
  rate therefore cannot be raised without a code change and a release.

Set `FOMV_LEADER_SHARE_BPS` to change the split (5000 = half). A leader's share
goes to `payoutAddress` in `src/platform/roster.ts`, falling back to their
trading address — **collect a separate payout address at listing**, because
paying into the wallet being watched moves the very balances the strategy sizes
against.

## Failure modes you will actually hit

| Symptom | Cause |
|---|---|
| `delegation withdrawn` in the log | Subscriber revoked. Expected; they are dropped automatically. |
| Cycles rising, nothing filled | Normal when the leader is idle, or guardrails are rejecting. Check the `skipped` codes. |
| 429s from the RPC | Raise `FOMV_POLL_INTERVAL_SEC` or move to a paid tier. |
| Signature errors after an SDK bump | See step 4 above — `src/server/privy.ts`. |
