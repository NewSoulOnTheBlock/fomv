import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import type { MarketDataSource } from "../adapter.js";
import type { Holding, MarketInfo, PortfolioSnapshot, TokenRef } from "../../types.js";
import { QUOTE_MINTS, SOL_MINT, USDC_MINT, USDT_MINT } from "./swaps.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const DEXSCREENER = "https://api.dexscreener.com/latest/dex/tokens";

/** Parsed fields of an SPL mint account. Layout is fixed at 82 bytes. */
export function parseMintAuthorities(data: Uint8Array): {
  mintAuthorityRenounced: boolean;
  freezeAuthorityRenounced: boolean;
  decimals: number;
  supply: bigint;
} {
  if (data.length < 82) throw new Error(`parseMintAuthorities: expected >= 82 bytes, got ${data.length}`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mintAuthorityOption = dv.getUint32(0, true);
  let supply = 0n;
  for (let i = 0; i < 8; i++) supply |= BigInt(data[36 + i]!) << BigInt(8 * i);
  const decimals = data[44]!;
  const freezeAuthorityOption = dv.getUint32(46, true);
  return {
    mintAuthorityRenounced: mintAuthorityOption === 0,
    freezeAuthorityRenounced: freezeAuthorityOption === 0,
    decimals,
    supply,
  };
}

interface DexScreenerPair {
  priceUsd?: string;
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
}

export class SolanaMarketData implements MarketDataSource {
  constructor(
    private readonly conn: Connection,
    private readonly opts: { dexscreenerUrl?: string; fetchImpl?: typeof fetch } = {},
  ) {}

  private get fetch() {
    return this.opts.fetchImpl ?? fetch;
  }

  async market(token: TokenRef): Promise<MarketInfo | null> {
    const mint = new PublicKey(token.address);

    const [pairs, mintInfo, concentration] = await Promise.all([
      this.pairs(token.address),
      this.conn.getAccountInfo(mint).catch(() => null),
      this.topHolderConcentration(mint).catch(() => null),
    ]);

    if (!mintInfo) return null;
    const parsed = parseMintAuthorities(mintInfo.data);

    const priced = pairs.filter((p) => p.priceUsd && Number(p.priceUsd) > 0);
    if (priced.length === 0) return null;

    const liquidityUsd = pairs.reduce((a, p) => a + (p.liquidity?.usd ?? 0), 0);
    const deepest = priced.reduce((a, b) => ((a.liquidity?.usd ?? 0) >= (b.liquidity?.usd ?? 0) ? a : b));
    const created = pairs.map((p) => p.pairCreatedAt).filter((t): t is number => typeof t === "number");
    const ageSec = created.length ? (Date.now() - Math.min(...created)) / 1000 : 0;

    return {
      token: { ...token, decimals: parsed.decimals },
      priceUsd: Number(deepest.priceUsd),
      liquidityUsd,
      ageSec,
      mintAuthorityRenounced: parsed.mintAuthorityRenounced,
      freezeAuthorityRenounced: parsed.freezeAuthorityRenounced,
      topHolderConcentration: concentration,
      // Token-2022 transfer hooks/fees live in mint extensions; treat any
      // Token-2022 mint as fee-bearing unless proven otherwise rather than
      // assuming zero.
      transferFeeBps: mintInfo.owner.equals(TOKEN_2022_PROGRAM) ? 1 : 0,
      // Filled in by the executor's pre-trade sell simulation, which is the
      // only honest way to answer it.
      sellSimulationFailed: false,
    };
  }

  private async pairs(address: string): Promise<DexScreenerPair[]> {
    const base = this.opts.dexscreenerUrl ?? DEXSCREENER;
    const res = await this.fetch(`${base}/${address}`);
    if (!res.ok) return [];
    const body = (await res.json()) as { pairs?: DexScreenerPair[] | null };
    return body.pairs ?? [];
  }

  /**
   * Fraction of supply held by the top 10 *wallets*.
   *
   * The subtlety is separating real holders from AMM pool vaults, which always
   * dominate the largest-accounts list and would make every healthy token look
   * dangerously concentrated. The discriminator used here is general rather
   * than a hardcoded list of AMM programs: a token account belonging to a real
   * wallet has an owner that is itself a System-Program account, whereas a pool
   * vault's owner is a PDA owned by the AMM program. Checking the owner's owner
   * separates them without knowing which venues exist.
   */
  async topHolderConcentration(mint: PublicKey): Promise<number | null> {
    // Note: getTokenLargestAccounts is an *indexed* RPC method. Free endpoints
    // reject it, so a vault running on a public node cannot measure this at
    // all and must run against a real provider (Helius, Triton, QuickNode).
    // Returning null rather than a pessimistic number is what lets the
    // guardrail report that honestly instead of blaming the token.
    const [largest, mintInfo] = await Promise.all([
      this.conn.getTokenLargestAccounts(mint),
      this.conn.getAccountInfo(mint),
    ]);
    if (!mintInfo) return null;
    const { supply, decimals } = parseMintAuthorities(mintInfo.data);
    if (supply === 0n) return null;
    const totalSupply = Number(supply) / 10 ** decimals;
    if (!Number.isFinite(totalSupply) || totalSupply <= 0) return null;

    const accounts = largest.value.slice(0, 20);
    if (accounts.length === 0) return 0;

    const infos = await this.conn.getMultipleAccountsInfo(accounts.map((a) => a.address));
    const owners: (PublicKey | null)[] = infos.map((info) => {
      if (!info) return null;
      if (!info.owner.equals(TOKEN_PROGRAM) && !info.owner.equals(TOKEN_2022_PROGRAM)) return null;
      // SPL token account layout: mint(32) | owner(32) | ...
      return new PublicKey(info.data.subarray(32, 64));
    });

    const ownerInfos = await this.conn.getMultipleAccountsInfo(
      owners.filter((o): o is PublicKey => o !== null),
    );
    const isWallet = new Map<string, boolean>();
    let j = 0;
    for (const o of owners) {
      if (!o) continue;
      const info = ownerInfos[j++];
      // A plain wallet is System-Program owned. A PDA vault is not.
      isWallet.set(o.toBase58(), !info || info.owner.equals(SystemProgram.programId));
    }

    const walletBalances = accounts
      .map((a, i) => {
        const o = owners[i];
        if (!o || !isWallet.get(o.toBase58())) return 0;
        return a.uiAmount ?? 0;
      })
      .filter((x) => x > 0)
      .sort((a, b) => b - a)
      .slice(0, 10);

    const held = walletBalances.reduce((a, b) => a + b, 0);
    return Math.min(1, held / totalSupply);
  }

  /**
   * Value the whole tradable book, idle quote balances included.
   *
   * Including idle quote is not optional: portfolio-weight sizing divides by
   * this number, so a leader sitting 90% in USDC with one small position must
   * not look like someone with all their capital in that position.
   */
  async portfolio(owner: string): Promise<PortfolioSnapshot> {
    const pubkey = new PublicKey(owner);
    const [lamports, tokenAccounts, token2022] = await Promise.all([
      this.conn.getBalance(pubkey),
      this.conn.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM }),
      this.conn
        .getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM })
        .catch(() => ({ value: [] as never[] })),
    ]);

    const raw: { mint: string; amount: number; decimals: number }[] = [
      { mint: SOL_MINT, amount: lamports / 1e9, decimals: 9 },
    ];
    for (const { account } of [...tokenAccounts.value, ...token2022.value]) {
      const info = (account.data as { parsed: { info: ParsedTokenInfo } }).parsed.info;
      const amount = Number(info.tokenAmount.uiAmountString ?? "0");
      if (amount > 0) raw.push({ mint: info.mint, amount, decimals: info.tokenAmount.decimals });
    }

    const prices = await this.priceMany(raw.map((r) => r.mint));
    const holdings: Holding[] = [];
    let totalUsd = 0;
    for (const r of raw) {
      const px = prices.get(r.mint);
      if (px === undefined) continue; // unpriceable dust does not belong in the denominator
      const usdValue = r.amount * px;
      if (usdValue < 0.01) continue;
      holdings.push({
        token: { chain: "solana", address: r.mint, decimals: r.decimals, symbol: symbolFor(r.mint) },
        amount: r.amount,
        usdValue,
      });
      totalUsd += usdValue;
    }

    holdings.sort((a, b) => b.usdValue - a.usdValue);
    return { owner, ts: Date.now(), totalUsd, holdings };
  }

  /** USD prices by mint. Stablecoins are pinned; the rest come from pools. */
  async priceMany(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const unique = [...new Set(mints)];
    const needed: string[] = [];
    for (const m of unique) {
      if (m === USDC_MINT || m === USDT_MINT) out.set(m, 1);
      else needed.push(m);
    }
    // DexScreener accepts a comma-joined list, capped at 30 per request.
    for (let i = 0; i < needed.length; i += 30) {
      const chunk = needed.slice(i, i + 30);
      const base = this.opts.dexscreenerUrl ?? DEXSCREENER;
      const res = await this.fetch(`${base}/${chunk.join(",")}`).catch(() => null);
      if (!res || !res.ok) continue;
      const body = (await res.json()) as { pairs?: (DexScreenerPair & { baseToken?: { address: string } })[] | null };
      // Keep the price from the deepest pool for each mint.
      const best = new Map<string, { liq: number; px: number }>();
      for (const p of body.pairs ?? []) {
        const addr = p.baseToken?.address;
        const px = Number(p.priceUsd);
        if (!addr || !Number.isFinite(px) || px <= 0) continue;
        const liq = p.liquidity?.usd ?? 0;
        const prev = best.get(addr);
        if (!prev || liq > prev.liq) best.set(addr, { liq, px });
      }
      for (const [addr, v] of best) out.set(addr, v.px);
    }
    return out;
  }
}

function symbolFor(mint: string): string | undefined {
  if (mint === SOL_MINT) return "SOL";
  if (mint === USDC_MINT) return "USDC";
  if (mint === USDT_MINT) return "USDT";
  return undefined;
}

export { QUOTE_MINTS };

interface ParsedTokenInfo {
  mint: string;
  tokenAmount: { decimals: number; uiAmountString?: string | null };
}
