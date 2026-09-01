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

    // Batch in small chunks: a single 50-signature request is one oversized
    // call that shared endpoints reject outright. batchSize 1 drops to
    // individual getParsedTransaction calls, which several free endpoints
    // serve happily while refusing the batched form entirely.
    const batchSize = this.opts.batchSize ?? 5;
    const cfg = { maxSupportedTransactionVersion: 0 as const, commitment: "confirmed" as const };
    const txs: Awaited<ReturnType<Connection["getParsedTransactions"]>> = [];

    if (batchSize <= 1) {
      for (const s of ordered) {
        const tx = await withRetry(
          () => this.conn.getParsedTransaction(s.signature, cfg),
          retries,
          "getParsedTransaction",
        );
        txs.push(tx);
      }
    } else {
      for (let i = 0; i < ordered.length; i += batchSize) {
        const chunk = ordered.slice(i, i + batchSize).map((s) => s.signature);
        const got = await withRetry(
          () => this.conn.getParsedTransactions(chunk, cfg),
          retries,
          "getParsedTransactions",
        );
        txs.push(...got);
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

    return { trades, cursor: newestCursor };
  }
}
