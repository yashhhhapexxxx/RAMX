import type { ReactNode } from "react";
import type { NodeStatus } from "@shared/types";

const map: Record<NodeStatus, [string, string]> = {
  ready: ["pill-ok", "ready"],
  online: ["pill-ok", "online"],
  loading: ["pill-warn", "loading"],
  offline: ["pill-idle", "offline"],
};
export function StatusPill({ status }: { status: NodeStatus }) {
  const [cls, label] = map[status];
  return <span className={`pill ${cls}`}>{label}</span>;
}

/** Pool listing status (ramx.pool). */
export function PoolPill({ status }: { status: "ready" | "forming" | "offline" }) {
  const cls = status === "ready" ? "pill-ok" : status === "forming" ? "pill-warn" : "pill-bad";
  return <span className={`pill ${cls}`}>{status}</span>;
}

/** Shared loading / error / empty states for panels. */
export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}
/** Inline "working" text with a spinner, for async checks and busy buttons. */
export function Busy({ children, size }: { children: ReactNode; size?: number }) {
  return <span className="busy" role="status" aria-live="polite"><Spinner size={size} />{children}</span>;
}
export function Loading({ h = 120, label = "Loading…" }: { h?: number; label?: string }) {
  return (
    <div className="skeleton skeleton-loader" style={{ minHeight: h }} aria-busy="true" role="status">
      <Spinner size={20} />
      <span className="faint">{label}</span>
    </div>
  );
}
/**
 * Error with what failed, why, and what to do. `retrying` shows a spinner on the retry button.
 * `command` is an operator hint (e.g. how to start the gateway), shown only in development builds.
 */
export function ErrorBox({ error, retry, title, hint, command, retrying }: { error: Error; retry?: () => void; title?: string; hint?: ReactNode; command?: string; retrying?: boolean }) {
  return (
    <div className="error-box" role="alert">
      {title && <strong className="error-title">{title}</strong>}
      <p className="error-msg">{error.message}</p>
      {hint && <p className="error-hint">{hint}</p>}
      {command && import.meta.env.DEV && (
        <code className="error-cmd mono">{command}</code>
      )}
      {retry && (
        <button className="button button-ghost button-sm error-retry" onClick={retry} disabled={retrying}>
          {retrying ? <Busy size={12}>Retrying…</Busy> : "Try again"}
        </button>
      )}
    </div>
  );
}
/** Confirmation after an action worked. `onClose` shows a dismiss button. */
export function Success({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div className="success-box" role="status" aria-live="polite">
      <span className="success-dot" aria-hidden="true">✓</span>
      <span>{children}</span>
      {onClose && (
        <button className="text-link success-close" onClick={onClose} aria-label="Dismiss">
          Dismiss
        </button>
      )}
    </div>
  );
}
/** One pill for a live data source: loading, error (retrying) or live. */
export function LiveStatus({ loading, error, hasData, label = "Live" }: { loading?: boolean; error?: Error; hasData: boolean; label?: string }) {
  if (error) return <span className="pill pill-bad live-status">Can't reach backend · retrying</span>;
  if (!hasData) return <span className="pill pill-idle live-status"><Busy size={10}>Loading…</Busy></span>;
  return <span className="pill pill-ok live-status"><i className="status-dot" /> {loading ? "Refreshing…" : label}</span>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
