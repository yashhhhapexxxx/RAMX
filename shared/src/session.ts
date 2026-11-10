import { z } from "zod";
import { AccountId } from "./common.ts";

/** Claims of the session JWT (HS256, JWT_SECRET). Sent as `Authorization: Bearer <jwt>`. */
export const SessionClaims = z.object({
  iss: z.literal("ramx-gateway"),
  sub: AccountId,
  /** Seconds since epoch (JWT standard). */
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});
export type SessionClaims = z.infer<typeof SessionClaims>;
