import { useState, type ReactNode } from "react";
import { Check, ShieldCheck, X } from "lucide-react";

import { DEFAULT_FEE_TERMS, MAX_TRADE_FEE_BPS } from "@engine/follow/fees.js";
import { SignInButton } from "@/components/SignInButton";
import { CopyAddress } from "@/components/CopyAddress";
import { Callout, Lamp, LeaderRow, Panel, PanelBody, PanelHead } from "@/components/term";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { bps } from "@/lib/format";
import type { RosterEntry } from "@/lib/types";

/**
 * Follow a leader with your own wallet.
 *
 * This replaced a deposit/withdraw panel, and the difference is the product.
 * There is no pot to pay into, so there is no share price to trust, no NAV to
 * post, and no moment where FOMV is holding the money. The user authorises
 * trade signing on their own wallet and can take that back whenever they like.
 *
 * # Why the "never" list is as long as the "allowed" list
 *
 * A consent screen that enumerates only what it is being granted reads as a
 * longer list of powers than it is, and the reader has no way to tell where
 * the permission stops. Listing the boundary explicitly is the only way to
 * make "cannot move your funds" a claim rather than an omission -- and it is
 * the true and load-bearing fact about this product.
 *
 * Nothing on this panel is styled to persuade. The action is the only amber
 * element; every guarantee is stated in the same weight as every limitation,
 * including the one that is worse for the user.
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

/** e.g. "half (0.50%)" — stated in both forms so neither has to be inferred. */
function splitLabel(): string {
  const share = DEFAULT_FEE_TERMS.leaderShareBps / 10_000;
  const asPct = (DEFAULT_FEE_TERMS.tradeFeeBps * share) / 100;
  return `${(share * 100).toFixed(0)}% (${asPct.toFixed(2)}%)`;
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
      // otherwise leave the button reading "waiting for your approval" for
      // ever -- which is exactly how a genuine failure first presented.
      await withTimeout(fn(), 90_000);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      // Only a deliberate dismissal is silent. An earlier version also matched
      // "denied", so a real permission failure vanished and the button simply
      // looked broken.
      const dismissed = /user (rejected|cancelled|canceled)|modal closed|dismissed/i.test(msg);
      setError(dismissed ? null : msg);
    } finally {
      // Always, including the timeout path. A stuck spinner tells the user
      // nothing and hides the thing that went wrong.
      setBusy(null);
    }
  };

  const following = auth.authenticated && auth.isDelegated;

  return (
    <Panel>
      <PanelHead
        label={`follow ${vault.handle}`}
        aside={following ? <Lamp tone="pos">active</Lamp> : undefined}
      />

      {!auth.authenticated ? (
        <SignedOut configured={auth.configured} />
      ) : !auth.walletAddress ? (
        <PanelBody className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-full" />
          <p className="text-[15px] text-muted-foreground">
            Creating your Solana wallet. Privy does this once, on first sign-in.
          </p>
        </PanelBody>
      ) : auth.isDelegated ? (
        <Following
          vault={vault}
          address={auth.walletAddress}
          busy={busy === "revoke"}
          onRevoke={() => run("revoke", auth.revoke)}
        />
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
        <div className="border-t border-border p-4">
          <Callout tone="warn">{error}</Callout>
        </div>
      )}
    </Panel>
  );
}

function SignedOut({ configured }: { configured: boolean }) {
  return (
    <PanelBody className="space-y-4">
      <p className="text-[15px] leading-relaxed text-muted-foreground">
        Sign in and a Solana wallet is created for you. You keep it. FOMV never holds your funds
        and cannot move them out.
      </p>
      <SignInButton
        className="w-full h-9"
        label={configured ? "sign in to follow" : "sign-in unavailable"}
      />
      {!configured && (
        <p className="text-[13px] text-faint">
          Set <code className="font-mono">VITE_PRIVY_APP_ID</code> in{" "}
          <code className="font-mono">app/.env.local</code> to enable sign-in. Everything else on
          this page works without it.
        </p>
      )}
    </PanelBody>
  );
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
  /** False when VITE_PRIVY_SIGNER_ID is missing, so delegation cannot start. */
  canDelegate: boolean;
  onDelegate: () => void;
}) {
  return (
    <>
      <div className="px-4 pt-4">
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Authorise FOMV to mirror this trader's swaps into your own wallet.
        </p>
      </div>

      <div className="p-4">
        <div className="term-label mb-2">what you are granting</div>
        <div className="border border-border divide-y divide-border">
          <Permission allowed>Sign swaps on your wallet, inside the published guardrails</Permission>
          <Permission>Move your funds to any other address</Permission>
          <Permission>See or export your private key</Permission>
          <Permission>Keep signing after you revoke</Permission>
        </div>
      </div>

      <div className="border-t border-border p-4">
        <div className="term-label mb-1">what it costs</div>
        <LeaderRow label="Fee per mirrored trade" value={bps(DEFAULT_FEE_TERMS.tradeFeeBps)} />
        <LeaderRow label={`— of which to ${vault.handle}`} value={splitLabel()} />
        <LeaderRow
          label={`Trades under $${DEFAULT_FEE_TERMS.minChargeableUsd}`}
          value={<span className="text-pos">free</span>}
        />
        <LeaderRow label="Deposit or withdrawal fee" value="none — there is no deposit" />
        <LeaderRow label="Ceiling on that fee" value={bps(MAX_TRADE_FEE_BPS)} />
      </div>

      <div className="border-t border-border p-4 space-y-3">
        <Button
          className="w-full font-mono"
          size="lg"
          onClick={onDelegate}
          disabled={busy || !canDelegate}
          title={canDelegate ? undefined : "VITE_PRIVY_SIGNER_ID is not configured"}
        >
          <ShieldCheck />
          {busy
            ? "waiting for your approval…"
            : canDelegate
              ? "Authorise trade signing"
              : "Signing not configured"}
        </Button>

        <div className="flex items-center justify-between gap-3">
          <span className="term-label">your wallet</span>
          <CopyAddress address={address} lead={6} tail={6} />
        </div>

        <p className="text-[13px] leading-relaxed text-faint">
          Fees are charged on trade notional rather than on profit, because a wallet you also trade
          yourself has no cost basis FOMV can honestly measure. In a losing month that is worse for
          you than a performance fee would be. Half of every fee goes to {vault.handle} — they
          supply the only thing you are paying for.
        </p>
      </div>
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
      <div className="p-4">
        <Callout tone="note">
          Following <strong className="font-semibold">{vault.handle}</strong>. New swaps are
          mirrored into your wallet, sized by their portfolio weight rather than their dollar
          amount — so your position scales to your balance, not theirs.
        </Callout>
      </div>

      <div className="border-t border-border p-4">
        <LeaderRow label="Your wallet" value={<CopyAddress address={address} lead={6} tail={6} />} />
        <LeaderRow label="Max position in one token" value={bps(1500)} />
        <LeaderRow label="Fee per mirrored trade" value={bps(DEFAULT_FEE_TERMS.tradeFeeBps)} />
        <LeaderRow label={`— of which to ${vault.handle}`} value={splitLabel()} />
      </div>

      <div className="border-t border-border p-4 space-y-3">
        <Button variant="outline" className="w-full font-mono" onClick={onRevoke} disabled={busy}>
          {busy ? "revoking…" : "Stop following"}
        </Button>
        <p className="text-[13px] leading-relaxed text-faint">
          Revoking withdraws signing permission immediately and leaves your balances untouched —
          nothing is sold and nothing moves.
        </p>
      </div>
    </>
  );
}

/** One line of the permission list: the capability, and whether it is granted. */
function Permission({ allowed = false, children }: { allowed?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2">
      {allowed ? (
        <Check className="size-3.5 mt-0.5 shrink-0 text-pos" aria-hidden />
      ) : (
        <X className="size-3.5 mt-0.5 shrink-0 text-neg" aria-hidden />
      )}
      <span className="flex-1 text-[14px] leading-snug text-secondary-foreground">{children}</span>
      <span
        className="term-label shrink-0 mt-0.5"
        style={{ color: allowed ? "var(--pos)" : "var(--neg)" }}
      >
        {allowed ? "allowed" : "never"}
      </span>
    </div>
  );
}

/** Published so the pricing copy and the engine cannot drift apart. */
export const FEE_CEILING_BPS = MAX_TRADE_FEE_BPS;
