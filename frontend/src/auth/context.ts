import { createContext, useContext } from "react";
import type { Me } from "@shared/types";
import type { LoginResult } from "../data/api";

export type SessionState = {
  token: string | null;
  me: Me | null;
  /** True while a stored token is being checked with /me. */
  loading: boolean;
  error: string | null;
  login(r: LoginResult): void;
  logout(): void;
  reload(): Promise<void>;
  /** The World ID login sheet. `next` = where to go after a successful login. */
  loginOpen: boolean;
  next: string | null;
  openLogin(next?: string | null): void;
  closeLogin(): void;
};

export const Ctx = createContext<SessionState | null>(null);

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
