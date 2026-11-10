import { useEffect, useState } from "react";

/**
 * Tiny path router (History API), so spec URLs work as-is: /chat, /account?register=…
 * - `/#how-it-works` → the landing, scrolled to that anchor.
 * - Old hash links (`#/chat`) are rewritten to `/chat` once at start-up.
 */
export type RouteName = "landing" | "chat" | "account" | "keys" | "network" | "ledger" | "payouts" | "provider" | "swarm" | "notfound";

export type Route = { name: RouteName; path: string; query: URLSearchParams };

const paths: Record<string, RouteName> = {
  "/": "landing",
  "/chat": "chat",
  "/account": "account",
  "/register-node": "account",
  "/keys": "keys",
  "/network": "network",
  "/ledger": "ledger",
  "/payouts": "payouts",
  "/swarm": "swarm",
  "/getting-started": "provider",
};

export function parseLocation(pathname: string, search: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  return { name: paths[path] ?? "notfound", path, query: new URLSearchParams(search) };
}

const EVENT = "ramx:navigate";
const current = () => parseLocation(location.pathname, location.search);

/** Push a new entry (or replace it) and tell the app. `to` may carry ?query and #anchor. */
export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = new URL(to, location.href);
  if (url.href === location.href) return;
  history[opts.replace ? "replaceState" : "pushState"](null, "", url.pathname + url.search + url.hash);
  window.dispatchEvent(new Event(EVENT));
}

/** True for links the router should handle: same origin, an app path (not a static file like /privacy.html). */
export function isAppLink(a: HTMLAnchorElement) {
  if (a.target && a.target !== "_self") return false;
  if (a.hasAttribute("download")) return false;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return false;
  const last = url.pathname.split("/").pop() ?? "";
  if (last.includes(".")) return false;
  // same-page anchors keep the browser's own smooth scroll
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return false;
  return true;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const change = () => setRoute(current());
    window.addEventListener("popstate", change);
    window.addEventListener(EVENT, change);
    return () => {
      window.removeEventListener("popstate", change);
      window.removeEventListener(EVENT, change);
    };
  }, []);
  return route;
}

/** Rewrite a legacy `#/path?q` URL to `/path?q` (links shared before the switch to paths). */
export function upgradeHashUrl() {
  if (location.hash.startsWith("#/")) history.replaceState(null, "", location.hash.slice(1));
}
