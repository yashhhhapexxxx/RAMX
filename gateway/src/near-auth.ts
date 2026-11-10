import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { PublicKey } from "@near-js/crypto";
import { NearNonceResponse, NearVerifyRequest, NearVerifyResponse } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { issueToken } from "./auth.ts";
import { errorResponse } from "./errors.ts";
import { recordEvent, type Signer } from "./events.ts";
import { newAccountId } from "./accounts.ts";
import { nearProvider } from "./near.ts";

/**
 * NEAR wallet login (NEP-413 signMessage).
 *   POST /auth/near/nonce  → {message, nonce, recipient}: the wallet signs exactly these.
 *   POST /auth/near/verify → checks the ed25519 signature over the NEP-413 payload, that the
 *                            nonce is ours, unused and fresh, and (on RPC) that the public key is a
 *                            FULL-ACCESS key of the account. Then logs in / creates the account.
 * A NEAR-only account gets NO starter credits (they need a World proof); its payout account
 * defaults to the logged-in NEAR account.
 */

export const NEAR_LOGIN_MESSAGE = "Log in to RAMX";
export const NEAR_LOGIN_RECIPIENT = "ramx";
const NONCE_TTL_MS = 5 * 60_000;
/** NEP-413 tag: 2^31 + 413, u32 little-endian, prepended to the borsh payload before hashing. */
const NEP413_TAG = 2 ** 31 + 413;

/** "FullAccess" / "FunctionCall" / null (no such key). Injected in tests. */
export type NearKeyLookup = (accountId: string, publicKey: string) => Promise<"FullAccess" | "FunctionCall" | null>;

export const rpcKeyLookup = (rpcUrl?: string): NearKeyLookup => {
  const provider = nearProvider(rpcUrl);
  return async (account, pk) => {
    try {
      const k = await provider.viewAccessKey(account, pk, { finality: "final" });
      return k.permission === "FullAccess" ? "FullAccess" : "FunctionCall";
    } catch (e) {
      if (/does not exist|UNKNOWN_ACCESS_KEY|doesn't exist|UNKNOWN_ACCOUNT/i.test((e as Error).message)) return null;
      throw e;
    }
  };
};

const borshString = (s: string): Buffer => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

/** sha256(tag ‖ borsh({message, nonce[32], recipient, callbackUrl: None})): what the wallet signs. */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string, callbackUrl?: string): Buffer {
  if (nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const cb = callbackUrl === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]);
  return createHash("sha256").update(Buffer.concat([tag, borshString(message), Buffer.from(nonce), borshString(recipient), cb])).digest();
}

export function verifyNep413(publicKey: string, signatureB64: string, message: string, nonce: Uint8Array, recipient: string, callbackUrl?: string): boolean {
  const sig = Buffer.from(signatureB64, "base64");
  if (sig.length !== 64) return false;
  try {
    return PublicKey.fromString(publicKey).verify(nep413Hash(message, nonce, recipient, callbackUrl), sig);
  } catch {
    return false;
  }
}

/** Find or create the account for a NEAR wallet. No starter credits here. */
export function nearLoginOrCreate(db: Db, signer: Signer, nearAccount: string, now = Date.now()): { accountId: string; newAccount: boolean } {
  return db.transaction(() => {
    const existing = db.prepare("SELECT id FROM accounts WHERE near_account = ?").get(nearAccount) as { id: string } | undefined;
    if (existing) return { accountId: existing.id, newAccount: false };
    const id = newAccountId();
    db.prepare("INSERT INTO accounts (id, world_nullifier, near_account, payout_address, created_at) VALUES (?, ?, ?, ?, ?)").run(id, `near:${nearAccount}`, nearAccount, nearAccount, now);
    db.prepare("INSERT INTO balances (account_id, starter_mc, starter_expires_at) VALUES (?, 0, NULL)").run(id);
    recordEvent(db, signer, { type: "account_created", account_id: id as `acc_${string}` }, now);
    return { accountId: id, newAccount: true };
  })();
}

export function nearNonceHandler(db: Db) {
  return (c: Context): Response => {
    const now = Date.now();
    db.prepare("DELETE FROM near_nonces WHERE expires_at < ?").run(now);
    const nonce = randomBytes(32).toString("base64");
    db.prepare("INSERT INTO near_nonces (nonce, expires_at) VALUES (?, ?)").run(nonce, now + NONCE_TTL_MS);
    return c.json(NearNonceResponse.parse({ message: NEAR_LOGIN_MESSAGE, nonce, recipient: NEAR_LOGIN_RECIPIENT, expires_at: now + NONCE_TTL_MS }));
  };
}

export function nearVerifyHandler(db: Db, cfg: Config, signer: Signer, keyLookup: NearKeyLookup) {
  return async (c: Context): Promise<Response> => {
    const body = NearVerifyRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return errorResponse(c, 400, "bad_request", body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    const { account_id, public_key, signature, nonce, callback_url } = body.data;
    const nonceBytes = Buffer.from(nonce, "base64");
    if (nonceBytes.length !== 32) return errorResponse(c, 400, "bad_request", "nonce must be 32 bytes, base64");
    // Single use: delete first, so a replay of the same signed message fails even if verification succeeds twice in parallel.
    const used = db.prepare("DELETE FROM near_nonces WHERE nonce = ? AND expires_at >= ?").run(nonce, Date.now());
    if (used.changes !== 1) return errorResponse(c, 401, "unauthorized", "unknown, used or expired nonce: ask POST /auth/near/nonce again");
    if (!verifyNep413(public_key, signature, NEAR_LOGIN_MESSAGE, nonceBytes, NEAR_LOGIN_RECIPIENT, callback_url) && !(callback_url && verifyNep413(public_key, signature, NEAR_LOGIN_MESSAGE, nonceBytes, NEAR_LOGIN_RECIPIENT))) return errorResponse(c, 401, "unauthorized", "the NEP-413 signature does not match the message, nonce and public key");
    let perm: Awaited<ReturnType<NearKeyLookup>>;
    try {
      perm = await keyLookup(account_id, public_key);
    } catch (e) {
      return errorResponse(c, 502, "internal", `NEAR RPC unreachable: ${(e as Error).message}`);
    }
    if (perm === null) return errorResponse(c, 401, "unauthorized", `${public_key} is not a key of ${account_id}`);
    if (perm !== "FullAccess") return errorResponse(c, 401, "unauthorized", `${public_key} is a function-call key of ${account_id}; log in with a full-access key`);
    const login = nearLoginOrCreate(db, signer, account_id);
    const token = await issueToken(cfg.env.JWT_SECRET!, login.accountId, cfg.net.session_ttl_s);
    return c.json(NearVerifyResponse.parse({ token, account_id: login.accountId, near_account: account_id, new_account: login.newAccount, starter_granted_mc: 0 }));
  };
}
