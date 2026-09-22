import { VersionedTransaction } from "@solana/web3.js";

import { DelegationRevokedError, type WalletSigner } from "./signer.js";

/**
 * Signs for a subscriber's Privy embedded wallet, by delegation.
 *
 * # What this buys
 *
 * The subscriber owns their wallet. They grant this server a *session signer*,
 * which lets it sign transactions for them and nothing else. FOMV never holds
 * their key, never holds their funds, and cannot move tokens anywhere the
 * subscriber has not authorised. There is no pooled pot, so there are no
 * shares to account for and no NAV to price -- their position is simply their
 * own balance.
 *
 * The subscriber can revoke at any time from the app, and revocation takes
 * effect immediately regardless of what this server thinks.
 *
 * # The trust that remains
 *
 * Worth stating plainly rather than implying it is zero. Delegation authorises
 * *signing*, so a compromised or dishonest server could sign a swap that is
 * bad for the subscriber -- routing into a worthless token is still a
 * signature they permitted. What it cannot do is transfer their funds out to
 * an arbitrary address, which is the difference that matters: the failure mode
 * is bad trading, not theft.
 *
 * The guardrails in `src/mirror/guardrails.ts` are what bound the first risk,
 * and they run before anything reaches this class.
 */

/** The slice of Privy's server SDK this needs. Kept narrow so it can be faked. */
export interface PrivyWalletApi {
  /**
   * Sign a serialised transaction for a wallet the app has delegation on.
   * Mirrors `PrivyClient.walletApi.solana.signTransaction`.
   */
  signTransaction(args: {
    walletId: string;
    transaction: VersionedTransaction;
  }): Promise<{ signedTransaction: VersionedTransaction }>;
}

/** The slice used to confirm the delegation still exists. */
export interface PrivyUserApi {
  /** Mirrors `PrivyClient.getUserById`. */
  getUserById(userId: string): Promise<{
    linkedAccounts: { type: string; address?: string; delegated?: boolean }[];
  }>;
}

export interface PrivyDelegatedSignerOptions {
  /** Privy user who granted the delegation. */
  userId: string;
  /** Privy's id for the embedded wallet, not the on-chain address. */
  walletId: string;
  /** The on-chain address, for building quotes and reading balances. */
  address: string;
  wallets: PrivyWalletApi;
  users: PrivyUserApi;
  /**
   * How long a confirmed delegation is trusted before re-checking, in ms.
   *
   * Checking on every signature would add a round trip to every trade in a
   * latency-sensitive path; never checking would keep trading for someone who
   * revoked an hour ago. A short cache is the compromise, and the signature
   * failing is the backstop when revocation lands inside the window.
   */
  delegationTtlMs?: number;
}

export class PrivyDelegatedSigner implements WalletSigner {
  readonly address: string;
  private lastCheckedMs = 0;
  private lastResult = false;
  /**
   * Set once a signature has been refused for want of delegation.
   *
   * Sticky on purpose. Privy's user record can still report the wallet as
   * delegated for a moment after the grant is gone, and re-reading it would
   * resurrect a permission that the authoritative operation just denied. A
   * refused signature is stronger evidence than a cached profile, so it wins
   * until fresh consent replaces this signer.
   */
  private revoked = false;

  constructor(private readonly opts: PrivyDelegatedSignerOptions) {
    this.address = opts.address;
  }

  /**
   * Whether the subscriber still has delegation granted on this wallet.
   *
   * Reads the authoritative record from Privy rather than a local flag,
   * because revocation happens in the app and this server is not told.
   */
  async isActive(): Promise<boolean> {
    if (this.revoked) return false;

    const ttl = this.opts.delegationTtlMs ?? 60_000;
    const now = Date.now();
    if (this.lastResult && now - this.lastCheckedMs < ttl) return true;

    try {
      const user = await this.opts.users.getUserById(this.opts.userId);
      this.lastResult = user.linkedAccounts.some(
        (a) => a.address === this.address && a.delegated === true,
      );
    } catch {
      // An unreachable Privy is not consent. Failing closed means a subscriber
      // is briefly not followed; failing open means trading for someone who
      // may have revoked, which is the error that cannot be taken back.
      this.lastResult = false;
    }

    this.lastCheckedMs = now;
    return this.lastResult;
  }

  async sign(tx: VersionedTransaction): Promise<VersionedTransaction> {
    if (!(await this.isActive())) throw new DelegationRevokedError(this.address);

    try {
      const { signedTransaction } = await this.opts.wallets.signTransaction({
        walletId: this.opts.walletId,
        transaction: tx,
      });
      return signedTransaction;
    } catch (err) {
      // Privy rejects a signature for a wallet it no longer has delegation on.
      // Translating that into the specific error lets the runner unsubscribe
      // rather than retry a request that will never succeed.
      if (looksRevoked(err)) {
        this.revoked = true;
        this.lastResult = false;
        this.lastCheckedMs = Date.now();
        throw new DelegationRevokedError(this.address);
      }
      throw err;
    }
  }
}

function looksRevoked(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase();
  return (
    msg.includes("not delegated") ||
    msg.includes("delegation") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden")
  );
}
