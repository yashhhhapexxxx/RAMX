import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { LedgerEvent, Receipt } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { checkAttestation, judgeOnce, parseVerdict, sampleForJudge, type NearAiClient } from "../src/tee-judge.ts";
import { signer, testAccount, testDirectory, TEST_JWT_SECRET } from "./helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";
const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET });
// Test-only key standing in for the judge model's TEE signing key (not real).
const tee = privateKeyToAccount(`0x${"7".repeat(64)}`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Fake NEAR AI Cloud: attests `tee` with the asked nonce, judges with `verdict`, signs like the real service. */
function fakeNearAi(o: { verdict: string; wrongNonce?: boolean; forgedSig?: boolean }): NearAiClient & { last?: { req: string; resp: string } } {
  const c: NearAiClient & { last?: { req: string; resp: string } } = {
    attestation: async (model, nonce) => {
      const n = o.wrongNonce ? "00".repeat(32) : nonce;
      return { gateway_attestation: { request_nonce: n, signing_address: "0x" + "1".repeat(40) }, model_attestations: [{ model_name: model, signing_address: tee.address, request_nonce: n, intel_quote: "04000200" }] };
    },
    chat: async (body) => {
      const requestBody = JSON.stringify(body);
      const responseBody = JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: `{"verdict":"${o.verdict}","reason":"checked"}` } }] });
      c.last = { req: requestBody, resp: responseBody };
      return { id: "chatcmpl-1", content: JSON.parse(responseBody).choices[0].message.content, requestBody, responseBody };
    },
    signature: async () => {
      const text = `${sha(c.last!.req)}:${sha(c.last!.resp)}`;
      const by = o.forgedSig ? privateKeyToAccount(`0x${"8".repeat(64)}`) : tee;
      return { text, signature: await by.signMessage({ message: text }), signing_address: tee.address, signing_algo: "ecdsa" };
    },
  };
  return c;
}

const seeded = new WeakSet<Db>();
/** One served credit request with a transcript (fake pool answers `answer`). */
async function served(db: Db, answer: string): Promise<{ reqId: string }> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ id: "x", object: "chat.completion", created: 1, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })) as typeof fetch;
  try {
    const user = await testAccount(db, cfg);
    let reqId = "";
    const seed = !seeded.has(db);
    seeded.add(db);
    const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db, "pool-router-test", seed), onComplete: (comp) => { reqId = comp.reqId; assert.ok(sampleForJudge(db, comp, 1)); } });
    const r = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...user.auth }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "What is 2+2?" }], max_tokens: 20 }) });
    assert.equal(r.status, 200);
    await r.text();
    return { reqId };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const poolOutcomes = (db: Db) => (db.prepare("SELECT ok FROM pool_request_outcomes ORDER BY rowid").all() as { ok: number }[]).map((r) => r.ok);

test("a plausible answer: attested with our nonce, signature recovers to the attested key, receipt + ledger event", async () => {
  const db = openDb(":memory:");
  try {
    const { reqId } = await served(db, "2 + 2 = 4.");
    assert.equal(await judgeOnce(db, cfg, signer, fakeNearAi({ verdict: "plausible" })), true);
    const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db, "p", false) });
    const rc = Receipt.parse(await (await app.request(`/requests/${reqId}`)).json());
    assert.deepEqual([rc.tee_check?.status, rc.tee_check?.verdict, rc.tee_check?.signature_ok, rc.tee_check?.hashes_match, rc.tee_check?.signing_address],
      ["done", "plausible", true, true, tee.address.toLowerCase()]);
    const ev = (db.prepare("SELECT payload FROM ledger_events WHERE type = 'tee_check'").all() as { payload: string }[]).map((r) => LedgerEvent.parse(JSON.parse(r.payload)));
    assert.equal(ev.length, 1);
    assert.deepEqual(poolOutcomes(db), [1], "no reliability penalty");
    assert.equal(await judgeOnce(db, cfg, signer, fakeNearAi({ verdict: "plausible" })), false, "queue empty");
  } finally { db.close(); }
});

test("garbage from a pool is judged implausible and costs the pool reliability", async () => {
  const db = openDb(":memory:");
  try {
    await served(db, "zxq zxq zxq");
    await judgeOnce(db, cfg, signer, fakeNearAi({ verdict: "implausible" }));
    assert.deepEqual(poolOutcomes(db), [1, 0], "served ok, then flagged by the judge");
  } finally { db.close(); }
});

test("a stale nonce or a forged signature is caught", async () => {
  assert.throws(() => checkAttestation({ gateway_attestation: { request_nonce: "aa" }, model_attestations: [] }, "bb"), /nonce/);
  const db = openDb(":memory:");
  try {
    const a = await served(db, "4");
    await judgeOnce(db, cfg, signer, fakeNearAi({ verdict: "plausible", wrongNonce: true }));
    const row = db.prepare("SELECT status, error FROM tee_checks WHERE req_id = ?").get(a.reqId) as { status: string; error: string };
    assert.equal(row.status, "error");
    assert.match(row.error, /nonce/);
    const b = await served(db, "4");
    await judgeOnce(db, cfg, signer, fakeNearAi({ verdict: "plausible", forgedSig: true }));
    assert.equal((db.prepare("SELECT signature_ok FROM tee_checks WHERE req_id = ?").get(b.reqId) as { signature_ok: number }).signature_ok, 0);
  } finally { db.close(); }
});

test("privacy requests are never sampled; verdict parsing is strict", async () => {
  const db = openDb(":memory:");
  try {
    const { reqId } = await served(db, "4");
    db.prepare("DELETE FROM tee_checks").run();
    db.prepare("UPDATE requests SET privacy = 'trusted-all' WHERE req_id = ?").run(reqId);
    assert.equal(sampleForJudge(db, { reqId, model: MODEL, usage: null, text: "4", ok: true, poolId: "p" }, 1), false);
    db.prepare("UPDATE requests SET privacy = NULL WHERE req_id = ?").run(reqId);
    assert.equal(sampleForJudge(db, { reqId, model: MODEL, usage: null, text: "4", ok: true, poolId: "p" }, 0.1, 0.5), false, "not in the sample");
    assert.equal(sampleForJudge(db, { reqId, model: MODEL, usage: null, text: "4", ok: true, poolId: "p" }, 0.1, 0.05), true);
  } finally { db.close(); }
  assert.deepEqual(parseVerdict('```json\n{"verdict":"implausible","reason":"off topic"}\n```'), { verdict: "implausible", reason: "off topic" });
  assert.equal(parseVerdict("sure!").verdict, "unknown");
});
