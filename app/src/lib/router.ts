import { useEffect, useState } from "react";

/**
 * Hash routing, in forty lines and no dependency.
 *
 * # Why the app needs routes at all now
 *
 * It used to hold the selected trader in `useState`, which was fine while the
 * only thing to show was a roster. The funnel changes that: a link to the
 * apply page is the thing that gets pasted into a Telegram DM, and a trader's
 * page is the thing that gets shared as proof. Neither works if every URL
 * renders the same screen.
 *
 * # Why the hash and not the History API
 *
 * The app deploys as static files. `/apply` as a real path needs the host to
 * rewrite unknown paths to `index.html`, and when that rewrite is missing the
 * failure is a 404 on the exact link you were trying to share. The hash cannot
 * 404. The cost is an uglier URL, which is a smaller problem than a dead one.
 */

export type Route =
  | { name: "roster" }
  | { name: "trader"; leader: string }
  | { name: "apply" }
  | { name: "not-found"; path: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  const parts = path.split("/").filter(Boolean);

  if (parts.length === 0) return { name: "roster" };
  if (parts[0] === "apply") return { name: "apply" };
  if (parts[0] === "t" && parts[1]) return { name: "trader", leader: decodeURIComponent(parts[1]) };
  return { name: "not-found", path };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

/** The `href` for a path, so links stay real links and keep middle-click. */
export function href(path: string): string {
  return `#${path}`;
}

export function navigate(path: string): void {
  window.location.hash = path;
}

/**
 * Scroll to the top when the route changes.
 *
 * Without this, following a trader link from halfway down the roster lands you
 * halfway down their page, which reads as a broken link rather than a
 * preserved scroll position.
 */
export function useScrollReset(key: string): void {
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [key]);
}
