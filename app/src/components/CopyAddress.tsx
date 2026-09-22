import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { shortAddress } from "@/lib/format";

/**
 * Copy the signed-in wallet address.
 *
 * The address is shown truncated, so copying is the only way to get the full
 * value out -- which makes the whole chip the button rather than a 16px icon
 * beside static text. A small target next to unclickable text gives no hint
 * that the text is the thing being copied, and is worse on touch.
 *
 * Failure is shown, not assumed away. The clipboard can refuse for reasons
 * that have nothing to do with the user (an unfocused document, a blocked
 * permission), and a control that always flashes a tick teaches people to
 * trust a paste that never happened.
 */

type State = "idle" | "copied" | "failed";

export function CopyAddress({
  address,
  lead = 4,
  tail = 4,
  className,
}: {
  address: string;
  /**
   * How much of the address to show either side of the ellipsis.
   *
   * Four is right in a header, where the chip is an identifier you already
   * know. It is too few on a trader page, where the address *is* the subject
   * and a reader may be checking it against a block explorer.
   */
  lead?: number;
  tail?: number;
  className?: string;
}) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleared on unmount so a copy just before navigation cannot set state on a
  // component that is already gone.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    const ok = await writeClipboard(address);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1_600);
  }, [address]);

  const label =
    state === "copied" ? "Address copied" : state === "failed" ? "Copy failed" : `Copy wallet address ${address}`;

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={state === "idle" ? address : label}
      className={cn(
        "group inline-flex h-9 items-center gap-2 rounded-full border border-transparent bg-white/[0.04] px-3.5",
        "hover:bg-white/[0.08]",
        "font-mono text-[13px] text-muted-foreground hover:text-foreground",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      <span>{shortAddress(address, lead, tail)}</span>
      {state === "copied" ? (
        <Check className="size-4 shrink-0 text-[var(--band-good)]" aria-hidden />
      ) : (
        <Copy
          className={cn("size-4 shrink-0", state === "failed" && "text-destructive")}
          aria-hidden
        />
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}

/**
 * Write to the clipboard, with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` is undefined outside a secure context, so on plain
 * HTTP the modern call does not return false -- reading the property throws.
 * The deprecated `execCommand` path still works there, which matters for
 * anyone opening the app on a LAN address while testing.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or blocked by policy: fall through and try the older path.
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen but still selectable; display:none would break the selection.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
