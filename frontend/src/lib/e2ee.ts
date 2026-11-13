/**
 * End-to-end encryption to the NEAR AI Cloud enclave, in the browser (NEAR model E2EE v2).
 *
 * 1. Attest: fetch the enclave's attestation report directly from NEAR AI Cloud (public endpoint,
 *    no API key) with our own random nonce, and accept only a candidate that echoes the nonce and
 *    carries an Intel TDX quote. Its Ed25519 key is the one we encrypt to.
 * 2. Encrypt each message to that key; the answer comes back encrypted to our key.
 * 3. Our key pair is made per tab, kept in memory only, never stored or sent (only the public half).
 *
 * Per field: X25519 ECDH (Ed25519 keys converted to X25519) → HKDF-SHA256 (no salt, info
 * "ed25519_encryption", 32 bytes) → XChaCha20-Poly1305. Wire format, hex:
 * [ephemeral X25519 public key, 32 bytes][nonce, 24 bytes][ciphertext + tag].
 * Same scheme as agent-client/src/e2ee.ts; a test checks the two interoperate.
 */
import { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { E2EE_HEADERS } from "@ramx/shared";

export const NEARAI_BASE = "https://cloud-api.near.ai/v1";
const INFO = new TextEncoder().encode("ed25519_encryption");

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(h: string): Uint8Array {
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const keyFor = (shared: Uint8Array) => hkdf(sha256, shared, undefined, INFO, 32);

/** Encrypt one text to an Ed25519 public key (hex). A fresh ephemeral key and nonce every time. */
export function encryptTo(plain: string, edPublicHex: string): string {
  const eph = x25519.utils.randomPrivateKey();
  const shared = x25519.getSharedSecret(eph, edwardsToMontgomeryPub(fromHex(edPublicHex)));
  const nonce = random(24);
  const ct = xchacha20poly1305(keyFor(shared), nonce).encrypt(new TextEncoder().encode(plain));
  return toHex(x25519.getPublicKey(eph)) + toHex(nonce) + toHex(ct);
}

/** Decrypt one field encrypted to our Ed25519 secret key. Throws if it was altered. */
export function decryptWith(cipherHex: string, edSecret: Uint8Array): string {
  const b = fromHex(cipherHex);
  if (b.length < 32 + 24 + 16) throw new Error("ciphertext too short");
  const shared = x25519.getSharedSecret(edwardsToMontgomeryPriv(edSecret), b.slice(0, 32));
  return new TextDecoder().decode(xchacha20poly1305(keyFor(shared), b.slice(32, 56)).decrypt(b.slice(56)));
}

export type ClientKey = { secret: Uint8Array; publicHex: string };

/** A fresh key pair. Kept in memory by the caller; never persisted. */
export function newClientKey(): ClientKey {
  const secret = ed25519.utils.randomPrivateKey();
  return { secret, publicHex: toHex(ed25519.getPublicKey(secret)) };
}

export type EnclaveKey = { model: string; publicKeyHex: string; nonce: string; attestedAt: number };

/** Pick the enclave key from a report: it must echo OUR nonce and carry an Intel TDX quote. */
export function enclaveKeyFrom(report: unknown, model: string, nonce: string, now = Date.now()): EnclaveKey {
  const r = report as { model_attestations?: { request_nonce?: string; signing_public_key?: string; intel_quote?: string }[] };
  const m = (r.model_attestations ?? []).find((a) => a.request_nonce === nonce && /^[0-9a-f]{64}$/i.test(a.signing_public_key ?? "") && !!a.intel_quote);
  if (!m) throw new Error("The enclave's attestation did not include our nonce and an Intel TDX quote");
  return { model, publicKeyHex: m.signing_public_key!.toLowerCase(), nonce, attestedAt: now };
}

/** Fetch and check the enclave's attestation ourselves, straight from NEAR AI Cloud. */
export async function attestEnclave(model: string, f: typeof fetch = fetch, base = NEARAI_BASE): Promise<EnclaveKey> {
  const nonce = toHex(random(32));
  const url = `${base}/attestation/report?model=${encodeURIComponent(model)}&provider=near&signing_algo=ed25519&include_tls_fingerprint=false&nonce=${nonce}`;
  const r = await f(url, { headers: { "x-no-aliasing": "true" } });
  if (!r.ok) throw new Error(`Could not fetch the enclave's attestation (HTTP ${r.status})`);
  return enclaveKeyFrom(await r.json(), model, nonce);
}

/** Headers that ask RAMX to relay an end-to-end encrypted request to this enclave key. */
export const e2eeHeaders = (client: ClientKey, enclave: EnclaveKey): Record<string, string> => ({
  [E2EE_HEADERS.algo]: "ed25519",
  [E2EE_HEADERS.version]: "2",
  [E2EE_HEADERS.clientKey]: client.publicHex,
  [E2EE_HEADERS.modelKey]: enclave.publicKeyHex,
});

/** Encrypt the content of every message, history included. */
export function encryptMessages<M extends { role: string; content: string }>(messages: M[], enclave: EnclaveKey): M[] {
  return messages.map((m) => ({ ...m, content: encryptTo(m.content, enclave.publicKeyHex) }));
}

/** Short, readable form of a key for the UI. */
export const shortKey = (hex: string): string => `${hex.slice(0, 8)}…${hex.slice(-4)}`;
