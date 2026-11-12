import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { LedgerEvent, Receipt, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb, SCHEMA_VERSION, type Db } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { REDACTED_HEADER } from "../src/chat.ts";
import { HASH_SALT_HEADER, saltedHash } from "../src/privacy.ts";
import { luhn, redactMessages, restore, restoreSse, streamRestorer } from "../src/redact.ts";
import { chatIdOf, nearAiFetch, signServed, teeSignatureOf, type TeeAttestation } from "../src/nearai-upstream.ts";
import type { NearAiClient } from "../src/tee-judge.ts";
import { signer, testAccount, testDirectory, TEST_JWT_SECRET } from "./helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";
const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------- schema guard: the live database must never be reset by these changes ----------

test("database schema version is unchanged (a bump would reset the live database)", () => {
  assert.equal(SCHEMA_VERSION, 23);
});

// ---------- #6 redaction ----------

test("#6 redact: emails, phones, Luhn-valid cards and secrets become placeholders; the same value keeps its placeholder", () => {
  const msg = "Mail a.b@example.com or call +91 98765 43210. Card 4111 1111 1111 1111, not 4111 1111 1111 1112. Key sk-abcdefghijklmnopqrstu. Again a.b@example.com.";
  const r = redactMessages([{ role: "user", content: msg }]);
  const out = r.messages[0]!.content as string;
  assert.equal(out, "Mail [EMAIL_1] or call [PHONE_1]. Card [CARD_1], not 4111 1111 1111 1112. Key [SECRET_1]. Again [EMAIL_1].");
  assert.equal(r.map.size, 4);
  assert.equal(restore(out, r.map), msg);
});

test("#6 redact: ordinary numbers, years and prices stay; text parts and system messages are covered", () => {
  const r = redactMessages([
    { role: "system", content: "Support email: help@ramx.dev" },
    { role: "user", content: [{ type: "text", text: "In 2026 I paid 1500 for 3 laptops, order 12345." }] },
  ]);
  assert.equal(r.messages[0]!.content, "Support email: [EMAIL_1]");
  assert.deepEqual(r.messages[1]!.content, [{ type: "text", text: "In 2026 I paid 1500 for 3 laptops, order 12345." }]);
  assert.equal(luhn("4111111111111111"), true);
  assert.equal(luhn("4111111111111112"), false);
});

test("#6 restore: a placeholder split across stream chunks is restored whole", () => {
  const map = new Map([["[EMAIL_1]", "a@b.co"]]);
  const r = streamRestorer(map);
  const out = ["Write to [EMA", "IL", "_1] today [", "not a tag] and [EMAIL_1", "]. End [EMAIL"].map((c) => r.push(c)).join("") + r.flush();
  assert.equal(out, "Write to a@b.co today [not a tag] and a@b.co. End [EMAIL", "an unfinished tag at the very end is left as typed");
});

test("#6 restoreSse: deltas rewritten, held tail released before [DONE]", async () => {
  const map = new Map([["[PHONE_1]", "+91 98765 43210"]]);
  const ev = (content: string) => `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content } }] })}\n\n`;
  const src = new Response(ev("Call [PHO") + ev("NE_1] now [PHONE") + "data: [DONE]\n\n").body!;
  const text = await new Response(restoreSse(src, map)).text();
  const content = text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content).join("");
  assert.equal(content, "Call +91 98765 43210 now [PHONE");
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
});

/** A gateway whose fake pool echoes the last user message, and records what the pool received. */
async function echoGateway(env: Record<string, string> = {}) {
  const c = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET, ...env });
  const db = openDb(":memory:");
  const user = await testAccount(db, c);
  const app = createApp({ cfg: c, db, signer, directory: testDirectory(c, db, "pool-redact", true), onComplete: () => {} });
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const asked = String(body.messages.at(-1).content);
    seen.push(asked);
    const answer = `You said: ${asked}`;
    if (body.stream) {
      const chunks = [answer.slice(0, 17), answer.slice(17, 31), answer.slice(31)];
      const sse = chunks.map((t) => `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: t } }] })}\n\n`).join("")
        + `data: ${JSON.stringify({ id: "x", choices: [], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ id: "x", object: "chat.completion", created: 1, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } });
  }) as typeof fetch;
  const chat = (content: string, stream = false, privacy?: string) => app.request("/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", ...user.auth, ...(privacy ? { "x-ramx-privacy": privacy } : {}) },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content }], max_tokens: 20, stream }) });
  const receipt = async (r: Response) => Receipt.parse(await (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  return { db, seen, chat, receipt, restoreFetch: () => { globalThis.fetch = realFetch; } };
}

const PII = "email me at priya@example.com or +91 98765 43210";

test("#6 end to end: the pool sees placeholders, the client gets the real text, the receipt hash covers the real text", async () => {
  const g = await echoGateway();
  try {
    const r = await g.chat(PII);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get(REDACTED_HEADER), "2");
    const body = await r.json();
    assert.equal(g.seen[0], "email me at [EMAIL_1] or [PHONE_1]");
    assert.equal(body.choices[0].message.content, `You said: ${PII}`);
    const rc = await g.receipt(r);
    assert.equal(rc.resp_hash, saltedHash(r.headers.get(HASH_SALT_HEADER)!, `You said: ${PII}`));
  } finally { g.restoreFetch(); }
});

test("#6 end to end, streaming: placeholders split across chunks reach the client restored", async () => {
  const g = await echoGateway();
  try {
    const r = await g.chat(PII, true);
    const text = await r.text();
    const content = text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? "").join("");
    assert.equal(g.seen[0], "email me at [EMAIL_1] or [PHONE_1]");
    assert.equal(content, `You said: ${PII}`);
    assert.ok(!text.includes("[EMAIL_1]") && !text.includes("[PHONE_1]"));
  } finally { g.restoreFetch(); }
});

test("#6 can be turned off, and a prompt without personal data is sent unchanged", async () => {
  const off = await echoGateway({ PII_REDACTION: "false" });
  try {
    const r = await off.chat(PII);
    assert.equal(r.headers.get(REDACTED_HEADER), null);
    assert.equal(off.seen[0], PII);
  } finally { off.restoreFetch(); }
  const on = await echoGateway();
  try {
    const r = await on.chat("hello there");
    assert.equal(r.headers.get(REDACTED_HEADER), null);
    assert.equal(on.seen[0], "hello there");
  } finally { on.restoreFetch(); }
});

// ---------- #7 privacy mode in the signed event ----------

const settledEvents = (db: Db) => (db.prepare("SELECT payload FROM ledger_events WHERE type = 'request_settled' ORDER BY id").all() as { payload: string }[]).map((r) => JSON.parse(r.payload));

test("#7 the request event carries no privacy field for a normal request, and stays a valid signed event", async () => {
  const g = await echoGateway();
  try {
    await (await g.chat("hello")).text();
    const [ev] = settledEvents(g.db);
    assert.equal(ev.privacy, undefined);
    assert.ok(LedgerEvent.safeParse(ev).success);
  } finally { g.restoreFetch(); }
});

test("#7 schema: privacy is optional and limited to the three modes", () => {
  const base = { v: 1, ts: 1, sig: `0x${"ab".repeat(64)}`, type: "x402_payment", req_id: "req_abc", payer: "agent-1.testnet", tx_id: "11111111111111111111111111111111111111111111", amount_units: "2000", asset: "usdc.testnet", model: MODEL, in_tokens: 1, out_tokens: 1, route: null, pay: "x402", prompt_hash: `0x${"1".repeat(64)}`, resp_hash: `0x${"2".repeat(64)}` };
  assert.ok(LedgerEvent.safeParse(base).success, "old events without the field stay valid");
  assert.ok(LedgerEvent.safeParse({ ...base, privacy: "tee" }).success);
  assert.ok(!LedgerEvent.safeParse({ ...base, privacy: "public" }).success);
});

// ---------- #8 answer signature ----------

const tee = privateKeyToAccount(`0x${"5".repeat(64)}`);
const att = (address = tee.address.toLowerCase()): TeeAttestation => ({ model: "Qwen/Qwen3.8-27B", nonce: "n", signing_address: address, attestation_sha256: `0x${"3".repeat(64)}`, attested_at: 1 });

async function captured(reqId: string, sse: string): Promise<{ requestBody: string }> {
  const c = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET, NEARAI_API_KEY: "k-not-real" });
  let requestBody = "";
  const f = nearAiFetch(c, async () => new Response("{}"), (async (_u: unknown, init?: RequestInit) => { requestBody = String(init?.body); return new Response(sse); }) as typeof fetch);
  const res = await f(new URL("/v1/chat/completions", "https://cloud-api.near.ai"), { method: "POST", headers: { [REQUEST_ID_HEADER]: reqId, "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [] }) });
  assert.equal(await res.text(), sse, "the client still gets the full answer");
  return { requestBody };
}

function client(text: (req: string, resp: string) => string, by = tee, gatewayKey?: string): NearAiClient & { req?: string; resp?: string } {
  const c: NearAiClient & { req?: string; resp?: string } = {
    attestation: async (_m, nonce) => ({ gateway_attestation: { request_nonce: nonce, signing_address: gatewayKey ?? `0x${"9".repeat(40)}`, intel_quote: "q" }, model_attestations: [{ request_nonce: nonce, signing_address: tee.address, intel_quote: "q" }] }),
    chat: async () => { throw new Error("unused"); },
    signature: async () => { const t = text(c.req!, c.resp!); return { text: t, signature: await by.signMessage({ message: t }), signing_address: by.address, signing_algo: "ecdsa" }; },
  };
  return c;
}

test("#8 a TEE answer signed over our exact bytes: valid, recorded as a signed event, shown on the receipt", async () => {
  const db = openDb(":memory:");
  const sse = `data: {"id":"chatcmpl-42","choices":[{"delta":{"content":"noted."}}]}\n\ndata: [DONE]\n\n`;
  assert.equal(chatIdOf(sse), "chatcmpl-42");
  const { requestBody } = await captured("req_sig1", sse);
  const c = client(() => `${sha(requestBody)}:${sha(sse)}`);
  const s = await signServed(db, signer, c, "req_sig1", att());
  assert.deepEqual(s, { chat_id: "chatcmpl-42", signing_address: tee.address.toLowerCase(), signed_by: "model", signature_ok: true, hashes_match: true });
  const row = db.prepare("SELECT payload FROM ledger_events WHERE type = 'tee_answer_signed'").get() as { payload: string };
  assert.ok(LedgerEvent.safeParse(JSON.parse(row.payload)).success);
  assert.deepEqual(teeSignatureOf(db, "req_sig1"), s);
  assert.equal(teeSignatureOf(db, "req_other"), null);
});

test("#8 a signature by another key, or over other bytes, is recorded as NOT valid", async () => {
  const db = openDb(":memory:");
  const sse = `data: {"id":"chatcmpl-7","choices":[]}\n\n`;
  const { requestBody } = await captured("req_sig2", sse);
  const forged = await signServed(db, signer, client(() => `${sha(requestBody)}:${sha(sse)}`, privateKeyToAccount(`0x${"6".repeat(64)}`)), "req_sig2", att());
  assert.equal(forged!.signature_ok, false);
  await captured("req_sig3", sse);
  const other = await signServed(db, signer, client(() => `${sha("x")}:${sha("y")}`), "req_sig3", att());
  assert.equal(other!.signature_ok, true);
  assert.equal(other!.hashes_match, false);
  assert.equal(await signServed(db, signer, client(() => ""), "req_never_captured", att()), null);
});

test("#8 NEAR AI's non-streamed layout \"<model>:sha(request):sha(response)\" also matches", async () => {
  const db = openDb(":memory:");
  const json = `{"id":"chatcmpl-9","choices":[{"message":{"content":"noted."}}]}`;
  const { requestBody } = await captured("req_sig4", json);
  const s = await signServed(db, signer, client(() => `Qwen/Qwen3.8-27B:${sha(requestBody)}:${sha(json)}`), "req_sig4", att());
  assert.deepEqual([s!.signature_ok, s!.hashes_match], [true, true]);
});

test("#8 streamed answers signed by NEAR AI's own gateway: accepted only when a fresh report attests that key", async () => {
  const nearGw = privateKeyToAccount(`0x${"7".repeat(64)}`);
  const sse = `data: {"id":"chatcmpl-s","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n`;
  const db = openDb(":memory:");
  const { requestBody } = await captured("req_gw1", sse);
  const ok = await signServed(db, signer, client(() => `${sha(requestBody)}:${sha(sse)}`, nearGw, nearGw.address), "req_gw1", att());
  assert.deepEqual(ok, { chat_id: "chatcmpl-s", signing_address: nearGw.address.toLowerCase(), signed_by: "nearai_gateway", signature_ok: true, hashes_match: true });
  await captured("req_gw2", sse);
  const notAttested = await signServed(db, signer, client(() => `${sha(requestBody)}:${sha(sse)}`, nearGw), "req_gw2", att());
  assert.equal(notAttested!.signature_ok, false, "a key no report vouches for is not trusted");
});
