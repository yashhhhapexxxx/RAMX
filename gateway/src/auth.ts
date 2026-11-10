import type { Context, MiddlewareHandler } from "hono";
import { sign, verify } from "hono/jwt";
import { SessionClaims } from "@ramx/shared";
import { errorResponse } from "./errors.ts";

/** Session JWT (SPEC §6.2): HS256 with JWT_SECRET, shared SessionClaims, lifetime session_ttl_s (24 h). */

export async function issueToken(secret: string, accountId: string, ttlSeconds: number, nowMs = Date.now()): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const claims: SessionClaims = { iss: "ramx-gateway", sub: accountId as SessionClaims["sub"], iat, exp: iat + ttlSeconds };
  return sign(SessionClaims.parse(claims), secret, "HS256");
}

/** Account ID from a valid token, or null. Throws nothing. */
export async function accountFromToken(secret: string, token: string): Promise<string | null> {
  try {
    const payload = await verify(token, secret, "HS256");
    const c = SessionClaims.safeParse(payload);
    return c.success ? c.data.sub : null;
  } catch {
    return null;
  }
}

/** "Bearer <jwt>" → the token; no header → null. */
export function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]! : "";
}

/**
 * Session check. A request WITH an Authorization header must have a valid token (else 401; it never
 * falls through to x402). Sets c.var.accountId. `required` = no header is also 401.
 */
/** SPEC §16.3 agent keys: `gpa_…` tokens resolve to the human account + agent (chat route only). */
export type AgentResolver = (token: string) => { accountId: string; agentId: string } | null;

export function session(secret: string | undefined, required: boolean, agents?: AgentResolver): MiddlewareHandler<{ Variables: { accountId: string | null; agentId: string | null } }> {
  return async (c, next) => {
    const token = bearer(c);
    c.set("agentId", null);
    if (token === null) {
      if (required) return errorResponse(c, 401, "unauthorized", "missing Authorization: Bearer <session token>");
      c.set("accountId", null);
      return next();
    }
    if (agents && token.startsWith("gpa_")) {
      const a = agents(token);
      if (!a) return errorResponse(c, 401, "unauthorized", "invalid or revoked agent key");
      c.set("accountId", a.accountId);
      c.set("agentId", a.agentId);
      return next();
    }
    if (!secret) return errorResponse(c, 500, "internal", "JWT_SECRET is not set");
    const acc = token ? await accountFromToken(secret, token) : null;
    if (!acc) return errorResponse(c, 401, "unauthorized", "invalid or expired session token");
    c.set("accountId", acc);
    return next();
  };
}
