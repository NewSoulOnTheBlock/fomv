import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { PrivyProvider, useDelegatedActions, usePrivy, useSolanaWallets } from "@privy-io/react-auth";

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
 */

export interface Auth {
  /** False when no app id is configured. Sign-in is unavailable; the rest works. */
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  displayName: string | null;
  /** The user's Solana address, once an embedded wallet exists. */
  walletAddress: string | null;
  /** True when this server may sign trades for the wallet. */
  isDelegated: boolean;
  login: () => void;
  logout: () => void;
  /** Prompt the user to authorise trade signing. */
  delegate: () => Promise<void>;
  /**
   * Withdraw that authorisation.
   *
   * Privy revokes *every* wallet the user has delegated, not just this one, so
   * the UI says as much rather than implying a narrower action.
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
  isDelegated: false,
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

function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useSolanaWallets();
  const { delegateWallet, revokeWallets } = useDelegatedActions();

  const address = wallets[0]?.address ?? null;

  // Privy's user record is the authority on whether delegation stands. Reading
  // it here rather than tracking a local flag means the UI cannot drift out of
  // step with what the server is actually permitted to do.
  const isDelegated = useMemo(
    () =>
      Boolean(
        address &&
          user?.linkedAccounts?.some(
            (a) => (a as { address?: string; delegated?: boolean }).address === address &&
              (a as { delegated?: boolean }).delegated === true,
          ),
      ),
    [user, address],
  );

  const delegate = useCallback(async () => {
    if (!address) throw new Error("No Solana wallet to delegate yet");
    await delegateWallet({ address, chainType: "solana" });
  }, [address, delegateWallet]);

  const revoke = useCallback(async () => {
    await revokeWallets();
  }, [revokeWallets]);

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
      isDelegated,
      login: () => void login(),
      logout: () => void logout(),
      delegate,
      revoke,
    }),
    [ready, authenticated, user, address, isDelegated, login, logout, delegate, revoke],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
