import { useEffect, useRef, useState } from "react";
import { CalendarClock, ExternalLink } from "lucide-react";

import { Callout, Panel, PanelBody, PanelHead } from "@/components/term";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The booking step.
 *
 * # Why the widget is loaded here and not in index.html
 *
 * Calendly's script is ~90KB and only the last screen of one route ever needs
 * it. Putting the tag in the document head would make every visitor to the
 * roster pay for a scheduling tool they will never see. It is injected on
 * mount instead, once per page load, and removed from nothing — a second visit
 * to this route reuses the script that is already there.
 *
 * # Why there is always a plain link underneath
 *
 * A third-party iframe is the single most likely thing on this site to be
 * blocked: content blockers, strict corporate proxies and privacy browsers all
 * take it out, and when they do the applicant sees an empty box and concludes
 * the site is broken at the exact moment they were about to book. The link
 * below the widget is not a fallback that appears on failure — detecting that
 * failure from outside the iframe is unreliable — it is simply always there.
 */

const SCRIPT_SRC = "https://assets.calendly.com/assets/external/widget.js";

declare global {
  interface Window {
    Calendly?: {
      initInlineWidget(opts: { url: string; parentElement: HTMLElement }): void;
    };
  }
}

/**
 * The booking URL, themed to match.
 *
 * Calendly reads these colours from the query string; without them the embed
 * is a white rectangle in the middle of a black page, which looks like a
 * rendering fault rather than a booking form.
 */
function themed(url: string): string {
  const u = new URL(url);
  u.searchParams.set("hide_gdpr_banner", "1");
  u.searchParams.set("background_color", "0b0d11");
  u.searchParams.set("text_color", "e6e9ee");
  u.searchParams.set("primary_color", "ffb224");
  return u.toString();
}

export function CalendlyEmbed({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const mount = () => {
      if (cancelled || !host.current || !window.Calendly) return;
      // Guard against StrictMode's double-invoke mounting two widgets.
      if (host.current.childElementCount > 0) return;
      try {
        window.Calendly.initInlineWidget({ url: themed(url), parentElement: host.current });
        setReady(true);
      } catch {
        setFailed(true);
      }
    };

    if (window.Calendly) {
      mount();
      return () => {
        cancelled = true;
      };
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", mount);
    script.addEventListener("error", () => !cancelled && setFailed(true));

    if (!existing) {
      script.src = SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      script.removeEventListener("load", mount);
    };
  }, [url]);

  return (
    <Panel>
      <PanelHead
        label={
          <span className="inline-flex items-center gap-2">
            <CalendarClock className="size-3.5 text-primary" aria-hidden />
            book the call
          </span>
        }
        aside="30 min"
      />

      <div className="relative">
        {!ready && !failed && (
          <div className="p-4">
            <Skeleton className="h-[520px] w-full" />
          </div>
        )}
        {failed && (
          <PanelBody>
            <Callout tone="warn">
              The scheduling widget could not load — usually a content blocker. Use the link below;
              it opens the same calendar.
            </Callout>
          </PanelBody>
        )}
        <div
          ref={host}
          className="min-w-[320px]"
          style={{ height: failed ? 0 : 700, overflow: "hidden" }}
        />
      </div>

      <div className="border-t border-border px-4 py-3">
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 font-mono text-[12px] text-primary hover:underline"
        >
          Open the calendar in a new tab
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
    </Panel>
  );
}
