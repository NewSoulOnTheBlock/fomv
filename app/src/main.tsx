// Must be first: library code touches Buffer during module initialisation.
import "./polyfills";

import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AuthProvider } from "./lib/auth";
import "./styles.css";

/**
 * Privy gives FOMV social sign-in with a Solana wallet behind it.
 *
 * The point is that a depositor never has to own a wallet first: Privy creates
 * an embedded Solana wallet on their behalf at sign-in, so the audience is
 * "people who can log in with Google" rather than "people who already run
 * Phantom" -- which is most of the market this product needs.
 *
 * A missing app id disables sign-in and nothing else. The trader dashboard
 * reads static data and stays fully usable, so the app is never blank because
 * of a config gap.
 */
const appId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider appId={appId}>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
