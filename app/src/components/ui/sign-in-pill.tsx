"use client";

import { LogIn } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The contract any sign-in visual must satisfy.
 *
 * This exists so the *look* of the sign-in control and the *wiring* behind it
 * can be replaced independently. `SignInButton` owns the Privy logic and knows
 * nothing about pixels; a visual owns pixels and knows nothing about Privy. A
 * registry component such as `@skiper-ui/skiper21` becomes a drop-in by being
 * wrapped in something that takes these props.
 */
export interface SignInVisualProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** True while the auth provider is mid-flight. */
  busy?: boolean;
  /** Why the control is disabled, surfaced as a native tooltip. */
  title?: string;
  className?: string;
}

/**
 * The default sign-in visual: a square amber key, not a pill.
 *
 * The previous version animated open on hover to preview the four login
 * providers. It was the most decorated control in the product and it sat on
 * the least interesting decision — which social account to use — while the
 * consequential button ("authorise trade signing") was plain. Removing the
 * flourish here and spending the attention on the consent panel is most of
 * what this redesign is.
 *
 * The caret blinks only while idle. A cursor that keeps blinking through a
 * pending action claims the control is waiting for you when it is not.
 */
export function SignInPill({ label, onClick, disabled, busy, title, className }: SignInVisualProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-busy={busy}
      className={cn(
        "group inline-flex h-10 min-w-0 max-w-full items-center justify-center gap-2 rounded-full px-5",
        "border border-primary bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]",
        "whitespace-nowrap text-[14px] font-semibold",
        "transition-all hover:brightness-110 active:scale-[0.98]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent",
        "disabled:text-muted-foreground disabled:brightness-100",
        className,
      )}
    >
      <LogIn className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{busy ? "opening" : label}</span>

    </button>
  );
}
