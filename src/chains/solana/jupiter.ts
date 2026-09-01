import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import type { ExecutionContext, Executor } from "../adapter.js";
import type { ExecutionResult, MirrorIntent, TokenRef } from "../../types.js";
import type { SolanaMarketData } from "./marketdata.js";

/** Keyless free tier. Set JUPITER_API_URL to https://api.jup.ag/swap/v1 with a key for pro. */
export const JUPITER_LITE = "https://lite-api.jup.ag/swap/v1";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

export interface JupiterOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Priority fee ceiling in lamports, passed through to the swap builder. */
  maxPriorityLamports?: number;
}

export class JupiterExecutor implements Executor {
  readonly chain = "solana";

  constructor(
    private readonly conn: Connection,
    private readonly data: SolanaMarketData,
    /** Null keeps the executor permanently in dry-run: it can quote, never sign. */
    private readonly signer: Keypair | null,
    private readonly opts: JupiterOptions = {},
  ) {}

  private get fetch() {
    return this.opts.fetchImpl ?? fetch;
  }
  private get base() {
    return this.opts.baseUrl ?? JUPITER_LITE;
  }
  private get headers(): Record<string, string> {
    return this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {};
  }

  async quote(args: {
    inputMint: string;
    outputMint: string;
    amountBaseUnits: bigint;
    slippageBps: number;
  }): Promise<JupiterQuote | null> {
    const q = new URLSearchParams({
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amount: args.amountBaseUnits.toString(),
      slippageBps: String(args.slippageBps),
    });
    const res = await this.fetch(`${this.base}/quote?${q}`, { headers: this.headers });
    if (!res.ok) return null;
    const body = (await res.json()) as JupiterQuote | { error?: string };
    return "outAmount" in body ? body : null;
  }

  /**
   * Honeypot probe: can we route this position back out to the quote token?
   *
   * A buy-only token quotes fine in one direction and not the other, so the
   * only trustworthy check is asking for the exit route before taking the
   * entry. Cheap, and it catches the failure mode that costs depositors
   * everything rather than a few bps.
   */
  async canSell(asset: TokenRef, quote: TokenRef, amountBaseUnits: bigint, slippageBps: number): Promise<boolean> {
    const q = await this.quote({
      inputMint: asset.address,
      outputMint: quote.address,
      amountBaseUnits,
      slippageBps,
    }).catch(() => null);
    return q !== null && q.routePlan.length > 0 && BigInt(q.outAmount) > 0n;
  }

  async execute(intent: MirrorIntent, ctx: ExecutionContext): Promise<ExecutionResult> {
    if (intent.kind === "skip") {
      return { intentId: intent.sourceTradeId, ok: false, filledUsd: 0, error: `skipped: ${intent.reason}` };
    }

    const prices = await this.data.priceMany([intent.asset.address, intent.quote.address]);
    const assetPx = prices.get(intent.asset.address);
    const quotePx = prices.get(intent.quote.address);
    if (!assetPx || !quotePx) {
      return { intentId: intent.sourceTradeId, ok: false, filledUsd: 0, error: "no price for asset or quote" };
    }

    let inputMint: string;
    let outputMint: string;
    let amountBaseUnits: bigint;

    if (intent.kind === "buy") {
      inputMint = intent.quote.address;
      outputMint = intent.asset.address;
      amountBaseUnits = toBaseUnits(intent.usdSize / quotePx, intent.quote.decimals);
    } else {
      inputMint = intent.asset.address;
      outputMint = intent.quote.address;
      amountBaseUnits = toBaseUnits(ctx.positionAmount * intent.fraction, intent.asset.decimals);
    }

    if (amountBaseUnits <= 0n) {
      return { intentId: intent.sourceTradeId, ok: false, filledUsd: 0, error: "amount rounds to zero" };
    }

    const q = await this.quote({ inputMint, outputMint, amountBaseUnits, slippageBps: ctx.maxSlippageBps });
    if (!q) {
      return { intentId: intent.sourceTradeId, ok: false, filledUsd: 0, error: "no route" };
    }

    // Jupiter's slippageBps bounds the *fill vs quote*; priceImpactPct is the
    // cost of the size itself. Both have to clear the cap, or a large order
    // silently pays the impact and calls it a success.
    const impactBps = Number(q.priceImpactPct) * 10_000;
    if (impactBps > ctx.maxSlippageBps) {
      return {
        intentId: intent.sourceTradeId,
        ok: false,
        filledUsd: 0,
        error: `price impact ${impactBps.toFixed(0)}bps exceeds ${ctx.maxSlippageBps}bps cap`,
      };
    }

    const inDecimals = intent.kind === "buy" ? intent.quote.decimals : intent.asset.decimals;
    const outDecimals = intent.kind === "buy" ? intent.asset.decimals : intent.quote.decimals;
    const inHuman = fromBaseUnits(BigInt(q.inAmount), inDecimals);
    const outHuman = fromBaseUnits(BigInt(q.outAmount), outDecimals);
    const filledUsd = intent.kind === "buy" ? inHuman * quotePx : outHuman * quotePx;
    const fillPxUsd = intent.kind === "buy" ? filledUsd / outHuman : filledUsd / inHuman;

    if (ctx.dryRun || !this.signer) {
      return {
        intentId: intent.sourceTradeId,
        ok: true,
        filledUsd,
        fillPxUsd,
        txSignature: undefined,
        error: this.signer ? undefined : "dry-run: no signer configured",
      };
    }

    const swapRes = await this.fetch(`${this.base}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: this.signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: this.opts.maxPriorityLamports ?? 1_000_000,
      }),
    });
    if (!swapRes.ok) {
      return {
        intentId: intent.sourceTradeId,
        ok: false,
        filledUsd: 0,
        error: `swap build failed: HTTP ${swapRes.status}`,
      };
    }

    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([this.signer]);

    const sig = await this.conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    const latest = await this.conn.getLatestBlockhash();
    const conf = await this.conn.confirmTransaction(
      { signature: sig, ...latest },
      "confirmed",
    );
    if (conf.value.err) {
      return { intentId: intent.sourceTradeId, ok: false, filledUsd: 0, txSignature: sig, error: String(conf.value.err) };
    }

    return { intentId: intent.sourceTradeId, ok: true, filledUsd, fillPxUsd, txSignature: sig };
  }
}

export function toBaseUnits(human: number, decimals: number): bigint {
  if (!Number.isFinite(human) || human < 0) return 0n;
  // Via a fixed-precision string so large memecoin amounts do not lose the
  // low-order digits to float exponent drift.
  const s = human.toFixed(decimals);
  const [i, f = ""] = s.split(".");
  return BigInt(i!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0").slice(0, decimals) || "0");
}

export function fromBaseUnits(base: bigint, decimals: number): number {
  return Number(base) / 10 ** decimals;
}
