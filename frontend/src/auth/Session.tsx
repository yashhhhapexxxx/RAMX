/* Login session (spec §6.2): the gateway returns a JWT after /auth/world/verify.
   The token lives in sessionStorage (per tab, gone when the tab closes).
   The data layer is imported lazily so the landing page stays light. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Me } from "@shared/types";
import { Ctx } from "./context";
import type { SessionState } from "./context";

const KEY = "ramx.session.v1";
const readToken = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const writeToken = (t: string | null) => {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the session lasts until reload */
  }
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(readToken);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(() => !!readToken());
  const [error, setError] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [next, setNext] = useState<string | null>(null);

  const logout = useCallback(() => {
    writeToken(null);
    setToken(null);
    setMe(null);
  }, []);

  const reload = useCallback(() => {
    const t = readToken();
    if (!t) return Promise.resolve();
    return import("../data")
      .then(({ api, SessionExpired }) =>
        api.me(t).then(
          (m) => {
            setMe(m);
            setError(null);
          },
          (e: Error) => {
            if (e instanceof SessionExpired) logout();
            else setError(e.message);
          },
        ),
      )
      .finally(() => setLoading(false));
  }, [logout]);

  // Check a stored token once on start; later reloads are explicit.
  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<SessionState>(
    () => ({
      token,
      me,
      loading,
      error,
      login(r) {
        writeToken(r.token);
        setToken(r.token);
        setMe(r.me);
        setError(null);
        setLoading(false);
      },
      logout,
      reload,
      loginOpen,
      next,
      openLogin(n = null) {
        setNext(n);
        setLoginOpen(true);
      },
      closeLogin() {
        setLoginOpen(false);
      },
    }),
    [token, me, loading, error, logout, reload, loginOpen, next],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
