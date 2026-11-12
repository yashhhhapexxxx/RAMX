import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson, E2EE_HEADERS } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";

/**
 * Privacy (SPEC §16.1 "Privacy", §5.6). No Parallax change: everything is in the gateway.
 *
 * 1. Routing modes (request header `x-ramx-privacy`):
 *    - `trusted-ends`: the first and last layers run on the requester's own nodes or TRUSTED_ACCOUNTS.
 *    - `trusted-all`:  EVERY layer runs on such nodes, so no untrusted machine sees any data.
 *    - `tee`:          served by a NEAR AI Cloud model in secure hardware (no laptop sees the prompt);
 *                      the receipt carries that model's attestation (nearai-upstream.ts). Needs NEARAI_API_KEY.
 *    A privacy request also stores no transcript (only hashes).
 * 2. Salted hashes: prompt_hash / resp_hash = sha256("<salt>:<data>") with a random 16-byte salt per
 *    request. The public ledger ledger cannot be searched for short prompts ("hi", "yes"). The requester
 *    gets the salt in the response header `x-ramx-hash-salt` and can check the receipt.
 * 3. Transcripts at rest: AES-256-GCM with TRANSCRIPT_KEY (64 hex chars). Stored as
 *    "enc:v1:<iv>:<tag>:<ciphertext>" (base64). Without the key: plain text (MVP) and a warning.
 * 4. HTTPS: TLS_CERT_FILE + TLS_KEY_FILE make the gateway serve HTTPS (main.ts).
 */

export const PRIVACY_HEADER = "x-ramx-privacy";
export const HASH_SALT_HEADER = "x-ramx-hash-salt";
export const PRIVACY_MODES = ["trusted-ends", "trusted-all", "tee"] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export const isPrivacyMode = (v: string): v is PrivacyMode => (PRIVACY_MODES as readonly string[]).includes(v);

/** Accounts trusted for a privacy request: the requester (if any) + TRUSTED_ACCOUNTS. */
export function trustedAccounts(cfg: Config, accountId: string | null): Set<string> {
  return new Set([...(accountId ? [accountId] : []), ...(cfg.env.TRUSTED_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
}

// ---------- salted hashes ----------

export const newSalt = (): string => randomBytes(16).toString("hex");
export const saltedHash = (salt: string, data: string): `0x${string}` => `0x${createHash("sha256").update(`${salt}:${data}`, "utf8").digest("hex")}`;
export const promptHashOf = (salt: string, messages: unknown): `0x${string}` => saltedHash(salt, canonicalJson(messages));

// ---------- transcripts at rest ----------

const PREFIX = "enc:v1:";
let warned = false;

function key(cfg: Config): Buffer | null {
  const k = cfg.env.TRANSCRIPT_KEY;
  if (!k) {
    if (!warned) { warned = true; console.warn("TRANSCRIPT_KEY not set: transcripts are stored as plain text"); }
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error("TRANSCRIPT_KEY must be 64 hex characters (32 bytes)");
  return Buffer.from(k, "hex");
}

/** Encrypt one transcript field (null stays null). */
export function seal(cfg: Config, text: string | null): string | null {
  if (text === null) return null;
  const k = key(cfg);
  if (!k) return text;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt one transcript field. Plain text (no prefix) is returned as it is. */
export function open(cfg: Config, stored: string | null): string | null {
  if (stored === null || !stored.startsWith(PREFIX)) return stored;
  const k = key(cfg);
  if (!k) throw new Error("transcript is encrypted but TRANSCRIPT_KEY is not set");
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(":");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv!, "base64"));
  d.setAuthTag(Buffer.from(tag!, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct!, "base64")), d.final()]).toString("utf8");
}

/** The only way to read a transcript (verification, appeals): decrypted. undefined = none stored. */
export function readTranscript(db: Db, cfg: Config, reqId: string): { prompt: string; response: string | null } | undefined {
  const row = db.prepare("SELECT prompt, response FROM transcripts WHERE req_id = ?").get(reqId) as { prompt: string; response: string | null } | undefined;
  return row ? { prompt: open(cfg, row.prompt)!, response: open(cfg, row.response) } : undefined;
}

// ---------- HTTPS ----------

/** TLS key + certificate for main.ts, or null for plain HTTP (MVP). Both keys or neither. */
export function tlsOptions(cfg: Config): { key: Buffer; cert: Buffer } | null {
  const { TLS_CERT_FILE: cert, TLS_KEY_FILE: keyFile } = cfg.env;
  if (!cert && !keyFile) return null;
  if (!cert || !keyFile) throw new Error("set both TLS_CERT_FILE and TLS_KEY_FILE (or neither)");
  return { key: readFileSync(keyFile), cert: readFileSync(cert) };
}

// ---------- end-to-end encryption to the enclave ----------

/**
 * Client headers for NEAR model E2EE v2 (shared E2EE_HEADERS). Absent → null. Present → all required
 * and well formed, returned as the headers to forward to NEAR AI Cloud; malformed → { error }.
 * The gateway never decrypts: it relays ciphertext both ways.
 */
export function e2eeRequest(get: (name: string) => string | undefined): { headers: Record<string, string> } | { error: string } | null {
  const H = E2EE_HEADERS;
  const v = { algo: get(H.algo), clientKey: get(H.clientKey), modelKey: get(H.modelKey), version: get(H.version), allFields: get(H.allFields) };
  if (!v.clientKey && !v.modelKey && !v.version && !v.algo) return null;
  if (v.algo !== "ed25519") return { error: `${H.algo} must be ed25519` };
  if (v.version !== "2") return { error: `${H.version} must be 2` };
  if (!/^[0-9a-f]{64}$/i.test(v.clientKey ?? "")) return { error: `${H.clientKey} must be a 32-byte Ed25519 public key in hex` };
  if (!/^[0-9a-f]{64}$/i.test(v.modelKey ?? "")) return { error: `${H.modelKey} must be the enclave's 32-byte Ed25519 public key in hex (from its attestation report)` };
  if (v.allFields !== undefined && v.allFields !== "true") return { error: `${H.allFields} must be true when present` };
  return { headers: { [H.algo]: "ed25519", [H.version]: "2", [H.clientKey]: v.clientKey!.toLowerCase(), [H.modelKey]: v.modelKey!.toLowerCase(), ...(v.allFields ? { [H.allFields]: "true" } : {}) } };
}
