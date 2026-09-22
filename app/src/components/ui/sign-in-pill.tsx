"use client";

import { motion } from "framer-motion";
import { useState } from "react";

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

const PROVIDERS = [
  { key: "google", label: "Google" },
  { key: "x", label: "X" },
  { key: "discord", label: "Discord" },
  { key: "email", label: "Email" },
] as const;

/**
 * Placeholder sign-in visual: a pill that widens to preview the providers.
 *
 * Stands in for `@skiper-ui/skiper21`, which is a Skiper UI Pro component and
 * needs a licence key to fetch. Written against the same props the real one
 * will be wrapped in, so swapping it is a one-line change in
 * `SignInButton` -- nothing about authentication moves.
 *
 * The expansion is decoration over a plain button: it stays a single
 * `<button>` with its own accessible label, so keyboard and screen-reader
 * users get the control whether or not the animation runs.
 */
export function SignInPill({ label, onClick, disabled, busy, title, className }: SignInVisualProps) {
  const [open, setOpen] = useState(false);
  const expanded = open && !disabled;

  return (
    <motion.button
      type="button"
      layout
      onClick={onClick}
      onHoverStart={() => setOpen(true)}
      onHoverEnd={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-busy={busy}
      transition={{ type: "spring", bounce: 0.18, duration: 0.45 }}
      className={cn(
        "relative flex h-10 items-center justify-center gap-2 overflow-hidden rounded-full px-4",
        "border font-semibold",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      style={{
        // Brand tokens rather than Tailwind palette, so the control tracks the
        // rest of the product when the theme changes.
        background: disabled ? "var(--bg-raised)" : "var(--accent)",
        borderColor: disabled ? "var(--line)" : "var(--accent)",
        color: disabled ? "var(--text-dim)" : "#05210f",
      }}
      animate={{ width: expanded ? 300 : 148 }}
      initial={false}
    >
      <motion.span layout="position" className="whitespace-nowrap text-sm">
        {busy ? "Opening…" : label}
      </motion.span>

      {expanded && !busy && (
        <motion.span
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          transition={{ delay: 0.12 }}
          className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium opacity-80"
        >
          {PROVIDERS.map((p, i) => (
            <span key={p.key} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden className="opacity-40">·</span>}
              {p.label}
            </span>
          ))}
        </motion.span>
      )}
    </motion.button>
  );
}
