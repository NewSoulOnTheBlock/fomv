import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AuthProvider } from "./lib/auth";
import { TooltipProvider } from "./components/ui/tooltip";
import "./styles.css";

/**
 * Privy gives FOMV social sign-in with a Solana wallet behind it.
 *
 * The point is that a follower never has to own a wallet first: Privy creates
 * an embedded Solana wallet on their behalf at sign-in, so the audience is
 * "people who can log in with Google" rather than "people who already run
 * Phantom" -- which is most of the market this product needs.
 *
 * A missing app id disables sign-in and nothing else. The audits read static
 * data and stay fully usable, and the apply funnel needs no account at all, so
 * the app is never blank because of a config gap.
 */
const appId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider appId={appId}>
      <TooltipProvider delayDuration={200}>
        <App />
      </TooltipProvider>
    </AuthProvider>
  </React.StrictMode>,
);
