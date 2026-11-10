import { Suspense, lazy, useEffect, useLayoutEffect } from "react";
import Landing from "./pages/Landing";
import { Cursor } from "./components/Shared";
import { BRAND } from "./config/brand";
import { SessionProvider } from "./auth/Session";
import { useSession } from "./auth/context";
import { isAppLink, navigate, useRoute } from "./lib/router";
import type { RouteName } from "./lib/router";
import "./App.css";

const ConsoleRoot = lazy(() => import("./ConsoleRoot"));
const LoginSheet = lazy(() => import("./auth/LoginSheet"));

const titles: Record<RouteName, string> = {
  landing: `${BRAND.name}: Spare GPUs, one bigger model.`,
  chat: "Playground",
  account: "Credits & earnings",
  keys: "API access",
  network: "Network",
  ledger: "Network activity",
  payouts: "Payouts",
  swarm: "Capacity market",
  provider: "Contribute",
  notfound: "Not found",
};

function Shell() {
  const route = useRoute();
  const session = useSession();
  const isLanding = route.name === "landing";

  // Same-origin app links go through the router instead of a full page load.
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element).closest("a");
      if (!a || !a.href || !isAppLink(a)) return;
      e.preventDefault();
      const url = new URL(a.href);
      navigate(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", click);
    return () => document.removeEventListener("click", click);
  }, []);

  useLayoutEffect(() => {
    // New page: jump to the top, or to the anchor (/#how-it-works), without the global smooth-scroll delay.
    const id = location.hash.slice(1);
    const target = id ? document.getElementById(id) : null;
    if (target) target.scrollIntoView({ behavior: "instant" });
    else window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [route.path]);

  useEffect(() => {
    document.title = isLanding ? titles.landing : `${titles[route.name]} · ${BRAND.name}`;
  }, [route.name, isLanding]);

  return (
    <>
      <a
        className="skip-link"
        href={isLanding ? "#platform" : "#console-main"}
        onClick={
          isLanding
            ? undefined
            : (event) => {
                event.preventDefault();
                document.getElementById("console-main")?.focus();
              }
        }
      >
        Skip to content
      </a>
      {isLanding ? (
        <Landing />
      ) : (
        <Suspense fallback={<div className="console-loading" aria-busy="true" />}>
          <ConsoleRoot route={route} />
        </Suspense>
      )}
      {session.loginOpen && (
        <Suspense fallback={null}>
          <LoginSheet />
        </Suspense>
      )}
      <Cursor />
    </>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
