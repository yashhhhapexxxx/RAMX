/**
 * End-to-end encryption to the NEAR AI Cloud enclave (NEAR model E2EE v2), done on the client.
 * The enclave's Ed25519 key comes from an attestation report this client fetches itself with its own
 * nonce (no API key needed); every message is encrypted to it, and the answer comes back encrypted to
 * our own key. RAMX and everything between only ever see ciphertext.
 *
 * Per field: X25519 ECDH (Ed25519 keys converted to X25519) → HKDF-SHA256 (no salt, info
 * "ed25519_encryption", 32 bytes) → XChaCha20-Poly1305. Wire format, hex:
 * [ephemeral X25519 public key, 32 bytes][nonce, 24 bytes][ciphertext + tag].
 */
import { randomBytes } from "node:crypto";
import { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { E2EE_HEADERS } from "@ramx/shared";

const INFO = new TextEncoder().encode("ed25519_encryption");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));
const keyFor = (shared: Uint8Array) => hkdf(sha256, shared, undefined, INFO, 32);

/** Encrypt one text to an Ed25519 public key (hex). */
export function encryptTo(plain: string, edPublicHex: string): string {
  const eph = x25519.utils.randomPrivateKey();
  const shared = x25519.getSharedSecret(eph, edwardsToMontgomeryPub(unhex(edPublicHex)));
  const nonce = new Uint8Array(randomBytes(24));
  const ct = xchacha20poly1305(keyFor(shared), nonce).encrypt(new TextEncoder().encode(plain));
  return hex(x25519.getPublicKey(eph)) + hex(nonce) + hex(ct);
}

/** Decrypt one field encrypted to our Ed25519 secret key. Throws if it was tampered with. */
export function decryptWith(cipherHex: string, edSecret: Uint8Array): string {
  const b = unhex(cipherHex);
  if (b.length < 32 + 24 + 16) throw new Error("ciphertext too short");
  const shared = x25519.getSharedSecret(edwardsToMontgomeryPriv(edSecret), b.slice(0, 32));
  return new TextDecoder().decode(xchacha20poly1305(keyFor(shared), b.slice(32, 56)).decrypt(b.slice(56)));
}

/** A fresh client key pair for one session. */
export function newClientKey(): { secret: Uint8Array; publicHex: string } {
  const secret = ed25519.utils.randomPrivateKey();
  return { secret, publicHex: hex(ed25519.getPublicKey(secret)) };
}

export type EnclaveKey = { model: string; publicKeyHex: string; nonce: string; hasTdxQuote: boolean };

/** Pick the enclave key from an attestation report: it must echo OUR nonce and carry a TDX quote. */
export function enclaveKeyFrom(report: unknown, model: string, nonce: string): EnclaveKey {
  const r = report as { model_attestations?: { request_nonce?: string; signing_public_key?: string; intel_quote?: string }[] };
  const m = (r.model_attestations ?? []).find((a) => a.request_nonce === nonce && /^[0-9a-f]{64}$/i.test(a.signing_public_key ?? "") && !!a.intel_quote);
  if (!m) throw new Error("no attested enclave key with our nonce and an Intel TDX quote");
  return { model, publicKeyHex: m.signing_public_key!.toLowerCase(), nonce, hasTdxQuote: true };
}

/** Fetch and check the enclave's attestation ourselves (public endpoint, no API key). */
export async function attestEnclave(model: string, base = "https://cloud-api.near.ai/v1"): Promise<EnclaveKey> {
  const nonce = randomBytes(32).toString("hex");
  const url = `${base}/attestation/report?model=${encodeURIComponent(model)}&provider=near&signing_algo=ed25519&include_tls_fingerprint=false&nonce=${nonce}`;
  const r = await fetch(url, { headers: { "x-no-aliasing": "true" } });
  if (!r.ok) throw new Error(`attestation report: HTTP ${r.status}`);
  return enclaveKeyFrom(await r.json(), model, nonce);
}

/** Headers that ask RAMX to relay an end-to-end encrypted request to this enclave key. */
export const e2eeHeaders = (clientPublicHex: string, enclave: EnclaveKey): Record<string, string> => ({
  [E2EE_HEADERS.algo]: "ed25519",
  [E2EE_HEADERS.version]: "2",
  [E2EE_HEADERS.clientKey]: clientPublicHex,
  [E2EE_HEADERS.modelKey]: enclave.publicKeyHex,
});

/** Encrypt the content of every message (string contents only). */
export function encryptMessages(messages: { role: string; content: string }[], enclave: EnclaveKey): { role: string; content: string }[] {
  return messages.map((m) => ({ ...m, content: encryptTo(m.content, enclave.publicKeyHex) }));
}
