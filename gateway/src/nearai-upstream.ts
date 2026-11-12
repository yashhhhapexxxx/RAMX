import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Completion, PoolFetch } from "./chat.ts";
import type { SelectedPool } from "./router.ts";
import { attestedKeys, checkAttestation, checkSignature, DEFAULT_JUDGE_MODEL, NEARAI_BASE, type NearAiClient } from "./tee-judge.ts";
import { E2EE_HEADERS, REQUEST_ID_HEADER } from "@ramx/shared";
import { recordEvent, type Signer } from "./events.ts";

/**
 * Judge mode (Phase J). When no laptop pool is ready for a model, or the request asks for
 * `x-ramx-privacy: tee`, the gateway serves it from a model in NEAR AI Cloud's secure hardware.
 * Payment, billing, ledger events and receipts stay the same; the request has no node route, so
 * the provider share stays with the treasury / network reserve.
 *
 * Every answer served this way gets an attestation of the serving model fetched with a FRESH nonce
 * (gateway + model attestation must echo it), stored on the receipt. That proves which TEE model
 * identity was live; it does not bind this exact answer to it (the per-chat response signature is
 * a stretch goal for streamed answers).
 */

/** Pseudo pool id used for queueing, reliability and receipts. */
export const NEARAI_POOL_ID = "near-ai-cloud";

export const nearAiBase = (cfg: Config): string => cfg.env.NEARAI_BASE_URL ?? NEARAI_BASE;

/** Fallback is on when an API key is set and NEARAI_FALLBACK is not "false". */
export const nearAiFallbackOn = (cfg: Config): boolean => Boolean(cfg.env.NEARAI_API_KEY) && cfg.env.NEARAI_FALLBACK !== "false";

/** The pseudo pool the router returns for NEAR AI Cloud. */
export const nearAiPool = (cfg: Config): SelectedPool => ({ poolId: NEARAI_POOL_ID, coordinatorUrl: nearAiBase(cfg), route: null, score: 0 });

function modelMap(cfg: Config): Record<string, string> {
  if (!cfg.env.NEARAI_MODEL_MAP) return {};
  try {
    return JSON.parse(cfg.env.NEARAI_MODEL_MAP) as Record<string, string>;
  } catch {
    console.warn("NEARAI_MODEL_MAP is not valid JSON; every model uses TEE_JUDGE_MODEL");
    return {};
  }
}

/** NEAR AI Cloud model that serves one of our model ids. */
export const nearAiModelFor = (cfg: Config, modelId: string): string => modelMap(cfg)[modelId] ?? cfg.env.TEE_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;

/** True when the URL points at the configured NEAR AI Cloud endpoint. */
export const isNearAiUrl = (cfg: Config, url: URL): boolean => url.origin === new URL(nearAiBase(cfg)).origin;

/**
 * Upstream fetch for NEAR AI Cloud: adds the API key, swaps our model id for the NEAR AI model and
 * drops the pool-only continuation fields. Other URLs go to `inner` unchanged.
 */
export function nearAiFetch(cfg: Config, inner: PoolFetch, f: typeof fetch = fetch): PoolFetch {
  return async (url, init) => {
    if (!isNearAiUrl(cfg, url)) return inner(url, init);
    if (!cfg.env.NEARAI_API_KEY) throw new Error("NEAR AI Cloud is not configured (NEARAI_API_KEY)");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    body.model = nearAiModelFor(cfg, String(body.model));
    delete body.continue_final_message;
    delete body.add_generation_prompt;
    // chat.ts builds the URL from the origin; keep the base path (e.g. /v1) of the configured endpoint.
    const target = new URL(`${nearAiBase(cfg).replace(/\/$/, "")}/chat/completions`);
    const { [REQUEST_ID_HEADER]: reqId, ...rest } = (init.headers ?? {}) as Record<string, string>;
    // End-to-end encrypted requests (E2EE headers present) must reach the pinned enclave key, not an alias.
    const headers = { ...rest, authorization: `Bearer ${cfg.env.NEARAI_API_KEY}`, ...(rest[E2EE_HEADERS.clientKey] ? { "x-no-aliasing": "true" } : {}) };
    const requestBody = JSON.stringify(body);
    const res = await f(target, { ...init, headers, body: requestBody });
    if (!reqId || !res.ok || !res.body) return res;
    // #8: keep the exact request and response bytes; NEAR AI signs sha256(request):sha256(response).
    const [toClient, toCapture] = res.body.tee();
    captures.set(reqId, { requestBody, responseBody: collect(toCapture) });
    setTimeout(() => captures.delete(reqId), CAPTURE_TTL_MS).unref?.();
    return new Response(toClient, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** #8: exact bytes of the last NEAR AI exchange per request, kept briefly for the signature check. */
const CAPTURE_TTL_MS = 10 * 60_000;
const captures = new Map<string, { requestBody: string; responseBody: Promise<string> }>();

/** Every byte received, kept even if the connection is closed early (the gateway ends a stream after its last chunk). */
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // aborted after the answer: keep what arrived
  }
  return text + decoder.decode();
}

/** The NEAR AI chat id in a JSON or SSE response body (every chunk carries the same id). */
export function chatIdOf(responseBody: string): string | null {
  return /"id"\s*:\s*"([^"]+)"/.exec(responseBody)?.[1] ?? null;
}

export type TeeSignature = { chat_id: string; signing_address: string; signed_by: "model" | "nearai_gateway"; signature_ok: boolean; hashes_match: boolean };

/**
 * #8: bind THIS answer to the attested TEE key. Fetch NEAR AI's per-chat signature, check that it
 * recovers to the key attested for this request and covers our exact request and response bytes,
 * and record the result as a signed ledger event. Null when there is nothing to check.
 */
export async function signServed(db: Db, signer: Signer, client: NearAiClient, reqId: string, att: TeeAttestation, tries = 3, waitMs = 1500): Promise<TeeSignature | null> {
  const cap = captures.get(reqId);
  if (!cap) return null;
  captures.delete(reqId);
  const responseBody = await cap.responseBody;
  const chatId = chatIdOf(responseBody);
  if (!chatId) return null;
  let sig: Awaited<ReturnType<NearAiClient["signature"]>> | null = null;
  for (let i = 0; i < tries && !sig; i++) {
    try { sig = await client.signature(chatId, att.model); } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((ok) => setTimeout(ok, waitMs));
    }
  }
  let s = await checkSignature(sig!, att.signing_address, cap.requestBody, responseBody);
  let key = att.signing_address, attSha = att.attestation_sha256, signedBy: TeeSignature["signed_by"] = "model";
  // Streamed answers are signed by NEAR AI's own gateway, another TEE: attest the key that signed,
  // with a new fresh nonce, and accept it only if that report vouches for it.
  const by = sig!.signing_address.toLowerCase();
  if (!s.signatureOk && by !== att.signing_address) {
    const nonce = randomBytes(32).toString("hex");
    const keys = attestedKeys(await client.attestation(att.model, nonce), nonce);
    const kind = keys.model.includes(by) ? "model" : keys.gateway === by ? "nearai_gateway" : null;
    if (kind) {
      s = await checkSignature(sig!, by, cap.requestBody, responseBody);
      key = by; attSha = keys.sha256; signedBy = kind;
    }
  }
  const out: TeeSignature = { chat_id: chatId, signing_address: key, signed_by: signedBy, signature_ok: s.signatureOk, hashes_match: s.hashesMatch };
  recordEvent(db, signer, { type: "tee_answer_signed", req_id: reqId as `req_${string}`, model: att.model, chat_id: chatId,
    signing_address: key, signed_by: signedBy, attestation_sha256: attSha as `0x${string}`, signature_ok: s.signatureOk, hashes_match: s.hashesMatch });
  return out;
}

/** Receipt field: the signed-answer check for this request, from its ledger event, or null. */
export function teeSignatureOf(db: Db, reqId: string): TeeSignature | null {
  const row = db.prepare("SELECT payload FROM ledger_events WHERE type = 'tee_answer_signed' AND json_extract(payload, '$.req_id') = ? ORDER BY id DESC LIMIT 1").get(reqId) as { payload: string } | undefined;
  if (!row) return null;
  const p = JSON.parse(row.payload) as TeeSignature;
  return { chat_id: p.chat_id, signing_address: p.signing_address, signed_by: p.signed_by, signature_ok: p.signature_ok, hashes_match: p.hashes_match };
}

export type TeeAttestation = { model: string; nonce: string; signing_address: string; attestation_sha256: string; attested_at: number };

/** Attest the model that served an OK NEAR AI answer; stores one row per request. Returns null when not applicable. */
export async function attestServed(db: Db, cfg: Config, client: NearAiClient, comp: Completion, now = () => Date.now()): Promise<TeeAttestation | null> {
  if (!comp.ok || comp.poolId !== NEARAI_POOL_ID) return null;
  const row = db.prepare("SELECT model FROM requests WHERE req_id = ?").get(comp.reqId) as { model: string } | undefined;
  if (!row) return null;
  const model = nearAiModelFor(cfg, row.model);
  const nonce = randomBytes(32).toString("hex");
  const att = checkAttestation(await client.attestation(model, nonce), nonce);
  const out: TeeAttestation = { model, nonce, signing_address: att.signingAddress, attestation_sha256: att.sha256, attested_at: now() };
  db.prepare(`INSERT OR REPLACE INTO tee_attestations (req_id, model, nonce, signing_address, attestation_sha256, attested_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(comp.reqId, out.model, out.nonce, out.signing_address, out.attestation_sha256, out.attested_at);
  return out;
}

/** Receipt field: the attestation of the NEAR AI model that served this request, or null. */
export function teeAttestationOf(db: Db, reqId: string): TeeAttestation | null {
  return (db.prepare("SELECT model, nonce, signing_address, attestation_sha256, attested_at FROM tee_attestations WHERE req_id = ?").get(reqId) as TeeAttestation | undefined) ?? null;
}
