import { createHash, randomBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Completion } from "./chat.ts";
import { recordEvent, type Signer } from "./events.ts";
import { open } from "./privacy.ts";
import { countPool } from "./reliability.ts";

/**
 * Phase 6.2: TEE spot-check. A sample of served answers (TEE_JUDGE_RATE, default 10%) is judged by a
 * model running in NEAR AI Cloud's secure hardware:
 *   1. attestation report for the judge model with a FRESH nonce: both the gateway and the model
 *      attestation must echo our nonce; we keep the model's signing address + a hash of the report;
 *   2. the judge answers {verdict, reason}: does the answer plausibly respond to the prompt?
 *   3. the response signature for that chat id must recover (EIP-191) to the attested signing
 *      address; its text should be sha256(request body):sha256(response body) of OUR exact bytes.
 * Result → tee_checks row (shown on the receipt) + a signed `tee_check` ledger event. An
 * "implausible" verdict counts as a reliability failure for the pool that served the answer.
 * Wording: a plausibility check, NOT proof that the pool ran the model correctly.
 * Privacy: never sampled for x-ramx-privacy requests (they keep no transcript; trusted-all promises
 * the prompt only reaches trusted machines).
 */

export const NEARAI_BASE = "https://cloud-api.near.ai/v1";
export const DEFAULT_JUDGE_MODEL = "Qwen/Qwen3.8-27B";

export type NearAiClient = {
  attestation(model: string, nonce: string): Promise<unknown>;
  /** Exact request and response bytes are kept: the response signature covers their hashes. */
  chat(body: Record<string, unknown>): Promise<{ id: string; content: string; requestBody: string; responseBody: string }>;
  signature(chatId: string, model: string): Promise<{ text: string; signature: string; signing_address: string; signing_algo?: string }>;
};

export function nearAiClient(apiKey: string, base = NEARAI_BASE, f: typeof fetch = fetch): NearAiClient {
  const auth = { authorization: `Bearer ${apiKey}` };
  const get = async (path: string) => {
    const r = await f(`${base}${path}`, { headers: auth, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    if (!r.ok) throw new Error(`NEAR AI Cloud ${path.split("?")[0]}: HTTP ${r.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  return {
    attestation: (model, nonce) => get(`/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}&signing_algo=ecdsa`),
    async chat(body) {
      const requestBody = JSON.stringify(body);
      const r = await f(`${base}/chat/completions`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: requestBody, signal: AbortSignal.timeout(120_000) });
      const responseBody = await r.text();
      if (!r.ok) throw new Error(`NEAR AI Cloud chat: HTTP ${r.status} ${responseBody.slice(0, 200)}`);
      const j = JSON.parse(responseBody) as { id: string; choices: { message: { content: string | null } }[] };
      return { id: j.id, content: j.choices[0]?.message.content ?? "", requestBody, responseBody };
    },
    signature: (chatId, model) => get(`/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`),
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type ModelAttestation = { model_name?: string; signing_address?: string; request_nonce?: string; intel_quote?: string };
/** Check the report echoes our nonce; return the judge model's signing address and a hash of the report. */
export function checkAttestation(report: unknown, nonce: string): { signingAddress: string; sha256: string } {
  const r = report as { gateway_attestation?: { request_nonce?: string }; model_attestations?: ModelAttestation[] };
  if (r.gateway_attestation?.request_nonce !== nonce) throw new Error("gateway attestation does not carry our nonce");
  const m = (r.model_attestations ?? []).find((a) => a.request_nonce === nonce && /^0x[0-9a-fA-F]{40}$/.test(a.signing_address ?? ""));
  if (!m) throw new Error("no model attestation with our nonce and a signing address");
  if (!m.intel_quote) throw new Error("model attestation has no TDX quote");
  return { signingAddress: m.signing_address!.toLowerCase(), sha256: `0x${sha256(JSON.stringify(report))}` };
}

/**
 * #8: every TEE key a report attests with OUR nonce: the model instances and NEAR AI's own gateway
 * (which signs streamed answers). Each must echo the nonce and carry an Intel TDX quote.
 */
export function attestedKeys(report: unknown, nonce: string): { model: string[]; gateway: string | null; sha256: string } {
  const r = report as { gateway_attestation?: { request_nonce?: string; signing_address?: string; intel_quote?: string }; model_attestations?: ModelAttestation[] };
  const ok = (a?: { request_nonce?: string; signing_address?: string; intel_quote?: string }) => !!a && a.request_nonce === nonce && !!a.intel_quote && /^0x[0-9a-fA-F]{40}$/.test(a.signing_address ?? "");
  return {
    model: (r.model_attestations ?? []).filter(ok).map((m) => m.signing_address!.toLowerCase()),
    gateway: ok(r.gateway_attestation) ? r.gateway_attestation!.signing_address!.toLowerCase() : null,
    sha256: `0x${sha256(JSON.stringify(report))}`,
  };
}

export async function checkSignature(sig: { text: string; signature: string; signing_address: string }, attested: string, requestBody: string, responseBody: string): Promise<{ signatureOk: boolean; hashesMatch: boolean }> {
  let recovered = "";
  try {
    recovered = (await recoverMessageAddress({ message: sig.text, signature: sig.signature as `0x${string}` })).toLowerCase();
  } catch {
    recovered = "";
  }
  const signatureOk = recovered !== "" && recovered === sig.signing_address.toLowerCase() && recovered === attested;
  // NEAR AI signs "sha256(request):sha256(response)" for streamed answers and "<model>:sha256(request):sha256(response)" otherwise.
  const pair = `${sha256(requestBody)}:${sha256(responseBody)}`;
  return { signatureOk, hashesMatch: sig.text === pair || sig.text.endsWith(`:${pair}`) };
}

export const JUDGE_SYSTEM = "You audit an AI inference network. Given a user prompt and the answer a provider returned, decide whether the answer is a plausible, on-topic response by a competent language model (not garbage, not empty, not unrelated, not truncated nonsense). Reply with JSON only: {\"verdict\":\"plausible\"|\"implausible\",\"reason\":\"<one short sentence>\"}.";

export function parseVerdict(content: string): { verdict: "plausible" | "implausible" | "unknown"; reason: string } {
  const m = /\{[\s\S]*\}/.exec(content);
  try {
    const j = JSON.parse(m?.[0] ?? "") as { verdict?: string; reason?: string };
    if (j.verdict === "plausible" || j.verdict === "implausible") return { verdict: j.verdict, reason: String(j.reason ?? "").slice(0, 300) };
  } catch { /* fall through */ }
  return { verdict: "unknown", reason: `judge reply was not the expected JSON: ${content.slice(0, 120)}` };
}

/** Called for every completion: queue a sample of OK, non-privacy answers. */
export function sampleForJudge(db: Db, comp: Completion, rate: number, rand = Math.random()): boolean {
  if (!comp.ok || !comp.poolId || rand >= rate) return false;
  const r = db.prepare("SELECT privacy FROM requests WHERE req_id = ?").get(comp.reqId) as { privacy: string | null } | undefined;
  if (!r || r.privacy !== null) return false; // never trusted-all (or any privacy request)
  return db.prepare("INSERT OR IGNORE INTO tee_checks (req_id, pool_id, status, created_at) VALUES (?, ?, 'queued', ?)").run(comp.reqId, comp.poolId, Date.now()).changes === 1;
}

/** Judge one queued request. Returns false when nothing is queued. */
export async function judgeOnce(db: Db, cfg: Config, signer: Signer, client: NearAiClient, model = DEFAULT_JUDGE_MODEL): Promise<boolean> {
  const row = db.prepare(`SELECT c.req_id, c.pool_id, t.prompt, t.response FROM tee_checks c LEFT JOIN transcripts t ON t.req_id = c.req_id
    WHERE c.status = 'queued' ORDER BY c.created_at LIMIT 1`).get() as { req_id: string; pool_id: string; prompt: string | null; response: string | null } | undefined;
  if (!row) return false;
  const done = (fields: Record<string, unknown>) => {
    const cols = Object.keys(fields);
    db.prepare(`UPDATE tee_checks SET ${cols.map((k) => `${k} = @${k}`).join(", ")}, judged_at = @judged_at WHERE req_id = @req_id`).run({ ...fields, judged_at: Date.now(), req_id: row.req_id });
  };
  const prompt = open(cfg, row.prompt);
  const answer = open(cfg, row.response);
  if (!prompt || answer === null) {
    done({ status: "error", error: "no transcript (expired or privacy request)" });
    return true;
  }
  try {
    const nonce = randomBytes(32).toString("hex");
    const att = checkAttestation(await client.attestation(model, nonce), nonce);
    const chat = await client.chat({
      model,
      messages: [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: `PROMPT (JSON messages):\n${prompt.slice(0, 6000)}\n\nANSWER:\n${answer.slice(0, 6000)}` }],
      max_tokens: 200,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
    const v = parseVerdict(chat.content);
    const s = await checkSignature(await client.signature(chat.id, model), att.signingAddress, chat.requestBody, chat.responseBody);
    db.transaction(() => {
      done({ status: "done", judge_model: model, nonce, verdict: v.verdict, reason: v.reason, chat_id: chat.id, signing_address: att.signingAddress,
        attestation_sha256: att.sha256, signature_ok: s.signatureOk ? 1 : 0, hashes_match: s.hashesMatch ? 1 : 0, error: null });
      if (v.verdict === "implausible") countPool(db, cfg, row.pool_id, false);
      recordEvent(db, signer, { type: "tee_check", req_id: row.req_id as `req_${string}`, judge_model: model, verdict: v.verdict, signing_address: att.signingAddress, attestation_sha256: att.sha256 as `0x${string}`, signature_ok: s.signatureOk });
    })();
    console.log(JSON.stringify({ msg: "tee_check", req_id: row.req_id, pool: row.pool_id, verdict: v.verdict, signature_ok: s.signatureOk, hashes_match: s.hashesMatch }));
  } catch (e) {
    done({ status: "error", error: (e as Error).message.slice(0, 300) });
    console.warn(`tee_check ${row.req_id} failed: ${(e as Error).message}`);
  }
  return true;
}

/** Judge queued requests one by one, every `intervalMs`. Returns stop(). */
export function startTeeJudge(db: Db, cfg: Config, signer: Signer, client: NearAiClient, model?: string, intervalMs = 5000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    let more = false;
    try {
      more = await judgeOnce(db, cfg, signer, client, model);
    } catch (e) {
      console.error(`tee judge: ${(e as Error).message}`);
    }
    if (!stopped) timer = setTimeout(tick, more ? 0 : intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Receipt field: the spot-check of this request, or null when it was not sampled. */
export function teeCheckOf(db: Db, reqId: string) {
  const r = db.prepare("SELECT * FROM tee_checks WHERE req_id = ?").get(reqId) as Record<string, unknown> | undefined;
  if (!r) return null;
  const bool = (v: unknown) => (v === null || v === undefined ? null : v === 1);
  return {
    status: r.status, judge_model: r.judge_model ?? null, verdict: r.verdict ?? null, reason: r.reason ?? null, signing_address: r.signing_address ?? null,
    attestation_sha256: r.attestation_sha256 ?? null, nonce: r.nonce ?? null, chat_id: r.chat_id ?? null, signature_ok: bool(r.signature_ok),
    hashes_match: bool(r.hashes_match), error: r.error ?? null, judged_at: r.judged_at ?? null,
  };
}
