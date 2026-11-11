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
  /** The login sheet. `next` = where to go after a successful login; `method` = show only World ID
      ("world") or only the NEAR wallet ("near"); null = both. */
  loginOpen: boolean;
  next: string | null;
  method: LoginMethod | null;
  openLogin(next?: string | null, method?: LoginMethod | null): void;
  closeLogin(): void;
};

/** Which login the navbar asked for: World ID (gives starter credits) or a NEAR wallet (no credits). */
export type LoginMethod = "world" | "near";

export const Ctx = createContext<SessionState | null>(null);

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
