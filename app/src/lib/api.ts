import { operatorHint } from "./operator";
import type { ApplicationDraft } from "./types";

/**
 * The follow server, from the browser.
 *
 * # Why this file tolerates the server being absent
 *
 * The site is static and deploys on its own; the follow server is a
 * long-running process that may not be running, may not be configured, and in
 * development usually is not. Every call here therefore has to distinguish
 * "the server said no" from "there is no server", because those need different
 * words in front of an applicant. Being told your application was rejected
 * when in fact nobody was listening is the worst of the available outcomes.
 */

const BASE = (import.meta.env.VITE_FOMV_API as string | undefined)?.replace(/\/$/, "") ?? "";

export const apiConfigured = BASE.length > 0;

export interface ApplyOk {
  ok: true;
  id: string;
}

export interface ApplyFailed {
  ok: false;
  /** Field-level complaints from the server, safe to show verbatim. */
  errors: string[];
  /** True when the request never reached a server. */
  offline: boolean;
}

export async function submitApplication(draft: ApplicationDraft): Promise<ApplyOk | ApplyFailed> {
  if (!apiConfigured) {
    operatorHint(
      "apply",
      "Applications cannot be recorded because VITE_FOMV_API is unset. Point it at the follow " +
        "server in app/.env.local.",
    );
    return {
      ok: false,
      offline: true,
      errors: [
        "We could not save your application just now. Book a time below anyway and bring your " +
          "wallet address to the call — nothing is lost, and we will take your details there.",
      ],
    };
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
  } catch {
    return {
      ok: false,
      offline: true,
      errors: [
        "We could not reach our server. Book a time below anyway and bring your wallet address " +
          "to the call — nothing is lost.",
      ],
    };
  }

  const body = (await res.json().catch(() => null)) as
    | { id?: string; errors?: string[]; error?: string }
    | null;

  if (res.ok && body?.id) return { ok: true, id: body.id };

  return {
    ok: false,
    offline: false,
    errors: body?.errors ?? [body?.error ?? `The server refused this application (${res.status}).`],
  };
}
