import { useCallback, useState, type ComponentType } from "react";

import { useAuth } from "@/lib/auth";
import { SignInPill, type SignInVisualProps } from "@/components/ui/sign-in-pill";

/**
 * The sign-in control: Privy wiring, with the visual left open.
 *
 * Everything that can go wrong with authentication lives here -- unconfigured
 * provider, in-flight login, a user who cancels the modal -- and none of it
 * lives in the thing being drawn. That split is the point: swapping the visual
 * for `@skiper-ui/skiper21` cannot break sign-in, and fixing sign-in cannot
 * disturb the visual.
 *
 * ## Dropping in skiper21
 *
 * The component is Skiper UI **Pro** and needs a licence to fetch:
 *
 * ```bash
 * echo "SKIPER_UI_LICENSE=your-key" >> app/.env.local
 * cd app && pnpm dlx shadcn@latest add @skiper-ui/skiper21
 * ```
 *
 * `components.json` already points `@skiper-ui` at the gated registry with a
 * bearer header, so that command is all it takes. Then write a small adapter
 * matching `SignInVisualProps` and pass it here:
 *
 * ```tsx
 * <SignInButton visual={Skiper21SignIn} />
 * ```
 *
 * Nothing below changes.
 */
export function SignInButton({
  visual: Visual = SignInPill,
  className,
  label,
}: {
  visual?: ComponentType<SignInVisualProps>;
  className?: string;
  /** Overrides the default wording, e.g. inside the deposit panel. */
  label?: string;
}) {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);

  const onClick = useCallback(() => {
    if (!auth.configured || busy) return;
    setBusy(true);
    try {
      auth.login();
    } finally {
      // Privy owns a modal, and the user may simply close it. Clearing the
      // busy flag on the next tick keeps the control usable in that case --
      // waiting for an authentication that never arrives would leave the only
      // way into the product stuck on "Opening…".
      setTimeout(() => setBusy(false), 600);
    }
  }, [auth, busy]);

  const disabled = !auth.configured || !auth.ready;

  return (
    <Visual
      label={label ?? (auth.configured ? "sign in" : "sign-in unavailable")}
      onClick={onClick}
      disabled={disabled}
      busy={busy}
      title={
        !auth.configured
          ? "Set VITE_PRIVY_APP_ID in app/.env.local to enable sign-in"
          : !auth.ready
            ? "Connecting to Privy…"
            : "Sign in with Google, X, Discord or email — a Solana wallet is created for you"
      }
      className={className}
    />
  );
}
