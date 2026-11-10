import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Context } from "hono";
import type { Signer } from "./events.ts";
import { recordEvent } from "./events.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errorResponse } from "./errors.ts";
import { open as openTranscript, readTranscript } from "./privacy.ts";
import type { Router } from "./router.ts";
import type { PoolQueue } from "./queue.ts";

type VerifyReply = { score: number; threshold: number; reference_hash: string; verdict?: "pass" | "flag" };
type Job = { id: string; req_id: string; pool_id: string; route: string; owner_accounts: string; model: string; seed: number; settings: string; verdict: string; appeal_until: number };
const digest = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;

/** P6.2 rate. New pools receive max checks. Older pools lower checks as verified history grows. */
export function sampleProbability(db: Db, cfg: Config, poolId: string): number {
  const max = Number(cfg.env.VERIFICATION_MAX_RATE ?? 0.2);
  const min = Number(cfg.env.VERIFICATION_MIN_RATE ?? 0.005);
  const checkCost = Number(cfg.env.VERIFICATION_COST_MC ?? 1);
  const stat = db.prepare(`SELECT count(*) AS n, min(a.created_at) AS first FROM requests r
    JOIN json_each(COALESCE(r.route, '[]')) h JOIN nodes n ON n.node_id = json_extract(h.value, '$.node_id')
    JOIN accounts a ON a.id = n.account_id WHERE n.pool_id = ? AND r.status = 'ok'`).get(poolId) as { n: number; first: number | null };
  if (stat.n < 500 || stat.first === null || Date.now() - stat.first < 7 * 86_400_000) return max;
  const earned = db.prepare(`SELECT coalesce(sum(b.locked_mc), 0) AS amount FROM balances b JOIN nodes n ON n.account_id = b.account_id WHERE n.pool_id = ?`).get(poolId) as { amount: number };
  const recent = db.prepare(`SELECT coalesce(avg(cost_mc), 0) AS amount FROM requests r JOIN json_each(COALESCE(r.route, '[]')) h
    JOIN nodes n ON n.node_id = json_extract(h.value, '$.node_id') WHERE n.pool_id = ? AND r.status = 'ok' AND r.ts > ?`).get(poolId, Date.now() - 86_400_000) as { amount: number };
  const p = 1.5 * checkCost / (0.9 * earned.amount + 0.8 * recent.amount);
  return Math.max(min, Math.min(max, Number.isFinite(p) ? p : max));
}

/** Queue a completed request for a trusted, separate reference verifier. Never blocks its response. */
export function maybeQueueVerification(db: Db, cfg: Config, reqId: string, now = Date.now()): string | null {
  if (!cfg.env.VERIFIER_URL || !cfg.env.VERIFIER_OWNER_ACCOUNT) return null;
  const row = db.prepare(`SELECT r.req_id, r.model, r.route, r.sampling_seed, r.sampling_settings, t.prompt, t.response
    FROM requests r JOIN transcripts t ON t.req_id = r.req_id WHERE r.req_id = ? AND r.status = 'ok'`).get(reqId) as {
      req_id: string; model: string; route: string | null; sampling_seed: number | null; sampling_settings: string | null; prompt: string; response: string | null;
    } | undefined;
  if (row) { row.prompt = openTranscript(cfg, row.prompt)!; row.response = openTranscript(cfg, row.response); } // decrypted (privacy.ts)
  if (!row?.route || row.sampling_seed === null || !row.response) return null;
  const route = JSON.parse(row.route) as { node_id: string }[];
  const pool = db.prepare("SELECT pool_id FROM nodes WHERE node_id = ?").get(route[0]?.node_id) as { pool_id: string } | undefined;
  const owners = [...new Set(route.map((hop) => (db.prepare("SELECT account_id FROM nodes WHERE node_id = ?").get(hop.node_id) as { account_id: string } | undefined)?.account_id).filter(Boolean))];
  if (!pool || owners.includes(cfg.env.VERIFIER_OWNER_ACCOUNT) || randomInt(1_000_000) >= sampleProbability(db, cfg, pool.pool_id) * 1_000_000) return null;
  const id = `ver_${now.toString(36)}${randomBytes(6).toString("hex")}`;
  db.prepare(`INSERT INTO verification_jobs (id, req_id, pool_id, route, owner_accounts, model, seed, settings, verdict, created_at, appeal_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
    .run(id, reqId, pool.pool_id, row.route, JSON.stringify(owners), row.model, row.sampling_seed, row.sampling_settings ?? "{}", now, now + Number(cfg.env.VERIFICATION_APPEAL_HOURS ?? 24) * 3_600_000);
  return id;
}

function updateGroupRisk(db: Db, routeJson: string, flagged: boolean, now: number) {
  const nodes = JSON.parse(routeJson) as { node_id: string }[];
  const ids = [...new Set(nodes.map((n) => n.node_id))];
  const prior = ids.map((id) => {
    db.prepare("INSERT OR IGNORE INTO verification_node_risk (node_id, updated_at) VALUES (?, ?)").run(id, now);
    const x = db.prepare("SELECT alpha, beta FROM verification_node_risk WHERE node_id = ?").get(id) as { alpha: number; beta: number };
    return { id, alpha: x.alpha, beta: x.beta, p: x.alpha / (x.alpha + x.beta) };
  });
  for (const n of prior) {
    const otherGood = prior.filter((x) => x.id !== n.id).reduce((acc, x) => acc * (1 - x.p), 1);
    // Noisy-OR group test posterior. Avoid certainty from one noisy observation.
    const posterior = flagged
      ? (n.p * 0.99) / Math.max(Number.EPSILON, n.p * 0.99 + (1 - n.p) * (1 - 0.99 * otherGood))
      : (n.p * 0.01) / Math.max(Number.EPSILON, n.p * 0.01 + (1 - n.p) * 0.99 * otherGood);
    const mass = n.alpha + n.beta + 1;
    const alpha = Math.min(1e6, Math.max(0.01, posterior * mass));
    const beta = Math.min(1e6, Math.max(0.01, (1 - posterior) * mass));
    db.prepare("UPDATE verification_node_risk SET alpha = ?, beta = ?, flagged = ?, updated_at = ? WHERE node_id = ?")
      .run(alpha, beta, alpha / (alpha + beta) >= 0.95 ? 1 : 0, now, n.id);
  }
}

function parseReply(raw: unknown): VerifyReply {
  if (!raw || typeof raw !== "object") throw new Error("reference verifier returned invalid JSON");
  const r = raw as Record<string, unknown>;
  if (typeof r.score !== "number" || !Number.isFinite(r.score) || r.score < 0 || typeof r.threshold !== "number" || !Number.isFinite(r.threshold) || r.threshold < 0 || typeof r.reference_hash !== "string" || !/^0x[0-9a-f]{64}$/.test(r.reference_hash)) throw new Error("reference verifier reply needs nonnegative score/threshold and reference_hash");
  return { score: r.score, threshold: r.threshold, reference_hash: r.reference_hash, verdict: r.verdict === "pass" || r.verdict === "flag" ? r.verdict : undefined };
}

async function callVerifier(url: string, body: unknown): Promise<VerifyReply> {
  const res = await fetch(new URL("/v1/verify", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`reference verifier HTTP ${res.status}`);
  return parseReply(await res.json());
}

/** Work a bounded batch. Results are immutable audit records; no money or reliability fields change. */
export async function runVerificationOnce(db: Db, cfg: Config, signer: Signer, now = Date.now(), max = 2): Promise<number> {
  const verifierUrl = cfg.env.VERIFIER_URL;
  const verifierOwner = cfg.env.VERIFIER_OWNER_ACCOUNT;
  if (!verifierUrl || !verifierOwner) return 0;
  const jobs = db.prepare("SELECT * FROM verification_jobs WHERE verdict = 'queued' ORDER BY created_at LIMIT ?").all(max) as Job[];
  let done = 0;
  for (const job of jobs) {
    try {
      if ((JSON.parse(job.owner_accounts) as string[]).includes(verifierOwner)) throw new Error("primary verifier owner is on the inference route");
      const transcript = readTranscript(db, cfg, job.req_id) as { prompt: string; response: string }; // decrypted (privacy.ts)
      const reply = await callVerifier(verifierUrl, { verification_id: job.id, req_id: job.req_id, model: job.model,
        prompt: JSON.parse(transcript.prompt), response: transcript.response, seed: job.seed, sampling: JSON.parse(job.settings), route: JSON.parse(job.route), method: "token-difr" });
      const verdict = reply.score > reply.threshold ? "flag" : "pass";
      db.transaction(() => {
        db.prepare("UPDATE verification_jobs SET score = ?, threshold = ?, verdict = ?, reference_hash = ?, verifier_owner = ?, checked_at = ? WHERE id = ? AND verdict = 'queued'")
          .run(reply.score, reply.threshold, verdict, reply.reference_hash, verifierOwner, now, job.id);
        updateGroupRisk(db, job.route, verdict === "flag", now);
        recordEvent(db, signer, { type: "verification_result", verification_id: job.id, req_id: job.req_id as `req_${string}`,
          pool_id: job.pool_id, route_hash: digest(job.route) as `0x${string}`, score: reply.score, threshold: reply.threshold, verdict }, now);
      })();
      done++;
    } catch (e) {
      console.error(`verification ${job.id} deferred: ${(e as Error).message}`);
      // A transient checker failure does not turn into a verdict. Move the job to the tail.
      db.prepare("UPDATE verification_jobs SET created_at = ? WHERE id = ? AND verdict = 'queued'").run(now + 1, job.id);
    }
  }
  return done;
}

export function startVerificationWorker(db: Db, cfg: Config, signer: Signer, intervalMs = 2_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    if (stopped) return;
    try { await runVerificationOnce(db, cfg, signer); await runAppealOnce(db, cfg, signer); finalizeExpiredAppeals(db, signer); }
    catch (e) { console.error(`verification worker failed: ${(e as Error).message}`); }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 0);
  return () => { stopped = true; clearTimeout(timer); };
}

function finalizeExpiredAppeals(db: Db, signer: Signer, now = Date.now()) {
  const rows = db.prepare("SELECT id, req_id FROM verification_jobs WHERE verdict = 'flag' AND appeal_until <= ?").all(now) as { id: string; req_id: string }[];
  for (const row of rows) db.transaction(() => {
    const changed = db.prepare("UPDATE verification_jobs SET verdict = 'final_flag', final_at = ? WHERE id = ? AND verdict = 'flag'").run(now, row.id).changes;
    if (changed) recordEvent(db, signer, { type: "verification_final", verification_id: row.id, req_id: row.req_id as `req_${string}`, verdict: "flag" }, now);
  })();
}

export function requestAppeal(db: Db, cfg: Config, signer: Signer, verificationId: string, accountId: string, reason: string, now = Date.now()): { ok: true; appeal_id: string } | { error: string; status: number } {
  const row = db.prepare("SELECT * FROM verification_jobs WHERE id = ?").get(verificationId) as Job | undefined;
  if (!row) return { error: "verification not found", status: 404 };
  if (row.verdict !== "flag" || now > row.appeal_until) return { error: "verification is not appealable", status: 409 };
  if (!(JSON.parse(row.owner_accounts) as string[]).includes(accountId)) return { error: "only an owner on the route may appeal", status: 403 };
  const id = `app_${now.toString(36)}${randomBytes(6).toString("hex")}`;
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO verification_appeals (id, verification_id, account_id, reason, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)").run(id, verificationId, accountId, reason.slice(0, 500), now);
      db.prepare("UPDATE verification_jobs SET verdict = 'appealed' WHERE id = ? AND verdict = 'flag'").run(verificationId);
      recordEvent(db, signer, { type: "verification_appeal", verification_id: verificationId, appeal_id: id, account_id: accountId as `acc_${string}` }, now);
    })();
  } catch (e) { return { error: (e as Error).message.includes("UNIQUE") ? "an appeal already exists" : "appeal could not be recorded", status: 409 }; }
  return { ok: true, appeal_id: id };
}

export async function runAppealOnce(db: Db, cfg: Config, signer: Signer, now = Date.now()): Promise<boolean> {
  if (!cfg.env.VERIFIER_SECONDARY_URL) return false;
  const appeal = db.prepare(`SELECT a.id AS appeal_id, a.account_id, a.reason, a.status AS appeal_status, j.id AS verification_id, j.req_id, j.pool_id, j.route, j.owner_accounts, j.model, j.seed, j.settings
    FROM verification_appeals a JOIN verification_jobs j ON j.id = a.verification_id WHERE a.status = 'queued' ORDER BY a.created_at LIMIT 1`).get() as (Job & { appeal_id: string; verification_id: string; account_id: string; reason: string }) | undefined;
  if (!appeal) return false;
  if (!cfg.env.VERIFIER_SECONDARY_OWNER_ACCOUNT || (JSON.parse(appeal.owner_accounts) as string[]).includes(cfg.env.VERIFIER_SECONDARY_OWNER_ACCOUNT)) throw new Error("secondary verifier must be configured with an owner outside the inference route");
  const transcript = readTranscript(db, cfg, appeal.req_id) as { prompt: string; response: string }; // decrypted (privacy.ts)
  try {
    const r = await callVerifier(cfg.env.VERIFIER_SECONDARY_URL, { verification_id: appeal.verification_id, req_id: appeal.req_id, model: appeal.model,
      prompt: JSON.parse(transcript.prompt), response: transcript.response, seed: appeal.seed, sampling: JSON.parse(appeal.settings), route: JSON.parse(appeal.route), method: "token-difr-appeal" });
    const verdict = r.score > r.threshold ? "flag" : "pass";
    db.transaction(() => {
      db.prepare("UPDATE verification_appeals SET status = 'checked', score = ?, verdict = ?, checked_at = ? WHERE id = ? AND status = 'queued'").run(r.score, verdict, now, appeal.appeal_id);
      db.prepare("UPDATE verification_jobs SET verdict = ?, score = ?, threshold = ?, reference_hash = ?, final_at = ? WHERE id = ? AND verdict = 'appealed'").run(verdict === "flag" ? "final_flag" : "final_pass", r.score, r.threshold, r.reference_hash, now, appeal.verification_id);
      updateGroupRisk(db, appeal.route, verdict === "flag", now);
      recordEvent(db, signer, { type: "verification_final", verification_id: appeal.verification_id, req_id: appeal.req_id as `req_${string}`, verdict }, now);
    })();
    return true;
  } catch (e) {
    console.error(`verification appeal ${appeal.appeal_id} deferred: ${(e as Error).message}`);
    return false;
  }
}

export function verificationForAccount(db: Db, id: string, accountId: string) {
  const row = db.prepare("SELECT * FROM verification_jobs WHERE id = ?").get(id) as (Job & { score: number | null; threshold: number | null; checked_at: number | null; final_at: number | null }) | undefined;
  if (!row) return null;
  if (!(JSON.parse(row.owner_accounts) as string[]).includes(accountId)) return false;
  const appeal = db.prepare("SELECT id, status, score, verdict, created_at, checked_at FROM verification_appeals WHERE verification_id = ?").get(id) ?? null;
  return { verification_id: row.id, req_id: row.req_id, model: row.model, verdict: row.verdict, score: row.score,
    threshold: row.threshold, checked_at: row.checked_at, appeal_until: row.appeal_until, final_at: row.final_at, appeal };
}

export function verificationAppealHandler(db: Db, cfg: Config, signer: Signer) {
  return async (c: Context) => {
    const body = await c.req.json().catch(() => null) as { reason?: unknown } | null;
    if (typeof body?.reason !== "string" || !body.reason.trim()) return errorResponse(c, 400, "bad_request", "reason is required");
    const result = requestAppeal(db, cfg, signer, String(c.req.param("id") ?? ""), c.get("accountId")!, body.reason.trim());
    if ("ok" in result) return c.json(result, 202);
    return errorResponse(c, result.status as 403 | 404 | 409, result.status === 403 ? "unauthorized" : result.status === 404 ? "not_found" : "bad_request", result.error);
  };
}

export function verificationReadHandler(db: Db) {
  return (c: Context) => {
    const result = verificationForAccount(db, String(c.req.param("id") ?? ""), c.get("accountId")!);
    if (result === null) return errorResponse(c, 404, "not_found", "verification not found");
    if (result === false) return errorResponse(c, 403, "unauthorized", "verification belongs to another account");
    return c.json(result);
  };
}

export type CapabilityChallenge = { challenge_id: string; seed: `0x${string}`; expires_at: number };
type ChallengeReply = { challenge_id: string; backend: "cuda" | "mlx" | "cpu" | "unavailable"; memory_gb: number; elapsed_ms: number; output_hash: string; result_hash: string };

/** Deterministic integer matmul checksum, independently recomputed by the gateway. */
export function expectedCapabilityOutputHash(seed: string): string {
  let state = Number(BigInt(seed) & 0xffff_ffffn);
  const matrix = () => Array.from({ length: 64 * 64 }, () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state % 31 - 15;
  });
  const a = matrix();
  const b = matrix();
  const first = Array.from({ length: 16 }, (_, idx) => {
    const row = Math.floor(idx / 64), col = idx % 64;
    let total = 0;
    for (let k = 0; k < 64; k++) total += a[row * 64 + k]! * b[k * 64 + col]!;
    return total;
  });
  return digest(JSON.stringify(first));
}

export function challengeResultHash(challengeId: string, seed: string, result: Omit<ChallengeReply, "challenge_id" | "result_hash">) {
  return digest(`${challengeId}:${seed}:${result.backend}:${result.elapsed_ms}:${result.output_hash}`);
}

export function recordChallengeReply(db: Db, cfg: Config, signer: Signer, nodeId: string, reply: ChallengeReply, now = Date.now()) {
  const row = db.prepare("SELECT * FROM node_challenges WHERE challenge_id = ? AND node_id = ? AND status = 'issued'").get(reply.challenge_id, nodeId) as { nonce: string; expires_at: number } | undefined;
  if (!row) return false;
  const gpu = db.prepare("SELECT gpu, mem_gb FROM nodes WHERE node_id = ?").get(nodeId) as { gpu: string; mem_gb: number } | undefined;
  const expectedBackend = /nvidia|geforce|rtx|cuda/i.test(gpu?.gpu ?? "") ? "cuda" : /apple|m[1-9]/i.test(gpu?.gpu ?? "") ? "mlx" : "cpu";
  const hash = challengeResultHash(reply.challenge_id, row.nonce, reply);
  const passed = now <= row.expires_at && reply.result_hash === hash && reply.backend === expectedBackend
    && reply.output_hash === expectedCapabilityOutputHash(row.nonce)
    && reply.memory_gb >= (gpu?.mem_gb ?? Infinity) * 0.8 && reply.elapsed_ms > 0 && reply.elapsed_ms <= 60_000;
  db.transaction(() => {
    db.prepare("UPDATE node_challenges SET status = ?, returned_at = ?, result_hash = ?, elapsed_ms = ? WHERE challenge_id = ? AND status = 'issued'")
      .run(passed ? "passed" : "failed", now, reply.result_hash, reply.elapsed_ms, reply.challenge_id);
    db.prepare("UPDATE nodes SET hb_hw_verified = ? WHERE node_id = ?").run(passed ? 1 : 0, nodeId);
    recordEvent(db, signer, { type: "hardware_challenge", challenge_id: reply.challenge_id, node_id: nodeId as `0x${string}`,
      result: passed ? "passed" : "failed", backend: reply.backend, memory_gb: reply.memory_gb, elapsed_ms: reply.elapsed_ms }, now);
  })();
  return passed;
}

export function challengeForHeartbeat(db: Db, signer: Signer, nodeId: string, poolId: string, idle: boolean, intervalSeconds: number, now = Date.now()): CapabilityChallenge | null {
  const current = db.prepare("SELECT challenge_id, nonce, expires_at FROM node_challenges WHERE node_id = ? AND status = 'issued' ORDER BY issued_at DESC LIMIT 1").get(nodeId) as { challenge_id: string; nonce: string; expires_at: number } | undefined;
  if (current && current.expires_at > now) return { challenge_id: current.challenge_id, seed: current.nonce as `0x${string}`, expires_at: current.expires_at };
  if (current) {
    db.transaction(() => {
      db.prepare("UPDATE node_challenges SET status = 'expired' WHERE challenge_id = ? AND status = 'issued'").run(current.challenge_id);
      db.prepare("UPDATE nodes SET hb_hw_verified = 0 WHERE node_id = ?").run(nodeId);
      recordEvent(db, signer, { type: "hardware_challenge", challenge_id: current.challenge_id, node_id: nodeId as `0x${string}`,
        result: "expired", backend: null, memory_gb: null, elapsed_ms: null }, now);
    })();
    return null;
  }
  const previous = db.prepare("SELECT max(issued_at) AS at FROM node_challenges WHERE node_id = ?").get(nodeId) as { at: number | null };
  if (!idle || (previous.at !== null && (now - previous.at < 3_600_000 || randomInt(3_600) >= intervalSeconds))) return null;
  const id = `hw_${now.toString(36)}${randomBytes(6).toString("hex")}`;
  const seed = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const expires = now + 120_000;
  db.prepare("INSERT INTO node_challenges (challenge_id, node_id, nonce, expires_at, status, issued_at) VALUES (?, ?, ?, ?, 'issued', ?)").run(id, nodeId, seed, expires, now);
  return { challenge_id: id, seed, expires_at: expires };
}

/** Idle-only fixed prompt checks. These are internal, unpaid requests to the private Parallax API. */
export async function runCanaryOnce(db: Db, cfg: Config, signer: Signer, router: Router, queue: PoolQueue, modelId: string, now = Date.now()): Promise<boolean> {
  if (!cfg.env.VERIFIER_URL || !cfg.env.VERIFIER_OWNER_ACCOUNT) return false;
  const model = cfg.model(modelId);
  if (!model) throw new Error(`unknown canary model ${modelId}`);
  let selected = await router.select(model);
  if (!selected?.route || !queue.isIdle(selected.poolId)) return false;
  const poolId = selected.poolId;
  const owners = [...new Set(selected.route.map((h) => (db.prepare("SELECT account_id FROM nodes WHERE node_id = ?").get(h.node_id) as { account_id: string } | undefined)?.account_id).filter(Boolean))];
  if (owners.includes(cfg.env.VERIFIER_OWNER_ACCOUNT)) return false;
  const abort = new AbortController();
  const release = await queue.acquire(poolId, 1, abort.signal);
  const stopRoute = router.start(poolId);
  const canaryId = `can_${now.toString(36)}${randomBytes(6).toString("hex")}`;
  const prompt = [{ role: "user", content: "Reply with exactly the word READY." }];
  try {
    const fresh = await router.select(model, selected.poolId);
    if (!fresh?.route) return false;
    const response = await fetch(new URL("/v1/chat/completions", selected.coordinatorUrl), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: model.model_id, messages: prompt, temperature: 0, top_p: 1, seed: 0, max_tokens: 8,
        chat_template_kwargs: { enable_thinking: false } }), signal: AbortSignal.timeout(cfg.env.POOL_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`canary pool returned HTTP ${response.status}`);
    const result = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    const answer = result.choices?.[0]?.message?.content;
    if (typeof answer !== "string") throw new Error("canary response has no text");
    const routeJson = JSON.stringify(fresh.route);
    const reply = await callVerifier(cfg.env.VERIFIER_URL, { verification_id: canaryId, model: model.model_id, prompt,
      response: answer, seed: 0, sampling: { temperature: 0, top_p: 1 }, route: fresh.route, method: "token-difr-canary" });
    const verdict = reply.score > reply.threshold ? "flag" : "pass";
    db.transaction(() => {
      db.prepare("INSERT INTO verification_canaries (id,pool_id,model,route_hash,score,threshold,verdict,ts) VALUES (?,?,?,?,?,?,?,?)")
        .run(canaryId, poolId, model.model_id, digest(routeJson), reply.score, reply.threshold, verdict, now);
      updateGroupRisk(db, routeJson, verdict === "flag", now);
      recordEvent(db, signer, { type: "verification_canary", canary_id: canaryId, pool_id: poolId, model: model.model_id,
        route_hash: digest(routeJson) as `0x${string}`, score: reply.score, threshold: reply.threshold, verdict }, now);
    })();
    return true;
  } finally {
    stopRoute();
    release();
  }
}

export function startCanaryWorker(db: Db, cfg: Config, signer: Signer, router: Router, queue: PoolQueue, intervalMs = 3_600_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    if (stopped) return;
    if (cfg.env.VERIFIER_URL && cfg.env.VERIFIER_OWNER_ACCOUNT) {
      for (const model of cfg.net.models) {
        try { await runCanaryOnce(db, cfg, signer, router, queue, model.model_id); }
        catch (e) { console.error(`canary for ${model.model_id} deferred: ${(e as Error).message}`); }
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, Math.min(intervalMs, 60_000));
  return () => { stopped = true; clearTimeout(timer); };
}

