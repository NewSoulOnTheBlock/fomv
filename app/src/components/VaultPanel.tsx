import { useMemo, useState } from "react";
import { quoteWithdrawal, withdrawalFeeShares } from "@engine/platform/fees.js";
import { MAX_WITHDRAW_FEE_BPS } from "@engine/platform/config.js";
import { useAuth } from "../lib/auth";
import { SignInButton } from "./SignInButton";
import type { PlatformInfo, RosterEntry } from "../lib/types";
import { bps, EMPTY, shortAddress, usd } from "../lib/format";

/**
 * Deposit and withdraw.
 *
 * The fee arithmetic here is not a reimplementation for display: it imports
 * `quoteWithdrawal` from the same module the vault operator runs, aliased in
 * `vite.config.ts`. A number shown to a depositor and a number charged by the
 * protocol that came from two different code paths would eventually disagree,
 * and the depositor would be the one to discover it.
 *
 * What it will not do is pretend. Until the program is deployed there is
 * nothing to send a transaction to, so the action is disabled and says exactly
 * why. Quoting a fee is honest; simulating a settlement is not.
 */

type Mode = "deposit" | "withdraw";

/** Share mint decimals, fixed at 6 in `initialize_vault`. */
const SHARE_DECIMALS = 6;
const SHARE_UNIT = 10 ** SHARE_DECIMALS;

export function VaultPanel({ vault, platform }: { vault: RosterEntry; platform: PlatformInfo }) {
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");

  const feeBps = vault.withdrawFeeBps ?? platform.withdrawFeeBps;
  const live = vault.status === "live";
  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;

  return (
    <div className="card">
      <h3>{vault.handle} vault</h3>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === "deposit"} onClick={() => setMode("deposit")}>
          Deposit
        </button>
        <button role="tab" aria-selected={mode === "withdraw"} onClick={() => setMode("withdraw")}>
          Withdraw
        </button>
      </div>

      <label className="small muted" htmlFor="amount">
        {mode === "deposit" ? "Amount in USDC" : "Shares to redeem"}
      </label>
      <input
        id="amount"
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        style={{ marginTop: "0.35rem" }}
      />

      {mode === "deposit" ? (
        <DepositQuote amountUsd={valid ? parsed : null} vault={vault} />
      ) : (
        <WithdrawQuote shares={valid ? parsed : null} feeBps={feeBps} />
      )}

      <div style={{ marginTop: "1.1rem" }}>
        {!auth.authenticated ? (
          <SignInButton
            className="w-full"
            label={auth.configured ? "Sign in to continue" : "Sign-in not configured"}
          />
        ) : (
          <button className="primary" style={{ width: "100%" }} disabled title={disabledReason(platform, vault)}>
            {mode === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        )}
        {auth.authenticated && (
          <p className="small faint" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
            {disabledReason(platform, vault)}
          </p>
        )}
        {auth.authenticated && auth.walletAddress && (
          <p className="small faint mono" style={{ marginTop: "0.4rem", marginBottom: 0 }}>
            Paying from {shortAddress(auth.walletAddress, 6, 6)}
          </p>
        )}
        {auth.authenticated && !auth.walletAddress && (
          <p className="small faint" style={{ marginTop: "0.4rem", marginBottom: 0 }}>
            No Solana wallet on this account yet — Privy creates one on first sign-in.
          </p>
        )}
      </div>

      {!live && (
        <div className="callout gap" style={{ marginBottom: 0 }}>
          This vault is {vault.status}. Deposits require a live listing; in-kind withdrawal is
          unaffected by listing status and never depends on the operator.
        </div>
      )}
    </div>
  );
}

function disabledReason(platform: PlatformInfo, vault: RosterEntry): string {
  if (!platform.programDeployed) {
    return "The vault program is not deployed yet, so there is nothing to send this transaction to. Fees above are exact; the settlement is not available.";
  }
  if (vault.status !== "live") return `This vault is ${vault.status} and is not accepting deposits.`;
  if (!vault.vaultAddress) return "This vault has no on-chain address recorded.";
  return "Ready.";
}

function DepositQuote({ amountUsd, vault }: { amountUsd: number | null; vault: RosterEntry }) {
  return (
    <div className="quote">
      <div className="line">
        <span className="muted">You deposit</span>
        <span className="v">{usd(amountUsd)}</span>
      </div>
      <div className="line">
        <span className="muted">Platform deposit fee</span>
        <span className="v">{usd(0)}</span>
      </div>
      <div className="line">
        <span className="muted">Leader's performance fee</span>
        <span className="v">{bps(vault.performanceFeeBps)} of new profit only</span>
      </div>
      <div className="line total">
        <span>Credited to your shares</span>
        <span className="v">{usd(amountUsd)}</span>
      </div>
      <p className="small faint" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
        FOMV charges nothing to deposit. Shares are minted against a posted NAV once the manager
        prices the book, so the exact share count depends on the NAV at settlement.
      </p>
    </div>
  );
}

function WithdrawQuote({ shares, feeBps }: { shares: number | null; feeBps: number }) {
  const quote = useMemo(() => {
    if (shares === null) return null;
    // The program works in base units of a 6-decimal share mint, so the quote
    // is computed there too. Quoting on the display value would round
    // differently from the chain on exactly the small withdrawals where the
    // difference is most visible.
    const base = BigInt(Math.floor(shares * SHARE_UNIT));
    if (base <= 0n) return null;
    try {
      return quoteWithdrawal({
        shares: base,
        vaultWithdrawFeeBps: feeBps,
        // The payout fraction needs total supply, which this build does not
        // read from chain. Passing the withdrawal itself makes the fraction
        // meaningless, so it is simply not displayed below.
        totalSharesBefore: base,
      });
    } catch {
      return null;
    }
  }, [shares, feeBps]);

  const feeShares = quote ? Number(quote.feeShares) / SHARE_UNIT : null;
  const burned = quote ? Number(quote.sharesBurned) / SHARE_UNIT : null;

  return (
    <div className="quote">
      <div className="line">
        <span className="muted">Shares presented</span>
        <span className="v">{shares === null ? EMPTY : shares.toLocaleString()}</span>
      </div>
      <div className="line">
        <span className="muted">Protocol fee ({bps(feeBps)})</span>
        <span className="v">{feeShares === null ? EMPTY : `${feeShares.toLocaleString()} shares`}</span>
      </div>
      <div className="line total">
        <span>Shares redeemed in-kind</span>
        <span className="v">{burned === null ? EMPTY : burned.toLocaleString()}</span>
      </div>
      <p className="small faint" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
        Withdrawals pay out <strong>in kind</strong>: redeeming X% of the shares pays X% of every
        token the vault holds, with no oracle involved. The protocol fee is taken in shares rather
        than tokens, so nothing has to be sold to pay it. Capped by the program at{" "}
        {bps(MAX_WITHDRAW_FEE_BPS)} — moving that ceiling needs a program upgrade, not a setting.
      </p>
      {shares !== null && withdrawalFeeShares(BigInt(Math.floor(shares * SHARE_UNIT)), feeBps) === 0n && feeBps > 0 && (
        <p className="small faint" style={{ marginBottom: 0 }}>
          This amount is small enough that the fee rounds down to nothing. The protocol floors its
          own fee rather than rounding it up.
        </p>
      )}
    </div>
  );
}
