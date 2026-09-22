import { createContext, useContext, useMemo, type ReactNode } from "react";
import { PrivyProvider, usePrivy, useSolanaWallets } from "@privy-io/react-auth";

/**
 * Authentication, behind one small interface.
 *
 * Two reasons this exists rather than calling `usePrivy()` from components.
 *
 * First, the dashboard must work without Privy configured. Sign-in is only
 * needed to move money; reading a trader's metrics is not, and a missing app
 * id should not blank the product. Privy hooks throw outside their provider,
 * so the choice has to be made above the components that consume it.
 *
 * Second, nothing in the UI then depends on Privy's API surface. Swapping the
 * auth provider means rewriting this file.
 */

export interface Auth {
  /** False when no app id is configured. Sign-in is unavailable; the rest works. */
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  /** Human-readable identity for the header, if any. */
  displayName: string | null;
  /** The user's Solana address, once an embedded wallet exists. */
  walletAddress: string | null;
  login: () => void;
  logout: () => void;
}

const UNCONFIGURED: Auth = {
  configured: false,
  ready: true,
  authenticated: false,
  displayName: null,
  walletAddress: null,
  login: () => {},
  logout: () => {},
};

const AuthContext = createContext<Auth>(UNCONFIGURED);

export function useAuth(): Auth {
  return useContext(AuthContext);
}

export function AuthProvider({ appId, children }: { appId: string | undefined; children: ReactNode }) {
  // A conditional *component*, not a conditional hook: both branches render a
  // provider, and whichever one mounts keeps its hooks for its whole lifetime.
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
          accentColor: "#4ade80",
          landingHeader: "Sign in to FOMV",
          loginMessage: "Deposit into a vault that mirrors a curated fomo trader.",
        },
        embeddedWallets: {
          // Solana only. The vault program, the share mint and every asset the
          // book holds are Solana; an Ethereum wallet would be a second
          // address with nothing to do here.
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
      walletAddress: wallets[0]?.address ?? null,
      login: () => void login(),
      logout: () => void logout(),
    }),
    [ready, authenticated, user, wallets, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
