# Deploying the FOMV follow server

The front end is a static site and deploys itself. This is about the other
half: a long-running process that mirrors a leader's swaps into subscribers'
own wallets.

## What it is, operationally

One stateful process, not a serverless function. It holds a cursor per
subscriber, a SQLite file and rate-limited RPC connections, none of which
survive being started per request.

> **Exactly one instance against a given database.** Two would each read the
> same unprocessed trades before either recorded a fill, and mirror everything
> twice. For redundancy run a standby that is not polling.

## The machine

Ubuntu with systemd. It does not need much — two cores and 2 GB is comfortable
— but it does need to stay up, and it should not share a box with anything
holding private keys if that can be avoided. This process can sign swaps on
other people's wallets; the smaller the blast radius around it, the better.

Docker is supported (`Dockerfile` at the root) and is not what these scripts
do. On a small instance a systemd unit and a bun install is a few hundred
megabytes lighter, and the unit can be hardened in ways a container on a shared
host cannot.

## The four values with no default

The process exits at start without them, deliberately, rather than booting
half-configured:

| | |
|---|---|
| `SOLANA_RPC_URL` | A real provider — Helius, Triton, QuickNode. Free endpoints are **not** sufficient: `api.mainnet-beta` refuses batched transaction reads and `publicnode` refuses the indexed methods the safety checks need. |
| `PRIVY_APP_ID` | Privy dashboard |
| `PRIVY_APP_SECRET` | Privy dashboard |
| `FOMV_TREASURY` | Solana address that receives FOMV's half of the trade fee |

Two more that are optional to *boot* and required to be useful:

- **`PRIVY_AUTHORIZATION_PRIVATE_KEY`** — without it Privy will not act on the
  server's behalf, so the loop plans trades and never lands one.
- **`FOMV_ALLOWED_ORIGINS`** — the front end's origin, explicitly. Never `*`:
  these endpoints carry a bearer token and a wildcard would let any page spend
  a user's session.

## Steps

```bash
# On the target, once.
scp deploy/install.sh deploy/fomv.service deploy/nginx-fomv-api.conf root@HOST:/root/fomv-deploy/
ssh root@HOST bash /root/fomv-deploy/install.sh

# Fill in the four values.
ssh root@HOST nano /opt/fomv/app/.env

# From a workstation, whenever the code changes.
deploy/push.sh root@HOST

# Once a DNS A record points at the host.
ssh root@HOST bash /root/fomv-deploy/web.sh api.example.com

ssh root@HOST systemctl start fomv
ssh root@HOST journalctl -fu fomv
```

`install.sh` is idempotent and re-running it is how the unit gets updated.
`push.sh` restarts the service only if it was already running, so it cannot
start something that was deliberately stopped.

## Dry-run first, and for longer than feels necessary

`MODE=dry-run` is the default in the generated `.env` and `MODE=live` is
required before a single real transaction is signed. Run dry for a full day and
read the cycle log: it prints exactly what it would have done and why it
skipped the rest.

Before going live, in order — each of these fails cheaply and the last one does
not:

1. `GET /health` answers and `GET /status` shows a rising `cycles` count.
2. A subscriber appears in `/me` after completing the consent flow.
3. The cycle log shows planned trades with `filled=0` and no errors.
4. **One delegated signature on devnet.** Privy's Solana signing call has moved
   between SDK versions; it is isolated in `src/server/privy.ts` precisely so
   adjusting it is a one-function change. Prove a signature lands before you
   prove a strategy works.
5. Only then `MODE=live`, with one subscriber and a small balance.

## What lives where

| | |
|---|---|
| Code | `/opt/fomv/app` — replaced wholesale by `push.sh` |
| Secrets | `/opt/fomv/app/.env`, `0600`, owned by `fomv`. Never synced, never committed |
| Database | `/opt/fomv/app/state/follow.sqlite` — the one thing here that cannot be rebuilt from the repo |
| Service | `fomv.service`, journald under `fomv` |

**Back up `state/`.** It holds who consented, where each cursor reached, which
trades were already acted on and what is owed. Losing it means the next cycle
re-reads history it has already mirrored.

## Hardening that is already on

The unit runs as a system user with no shell, `ProtectSystem=strict`, a private
`/tmp`, no new privileges, and exactly one writable path. `MemoryMax` is set so
a leak cannot take the box down with it. `KillSignal=SIGINT` with a 45-second
grace, because the shutdown handler finishes the cycle in flight — a trade that
was broadcast but not recorded would be mirrored a second time on the next
start.

nginx terminates TLS and talks only to loopback. ufw allows ssh and the web
ports and nothing else; the application's own port is never reachable from
outside.

CORS is answered by the application rather than by nginx. Adding the headers in
both places sends two of each, and browsers reject that.
