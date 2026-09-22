import { PrivyClient } from "@privy-io/server-auth";
import type { VersionedTransaction } from "@solana/web3.js";

import type { PrivyUserApi, PrivyWalletApi } from "../chains/solana/privy-signer.js";

/**
 * Binds Privy's server SDK to the narrow interfaces the signer needs.
 *
 * The signer deliberately depends on two tiny interfaces rather than on
 * `PrivyClient`, so it can be tested without a network and so an SDK change
 * lands here instead of in the trading path. This file is the only place in
 * the codebase that knows what Privy's API actually looks like.
 */

export interface PrivyServerConfig {
  appId: string;
  appSecret: string;
  /**
   * Private key of the app's authorisation keypair.
   *
   * Required when the Privy app has one registered, which it should for a
   * server that signs on users' behalf: it is what proves a wallet RPC came
   * from this server rather than from anyone who obtained the app secret.
   */
  authorizationPrivateKey?: string;
}

export function createPrivyClient(cfg: PrivyServerConfig): PrivyClient {
  return new PrivyClient(cfg.appId, cfg.appSecret, {
    walletApi: cfg.authorizationPrivateKey
      ? { authorizationPrivateKey: cfg.authorizationPrivateKey }
      : undefined,
  });
}

/**
 * Wallet-signing adapter.
 *
 * Note for whoever operates this: the exact shape of Privy's Solana signing
 * call has moved between SDK versions. It is isolated here precisely so that
 * adjusting it is a one-function change, and the integration test to run first
 * is a single delegated signature on devnet -- not a live mirror.
 */
export function walletApiFor(privy: PrivyClient): PrivyWalletApi {
  const solana = (privy.walletApi as unknown as {
    solana: {
      signTransaction(args: { walletId: string; transaction: VersionedTransaction }): Promise<{
        signedTransaction: VersionedTransaction;
      }>;
    };
  }).solana;

  return {
    async signTransaction({ walletId, transaction }) {
      return solana.signTransaction({ walletId, transaction });
    },
  };
}

/** User-record adapter, used to confirm a delegation still stands. */
export function userApiFor(privy: PrivyClient): PrivyUserApi {
  return {
    async getUserById(userId: string) {
      const user = await privy.getUserById(userId);
      return {
        linkedAccounts: (user.linkedAccounts ?? []).map((a) => ({
          type: String((a as { type?: unknown }).type ?? ""),
          address: (a as { address?: string }).address,
          delegated: (a as { delegated?: boolean }).delegated,
        })),
      };
    },
  };
}

export interface VerifiedCaller {
  userId: string;
}

/**
 * Establish who is calling, from the access token the app already holds.
 *
 * Without this the subscribe endpoint would take a wallet address and a user
 * id on trust, and anyone could enrol anyone else's wallet -- or unsubscribe
 * them. The token is issued by Privy to the signed-in user and verified here
 * against Privy's public key, so the server never takes the caller's word for
 * their own identity.
 */
export async function verifyCaller(privy: PrivyClient, authHeader: string | null): Promise<VerifiedCaller | null> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!token) return null;
  try {
    const claims = await privy.verifyAuthToken(token);
    return { userId: claims.userId };
  } catch {
    // An unverifiable token is an anonymous caller, not an error to surface:
    // telling the caller *why* verification failed helps nobody but an
    // attacker probing for a valid token shape.
    return null;
  }
}
