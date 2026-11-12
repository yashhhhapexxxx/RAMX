import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Brand } from "./Shared";
import { BRAND } from "../config/brand";
import GooeyNav from "./GooeyNav";
import { Icon } from "./Icon";
import { Spinner } from "./console/Status";
import type { IconName } from "./Icon";
import { navigate } from "../lib/router";
import type { RouteName } from "../lib/router";
import { env } from "../config/env";
import { useFallbacks } from "../hooks/usePool";
import { useSession } from "../auth/context";
import { available, liveStarter, STARTER_CREDITS } from "../lib/credits";
import { fmtNum } from "../lib/format";

/** Primary jobs. Account pages (credits, earnings, payouts, API access) live in the account menu. */
const nav: { names: RouteName[]; to: string; label: string; icon: IconName }[] = [
  { names: ["chat"], to: "/chat", label: "Playground", icon: "chat" },
  { names: ["provider"], to: "/getting-started", label: "Contribute", icon: "laptop" },
  { names: ["network", "ledger"], to: "/network", label: "Network", icon: "pod" },
  { names: ["swarm"], to: "/swarm", label: "Market", icon: "coins" },
];

const accountLinks: { to: string; label: string; icon: IconName }[] = [
  { to: "/account", label: "Credits & earnings", icon: "user-check" },
  { to: "/payouts", label: "Payouts", icon: "coins" },
  { to: "/keys", label: "API access", icon: "key" },
];

/** Header: credit balance + account menu when logged in, otherwise two logins: NEAR wallet and World ID (credits). */
function SessionButton() {
  const s = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (s.loading) return <span className="session-chip" aria-busy="true"><Spinner size={12} /></span>;
  if (!s.me)
    return (
      <div className="login-choices">
        <button className="button console-cta" onClick={() => s.openLogin(null, "near")} title="Log in with a NEAR testnet wallet. No starter credits: top up with USDC.">
          <Icon name="wallet" size={14} /> Connect wallet
        </button>
        <button className="button button-blue console-cta" onClick={() => s.openLogin(null, "world")} title={`World ID gives ${fmtNum(STARTER_CREDITS)} free starter credits, once per human.`}>
          <Icon name="user-check" size={14} /> Log in with World ID
          <span className="credits-tag">{fmtNum(STARTER_CREDITS / 1000)}k free credits</span>
        </button>
      </div>
    );
  const b = s.me.balance;
  return (
    <div className="session-menu" ref={ref}>
      <button className="session-chip" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)} title="Your credits">
        <i className="status-dot" />
        <span>{fmtNum(available(b), 0)} cr</span>
      </button>
      {open && (
        <div className="session-pop" role="menu">
          <span className="mono-label">Account</span>
          <span className="mono faint">{s.me.account_id}</span>
          <span className="muted">
            {fmtNum(liveStarter(b), 1)} starter · {fmtNum(b.earned, 1)} earned
          </span>
          {accountLinks.map((l) => (
            <button
              key={l.to}
              className="text-link session-link"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate(l.to);
              }}
            >
              <Icon name={l.icon} size={14} /> {l.label}
            </button>
          ))}
          <button
            className="text-link"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              s.logout();
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export default function ConsoleShell({
  current,
  children,
  wallet,
}: {
  current: RouteName;
  children: ReactNode;
  wallet?: ReactNode;
}) {
  const fallbacks = useFallbacks();
  const active = nav.findIndex((item) => item.names.includes(current));
  return (
    <div className="console">
      <header className="console-header">
        <Brand label={BRAND.consoleLabel} />
        <GooeyNav
          className={`console-nav${active < 0 ? " no-active" : ""}`}
          ariaLabel="Console navigation"
          items={nav.map((item) => ({
            label: item.label,
            href: item.to,
            icon: <Icon name={item.icon} size={15} />,
          }))}
          activeIndex={active}
          size="sm"
        />
        <div className="console-actions">
          {env.dataMode === "live" && fallbacks.length > 0 && (
            <span className="badge badge-mock" role="status" title={`The live backend did not answer, so these use demo data: ${fallbacks.join(", ")}`}>
              mock fallback
            </span>
          )}
          {env.dataMode === "mock" && (
            <span className="badge badge-mock" title="Seeded demo data. Set VITE_DATA_MODE=live for the real gateway.">
              mock data
            </span>
          )}
          {wallet}
          <SessionButton />
        </div>
      </header>
      <main className="console-main" id="console-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

export function PageHead({
  label,
  title,
  sub,
  aside,
}: {
  label: string;
  title: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <span className="mono-label">
          <span className="tiny-cross">+</span> {label}
        </span>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {aside && <div className="page-head-aside">{aside}</div>}
    </div>
  );
}
