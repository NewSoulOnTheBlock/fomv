import { Connection, PublicKey } from "@solana/web3.js";
import type { LeaderWatcher } from "../adapter.js";
import type { LeaderTrade } from "../../types.js";
import type { SolanaMarketData } from "./marketdata.js";
import { deltasFromMeta, extractSwap, type TokenBalance } from "./swaps.js";

export interface WatcherOptions {
  /** Signatures to pull per poll. */
  limit?: number;
  /** Transactions to request per RPC batch. Keep small on shared endpoints. */
  batchSize?: number;
  /** Attempts per batch before giving up on this poll. */
  maxRetries?: number;
  /**
   * Highest transaction version this client will accept.
   *
   * Not cosmetic: the RPC refuses to return a transaction newer than the
   * declared version rather than degrading, so one modern transaction in a
   * page fails the whole page. Raise it as the chain does; there is no benefit
   * to declaring support for less than we can actually decode, because the
   * parsed representation is plain JSON either way.
   */
  maxTxVersion?: number;
  /**
   * Pause between transaction batches, in ms.
   *
   * Backfill hammers an endpoint far harder than polling does -- a scoring run
   * issues in seconds what a watcher spreads over hours. Spacing the calls out
   * costs less wall time than absorbing the 429s that follow.
   */
  throttleMs?: number;
  /** Called for every transaction that was not recognised as a swap. */
  onSkip?: (signature: string, reason: string) => void;
}

/**
 * Retry with exponential backoff on transient RPC failures.
 *
 * Rate limiting is the normal condition on shared Solana endpoints, not an
 * exceptional one. A watcher that dies on the first 429 loses its place in the
 * leader's history, and the resulting cursor gap is invisible: trades simply
 * never get mirrored.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts: number, label: string): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      const retryable = /429|Too many requests|rate|timeout|fetch failed|ECONNRESET/i.test(msg);
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.random() * 200));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${String(lastErr)}`);
}

/**
 * Polls a leader's signature history and reconstructs their swaps.
 *
 * Polling is the floor, not the ceiling. For a production vault this should be
 * fronted by a Geyser/Yellowstone stream or a Helius webhook so trades arrive
 * in a few hundred milliseconds rather than on a poll interval; the extraction
 * logic below is identical either way, which is why it lives in a pure module.
 */
export class SolanaLeaderWatcher implements LeaderWatcher {
  readonly chain = "solana";

  constructor(
    private readonly conn: Connection,
    private readonly leader: string,
    private readonly data: SolanaMarketData,
    private readonly opts: WatcherOptions = {},
  ) {}

  async poll(cursor: string | null): Promise<{ trades: LeaderTrade[]; cursor: string | null }> {
    const owner = new PublicKey(this.leader);
    const retries = this.opts.maxRetries ?? 4;
    const sigs = await withRetry(
      () =>
        this.conn.getSignaturesForAddress(owner, {
          until: cursor ?? undefined,
          limit: this.opts.limit ?? 50,
        }),
      retries,
      "getSignaturesForAddress",
    );
    if (sigs.length === 0) return { trades: [], cursor };

    // getSignaturesForAddress returns newest-first; mirror oldest-first so the
    // vault reproduces the leader's sequence rather than reversing it.
    const ordered = sigs.filter((s) => s.err === null).reverse();
    const newestCursor = sigs[0]?.signature ?? cursor;

    const trades = await this.tradesFrom(ordered);
    return { trades, cursor: newestCursor };
  }

  /**
   * Walk *backwards* through a leader's history, oldest trade returned first.
   *
   * Deliberately not `poll`. Polling asks "what happened since the cursor" and
   * pages with `until`, which is the right shape for mirroring and the wrong
   * one for backfill: it can only ever reach forward to the present. Scoring
   * needs the opposite direction, so this pages with `before` and stops when
   * the chain runs out or the page budget does.
   */
  async history(
    opts: {
      pages?: number;
      onPage?: (page: number, trades: number) => void;
      /** Called when paging stopped early, with the reason it stopped. */
      onTruncated?: (reason: string) => void;
    } = {},
  ): Promise<LeaderTrade[]> {
    const owner = new PublicKey(this.leader);
    const retries = this.opts.maxRetries ?? 4;
    const pages = opts.pages ?? 8;
    const limit = this.opts.limit ?? 50;

    const all: LeaderTrade[] = [];
    let before: string | undefined;

    for (let page = 0; page < pages; page++) {
      const sigs = await withRetry(
        () => this.conn.getSignaturesForAddress(owner, { before, limit }),
        retries,
        "getSignaturesForAddress",
      );
      if (sigs.length === 0) break;

      // Page from the oldest signature of this page, so the next request
      // continues further back rather than repeating this one.
      before = sigs[sigs.length - 1]?.signature;

      const ordered = sigs.filter((x) => x.err === null).reverse();
      try {
        all.push(...(await this.tradesFrom(ordered)));
      } catch (err) {
        // Keep what was already decoded. A partial history still scores -- the
        // metrics report their own episode counts -- whereas throwing discards
        // every page that did succeed and reports nothing at all.
        opts.onTruncated?.(`stopped at page ${page + 1}: ${String(err)}`);
        break;
      }
      opts.onPage?.(page + 1, all.length);

      if (sigs.length < limit) break;
    }

    return all.sort((a, b) => a.ts - b.ts);
  }

  /**
   * Fetch and decode one page of signatures into swaps.
   *
   * Shared by `poll` and `history` so the two can never disagree about what
   * counts as a trade -- a backfill that classified swaps differently from the
   * live path would score a leader on behaviour the vault would not mirror.
   */
  private async tradesFrom(
    ordered: { signature: string }[],
  ): Promise<LeaderTrade[]> {
    if (ordered.length === 0) return [];
    const retries = this.opts.maxRetries ?? 4;

    // Batch in small chunks: a single 50-signature request is one oversized
    // call that shared endpoints reject outright. batchSize 1 drops to
    // individual getParsedTransaction calls, which several free endpoints
    // serve happily while refusing the batched form entirely.
    const batchSize = this.opts.batchSize ?? 5;
    const throttleMs = this.opts.throttleMs ?? 0;
    const cfg = {
      maxSupportedTransactionVersion: this.opts.maxTxVersion ?? 1,
      commitment: "confirmed" as const,
    };
    const txs: Awaited<ReturnType<Connection["getParsedTransactions"]>> = [];

    // Fetch one signature, or record it as unreadable.
    //
    // `null` rather than a throw, because the slot must stay aligned with
    // `ordered`: the loop below pairs transactions to signatures by index, and
    // dropping an entry would silently attribute every later transaction to
    // the wrong signature. An unreadable transaction is already handled
    // downstream as a skip.
    const fetchOne = async (signature: string) => {
      try {
        return await withRetry(() => this.conn.getParsedTransaction(signature, cfg), retries, "getParsedTransaction");
      } catch (err) {
        this.opts.onSkip?.(signature, `undecodable: ${String(err)}`);
        return null;
      }
    };

    if (batchSize <= 1) {
      for (const s of ordered) txs.push(await fetchOne(s.signature));
    } else {
      for (let i = 0; i < ordered.length; i += batchSize) {
        if (i > 0 && throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs));
        const chunk = ordered.slice(i, i + batchSize).map((s) => s.signature);
        try {
          txs.push(...(await withRetry(() => this.conn.getParsedTransactions(chunk, cfg), retries, "getParsedTransactions")));
        } catch {
          // A batch is all-or-nothing: one transaction the client cannot
          // decode -- a version newer than this library understands, say --
          // fails every signature alongside it. Retrying individually costs
          // one transaction instead of the whole chunk, and keeps a single
          // unusual transaction from blinding the vault to the leader.
          for (const signature of chunk) txs.push(await fetchOne(signature));
        }
      }
    }

    // Price every mint seen this batch in one pass rather than per transaction.
    const perTx: { sig: string; ts: number; deltas: ReturnType<typeof deltasFromMeta> }[] = [];
    const mints = new Set<string>();

    for (let i = 0; i < ordered.length; i++) {
      const sig = ordered[i]!.signature;
      const tx = txs[i];
      if (!tx?.meta) {
        this.opts.onSkip?.(sig, "no-meta");
        continue;
      }
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const ownerIndex = keys.indexOf(this.leader);
      const deltas = deltasFromMeta({
        ownerIndex: ownerIndex === -1 ? null : ownerIndex,
        preBalances: tx.meta.preBalances,
        postBalances: tx.meta.postBalances,
        fee: tx.meta.fee,
        preTokenBalances: (tx.meta.preTokenBalances ?? []) as TokenBalance[],
        postTokenBalances: (tx.meta.postTokenBalances ?? []) as TokenBalance[],
        owner: this.leader,
      });
      if (deltas.length === 0) {
        this.opts.onSkip?.(sig, "no-balance-change");
        continue;
      }
      for (const d of deltas) mints.add(d.mint);
      perTx.push({ sig, ts: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000, deltas });
    }

    const prices = await this.data.priceMany([...mints]);
    const trades: LeaderTrade[] = [];

    for (const { sig, ts, deltas } of perTx) {
      const res = extractSwap({
        deltas,
        signature: sig,
        ts,
        leader: this.leader,
        priceUsd: (m) => prices.get(m),
      });
      if (res.ok) trades.push(res.trade);
      else this.opts.onSkip?.(sig, res.reason);
    }

    return trades;
  }
}
