import { Keypair, VersionedTransaction } from "@solana/web3.js";

/**
 * Something that can authorise a transaction for one address.
 *
 * # Why this is an interface
 *
 * The executor used to hold a `Keypair`, which quietly assumed the only way to
 * trade is to possess someone's private key. For a follow product that
 * assumption is the whole problem: pooling other people's funds means holding
 * their keys, and holding their keys means they have to trust you not to leave.
 *
 * Delegated signing removes the assumption. A subscriber keeps their own
 * wallet and grants permission to sign *trades*; the server can move their
 * tokens through a swap and cannot move them anywhere else. The executor does
 * not need to know which of those it is talking to, so it no longer does.
 *
 * Implementations must never expose key material through this interface --
 * `sign` returns a signed transaction, never a secret.
 */
export interface WalletSigner {
  /** Base58 address this signer authorises for. */
  readonly address: string;
  /**
   * Whether the signer can still act.
   *
   * Delegation is revocable at any moment, by the subscriber, without telling
   * us. Any caller that is about to trade on someone else's behalf should ask
   * first rather than discovering it from a failed broadcast.
   */
  isActive(): Promise<boolean>;
  /** Sign in place and return the transaction, ready to broadcast. */
  sign(tx: VersionedTransaction): Promise<VersionedTransaction>;
}

/**
 * A signer backed by a local secret key.
 *
 * The honest shape of "this is my own wallet": use it for a solo bot, and for
 * the platform's own fee-collection account. Never for a subscriber -- if you
 * are constructing one of these from someone else's key, you have built a
 * custodial product and should be reading the trade-offs again.
 */
export class LocalKeypairSigner implements WalletSigner {
  readonly address: string;

  constructor(private readonly keypair: Keypair) {
    this.address = keypair.publicKey.toBase58();
  }

  async isActive(): Promise<boolean> {
    return true;
  }

  async sign(tx: VersionedTransaction): Promise<VersionedTransaction> {
    tx.sign([this.keypair]);
    return tx;
  }
}

/** Reason a delegated signer refused. Distinguishes "gone" from "broke". */
export class DelegationRevokedError extends Error {
  constructor(public readonly address: string) {
    super(`delegation revoked for ${address}`);
    this.name = "DelegationRevokedError";
  }
}
