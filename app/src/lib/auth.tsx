import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { PrivyProvider, usePrivy, useSessionSigners, useSolanaWallets } from "@privy-io/react-auth";

/**
 * Authentication and delegation, behind one small interface.
 *
 * # Why this exists rather than calling Privy from components
 *
 * The dashboard must work without Privy configured. Reading a trader's metrics
 * needs no account; only following one does. Privy hooks throw outside their
 * provider, so the choice has to be made above the components that consume it.
 *
 * It also keeps Privy's API surface in one file, which matters more now that
 * delegation is part of the product rather than just sign-in.
 *
 * # What delegation means here
 *
 * Granting delegation lets FOMV's server sign *trades* for the user's embedded
 * wallet. It does not hand over the key and does not let FOMV move funds to an
 * address of its choosing. The user can revoke at any time, and revocation is
 * immediate regardless of what the server believes.
 *
 * # Session signers, not delegated actions
 *
 * Privy has two wallet architectures and they do not share an API. On-device
 * wallets use `useDelegatedActions`; TEE wallets -- the newer default -- reject
 * that hook outright and use `useSessionSigners` instead. This app is on TEE,
 * so calling the wrong one failed with a message that never reached the UI and
 * looked, to the user, like a dead button.
 *
 * A session signer needs a signer id, created once in the Privy dashboard and
 * supplied as `VITE_PRIVY_SIGNER_ID`. Without it the flow cannot start, so the
 * UI says exactly that rather than letting the click go nowhere.
 */

export interface Auth {
  /** False when no app id is configured. Sign-in is unavailable; the rest works. */
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  displayName: string | null;
  /** The user's Solana address, once an embedded wallet exists. */
  walletAddress: string | null;
  /**
   * Privy's server-side id for that wallet, which the follow server needs in
   * order to request a signature. Null until delegation exists -- Privy only
   * issues it once the wallet is delegated.
   */
  walletId: string | null;
  /** True when this server may sign trades for the wallet. */
  isDelegated: boolean;
  /** False when VITE_PRIVY_SIGNER_ID is missing, so delegation cannot start. */
  canDelegate: boolean;
  login: () => void;
  logout: () => void;
  /** Prompt the user to authorise trade signing. */
  delegate: () => Promise<void>;
  /**
   * Withdraw that authorisation.
   *
   * Session signers are removed per wallet, so this affects only the wallet in
   * hand -- unlike the older delegated-actions API, which revoked every wallet
   * the user had ever delegated.
   */
  revoke: () => Promise<void>;
}

const notConfigured = async () => {
  throw new Error("Privy is not configured");
};

const UNCONFIGURED: Auth = {
  configured: false,
  ready: true,
  authenticated: false,
  displayName: null,
  walletAddress: null,
  walletId: null,
  isDelegated: false,
  canDelegate: false,
  login: () => {},
  logout: () => {},
  delegate: notConfigured,
  revoke: notConfigured,
};

const AuthContext = createContext<Auth>(UNCONFIGURED);

export function useAuth(): Auth {
  return useContext(AuthContext);
}

export function AuthProvider({ appId, children }: { appId: string | undefined; children: ReactNode }) {
  // A conditional *component*, not a conditional hook: both branches render a
  // provider, and whichever mounts keeps its hooks for its whole lifetime.
  if (!appId) {
    return <AuthContext.Provider value={UNCONFIGURED}>{children}</AuthContext.Provider>;
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["google", "twitter", "discord", "email"],
        appearance: {
          theme: "dark",
          accentColor: "#ffb224",
          landingHeader: "Sign in to FOMV",
          loginMessage: "Follow a curated trader with your own wallet.",
        },
        embeddedWallets: {
          // Solana only. Every asset the strategy touches is Solana; an
          // Ethereum wallet would be a second address with nothing to do.
          solana: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      <PrivyBridge>{children}</PrivyBridge>
    </PrivyProvider>
  );
}

const SIGNER_ID = import.meta.env.VITE_PRIVY_SIGNER_ID as string | undefined;

function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useSolanaWallets();
  const { addSessionSigners, removeSessionSigners } = useSessionSigners();

  const address = wallets[0]?.address ?? null;

  // Privy's user record is the authority on whether delegation stands. Reading
  // it here rather than tracking a local flag means the UI cannot drift out of
  // step with what the server is actually permitted to do.
  const account = useMemo(
    () =>
      user?.linkedAccounts?.find((a) => (a as { address?: string }).address === address) as
        | { delegated?: boolean; id?: string | null }
        | undefined,
    [user, address],
  );

  const isDelegated = Boolean(address && account?.delegated === true);
  // Privy issues the server wallet id only once delegation exists, which is
  // why this is read from the account rather than stored at sign-up.
  const walletId = account?.id ?? null;

  const delegate = useCallback(async () => {
    if (!address) throw new Error("No Solana wallet yet - sign in first.");
    if (!SIGNER_ID) {
      throw new Error(
        "VITE_PRIVY_SIGNER_ID is not set. Create a session signer in the Privy dashboard and put its id in app/.env.",
      );
    }
    await addSessionSigners({ address, signers: [{ signerId: SIGNER_ID }] });
  }, [address, addSessionSigners]);

  const revoke = useCallback(async () => {
    if (!address) return;
    await removeSessionSigners({ address });
  }, [address, removeSessionSigners]);

  const value = useMemo<Auth>(
    () => ({
      configured: true,
      ready,
      authenticated,
      displayName:
        user?.google?.email ??
        user?.email?.address ??
        user?.twitter?.username ??
        user?.discord?.username ??
        user?.farcaster?.username ??
        (authenticated ? "signed in" : null),
      walletAddress: address,
      walletId,
      isDelegated,
      canDelegate: Boolean(SIGNER_ID),
      login: () => void login(),
      logout: () => void logout(),
      delegate,
      revoke,
    }),
    [ready, authenticated, user, address, walletId, isDelegated, login, logout, delegate, revoke],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
