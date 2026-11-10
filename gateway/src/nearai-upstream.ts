import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Completion, PoolFetch } from "./chat.ts";
import type { SelectedPool } from "./router.ts";
import { checkAttestation, DEFAULT_JUDGE_MODEL, NEARAI_BASE, type NearAiClient } from "./tee-judge.ts";

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
  return (url, init) => {
    if (!isNearAiUrl(cfg, url)) return inner(url, init);
    if (!cfg.env.NEARAI_API_KEY) return Promise.reject(new Error("NEAR AI Cloud is not configured (NEARAI_API_KEY)"));
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    body.model = nearAiModelFor(cfg, String(body.model));
    delete body.continue_final_message;
    delete body.add_generation_prompt;
    // chat.ts builds the URL from the origin; keep the base path (e.g. /v1) of the configured endpoint.
    const target = new URL(`${nearAiBase(cfg).replace(/\/$/, "")}/chat/completions`);
    const headers = { ...(init.headers as Record<string, string>), authorization: `Bearer ${cfg.env.NEARAI_API_KEY}` };
    return f(target, { ...init, headers, body: JSON.stringify(body) });
  };
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
