import { useState } from "react";

import { DEFAULT_FEE_TERMS, MAX_TRADE_FEE_BPS } from "@engine/follow/fees.js";
import { useAuth } from "@/lib/auth";
import { SignInButton } from "@/components/SignInButton";
import type { RosterEntry } from "@/lib/types";
import { bps, shortAddress } from "@/lib/format";

/**
 * Follow a leader with your own wallet.
 *
 * This replaced a deposit/withdraw panel, and the difference is the product.
 * There is no pot to pay into, so there is no share price to trust, no NAV to
 * post, and no moment where FOMV is holding the money. The user authorises
 * trade signing on their own wallet and can take that back whenever they like.
 *
 * The copy is deliberately explicit about what delegation does and does not
 * permit. Someone handing a server permission over their funds deserves to
 * read the limits before they click, not after.
 */

/** Reject rather than hang if the wallet provider never settles. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("The wallet provider did not respond. Please try again.")), ms),
    ),
  ]);
}

export function FollowPanel({ vault }: { vault: RosterEntry }) {
  const auth = useAuth();
  const [busy, setBusy] = useState<"delegate" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: "delegate" | "revoke", fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      // Bounded, because a provider that neither resolves nor rejects would
      // otherwise leave the button reading "Waiting for your approval" for
      // ever -- which is exactly how a genuine failure first presented.
      await withTimeout(fn(), 90_000);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      // Only a deliberate dismissal is silent. The previous version also
      // matched "denied", so a real permission failure vanished and the button
      // simply looked broken.
      const dismissed = /user (rejected|cancelled|canceled)|modal closed|dismissed/i.test(msg);
      setError(dismissed ? null : msg);
    } finally {
      // Always, including the timeout path. A stuck spinner tells the user
      // nothing and hides the thing that went wrong.
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <h3>Follow {vault.handle}</h3>

      {!auth.authenticated ? (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            Sign in to create a wallet. You keep it — FOMV never holds your funds.
          </p>
          <SignInButton className="w-full" label={auth.configured ? "Sign in to follow" : "Sign-in not configured"} />
        </>
      ) : !auth.walletAddress ? (
        <p className="small muted">Creating your Solana wallet…</p>
      ) : auth.isDelegated ? (
        <Following vault={vault} address={auth.walletAddress} busy={busy === "revoke"} onRevoke={() => run("revoke", auth.revoke)} />
      ) : (
        <NotFollowing
          vault={vault}
          address={auth.walletAddress}
          busy={busy === "delegate"}
          canDelegate={auth.canDelegate}
          onDelegate={() => run("delegate", auth.delegate)}
        />
      )}

      {error && (
        <div className="callout flag" style={{ marginBottom: 0 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** e.g. "half (0.5%)" — stated in both forms so neither has to be inferred. */
function splitLabel(): string {
  const share = DEFAULT_FEE_TERMS.leaderShareBps / 10_000;
  const asPct = (DEFAULT_FEE_TERMS.tradeFeeBps * share) / 100;
  return `${(share * 100).toFixed(0)}% (${asPct.toFixed(2)}%)`;
}

function NotFollowing({
  vault,
  address,
  busy,
  canDelegate,
  onDelegate,
}: {
  vault: RosterEntry;
  address: string;
  busy: boolean;
  canDelegate: boolean;
  onDelegate: () => void;
}) {
  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        Authorise FOMV to mirror this trader's swaps into your own wallet.
      </p>

      <div className="quote" style={{ borderTop: "none", paddingTop: 0 }}>
        <Permission allowed>Sign swaps on your wallet, inside the published guardrails</Permission>
        <Permission>Move your funds to any other address</Permission>
        <Permission>Access your private key — FOMV never sees it</Permission>
        <Permission>Continue after you revoke</Permission>
      </div>

      <div className="quote">
        <div className="line">
          <span className="muted">Fee per mirrored trade</span>
          <span className="v">{bps(DEFAULT_FEE_TERMS.tradeFeeBps)}</span>
        </div>
        <div className="line">
          <span className="muted">— of which to {vault.handle}</span>
          <span className="v">{splitLabel()}</span>
        </div>
        <div className="line">
          <span className="muted">Trades under ${DEFAULT_FEE_TERMS.minChargeableUsd}</span>
          <span className="v">free</span>
        </div>
        <div className="line">
          <span className="muted">Deposit or withdrawal fee</span>
          <span className="v">none — there is no deposit</span>
        </div>
      </div>

      <button
        className="primary"
        style={{ width: "100%", marginTop: "1rem" }}
        onClick={onDelegate}
        disabled={busy || !canDelegate}
        title={canDelegate ? undefined : "VITE_PRIVY_SIGNER_ID is not configured"}
      >
        {busy ? "Waiting for your approval…" : canDelegate ? "Authorise trade signing" : "Signing not configured"}
      </button>

      <p className="small faint mono" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
        Your wallet {shortAddress(address, 6, 6)}
      </p>
      <p className="small faint" style={{ marginBottom: 0 }}>
        Fees are charged on trade notional rather than profit, because a wallet you
        also trade yourself has no cost basis FOMV can honestly measure. In a losing
        month that is worse for you than a performance fee would be. Half of every
        fee goes to {vault.handle} — they supply the only thing you are paying for.
      </p>
    </>
  );
}

function Following({
  vault,
  address,
  busy,
  onRevoke,
}: {
  vault: RosterEntry;
  address: string;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <>
      <div className="callout note">
        Following <strong>{vault.handle}</strong>. New swaps are mirrored into your wallet, sized by
        their portfolio weight rather than their dollar amount — so your position scales to your
        balance, not theirs.
      </div>

      <div className="quote" style={{ borderTop: "none" }}>
        <div className="line">
          <span className="muted">Your wallet</span>
          <span className="v mono">{shortAddress(address, 6, 6)}</span>
        </div>
        <div className="line">
          <span className="muted">Max position in one token</span>
          <span className="v">{bps(1500)}</span>
        </div>
        <div className="line">
          <span className="muted">Fee per mirrored trade</span>
          <span className="v">{bps(DEFAULT_FEE_TERMS.tradeFeeBps)}</span>
        </div>
        <div className="line">
          <span className="muted">— of which to {vault.handle}</span>
          <span className="v">{splitLabel()}</span>
        </div>
      </div>

      <button style={{ width: "100%", marginTop: "1rem" }} onClick={onRevoke} disabled={busy}>
        {busy ? "Revoking…" : "Stop following"}
      </button>

      <p className="small faint" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
        Revoking withdraws signing permission immediately and leaves your balances untouched —
        nothing is sold and nothing moves.
      </p>
    </>
  );
}

/**
 * One line of the permission list.
 *
 * Both what is granted and what is not, because a consent screen that lists
 * only capabilities reads as a longer list of powers than it is. The ceiling
 * on the fee is stated for the same reason.
 */
function Permission({ allowed = false, children }: { allowed?: boolean; children: React.ReactNode }) {
  return (
    <div className="line">
      <span className="muted">
        <span
          aria-hidden
          style={{ color: allowed ? "var(--good)" : "var(--bad)", marginRight: "0.5rem", fontWeight: 700 }}
        >
          {allowed ? "✓" : "✗"}
        </span>
        {children}
      </span>
      <span className="v faint small">{allowed ? "allowed" : "never"}</span>
    </div>
  );
}

/** Published so the pricing copy and the engine cannot drift apart. */
export const FEE_CEILING_BPS = MAX_TRADE_FEE_BPS;
