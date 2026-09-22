import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { shortAddress } from "@/lib/format";

/**
 * Copy the signed-in user's wallet address.
 *
 * The address is shown truncated because the full 44 characters would crowd
 * the header, which means the only way to get it out is to copy it -- so the
 * control is the whole chip rather than a separate icon. A 16px target beside
 * static text is worse on touch and gives no hint that the text is the thing
 * being copied.
 */

type State = "idle" | "copied" | "failed";

export function CopyAddress({ address, className }: { address: string; className?: string }) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear on unmount so a copy just before navigation cannot set state on a
  // component that is gone.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

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
      className={`copy-addr${className ? ` ${className}` : ""}`}
      onClick={copy}
      aria-label={label}
      title={state === "idle" ? address : label}
    >
      <span className="mono">{shortAddress(address, 4, 4)}</span>
      {state === "copied" ? (
        <Check size={13} aria-hidden style={{ color: "var(--good)" }} />
      ) : (
        <Copy size={13} aria-hidden style={{ color: state === "failed" ? "var(--bad)" : undefined }} />
      )}
      {/* Announced to screen readers without taking layout space. */}
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
 * HTTP the modern call is not merely blocked -- the property does not exist
 * and reading it throws. The deprecated `execCommand` path still works there,
 * which matters for anyone running the app on a LAN address during testing.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or blocked by policy: fall through and try the old way.
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Kept out of view and out of the tab order, but still selectable --
    // display:none would make the selection fail.
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
