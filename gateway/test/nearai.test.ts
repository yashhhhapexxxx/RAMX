import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelsResponse, Receipt, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import type { Directory } from "../src/router.ts";
import { attestServed, NEARAI_POOL_ID, nearAiFetch, nearAiModelFor, teeAttestationOf } from "../src/nearai-upstream.ts";
import type { NearAiClient } from "../src/tee-judge.ts";
import { signer, testAccount, testDirectory, TEST_JWT_SECRET } from "./helpers.ts";

/** Phase J judge mode: NEAR AI Cloud serves requests when no laptop pool is ready, or on privacy "tee". */
const MODEL = "Qwen/Qwen3-14B-FP8";
const KEY = "nearai-test-key-not-real";

let fake: Server;
const seen: { headers: IncomingHttpHeaders; body: Record<string, unknown>; path: string }[] = [];
before(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: raw ? JSON.parse(raw) : {}, path: req.url ?? "" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "chatcmpl-tee", object: "chat.completion", created: 1, model: "tee-model",
        choices: [{ index: 0, message: { role: "assistant", content: "answer from the TEE model" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 6, completion_tokens: 5, total_tokens: 11 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
});
after(() => fake.close());

const base = () => `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
const noPools: Directory = { models: async () => [], pools: async () => [], nodes: async () => [], readyPools: async () => [] };

async function setup(env: Record<string, string> = {}, directory?: (cfg: ReturnType<typeof loadConfig>, db: ReturnType<typeof openDb>) => Directory) {
  seen.length = 0;
  const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:9", DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET,
    NEARAI_API_KEY: KEY, NEARAI_BASE_URL: base(), NEARAI_MODEL_MAP: JSON.stringify({ [MODEL]: "tee/mapped-model" }), ...env });
  const db = openDb(":memory:");
  const dir = directory ? directory(cfg, db) : { ...noPools, models: async () => cfg.net.models.map((m) => ({ ...m, type: "ramx.model" as const })) };
  const app = createApp({ cfg, db, signer, directory: dir, onComplete: () => {} });
  const me = await testAccount(db, cfg);
  const chat = (headers: Record<string, string> = {}) => app.request("/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", ...me.auth, ...headers },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 20 }) });
  const receipt = async (r: Response) => Receipt.parse(await (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  return { cfg, db, app, chat, receipt };
}

test("no ready pool: /v1/models lists the model as served by NEAR AI Cloud", async () => {
  const s = await setup();
  const m = ModelsResponse.parse(await (await s.app.request("/v1/models")).json());
  const row = m.data.find((d) => d.id === MODEL);
  assert.ok(row);
  assert.equal(row.source, "near-ai-cloud");
  assert.equal(row.pools, 0);
  s.db.close();
});

test("no ready pool: request is served by NEAR AI Cloud with the API key and the mapped model; receipt says so", async () => {
  const s = await setup();
  const r = await s.chat();
  assert.equal(r.status, 200);
  assert.match(JSON.stringify(await r.json()), /answer from the TEE model/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.path, "/v1/chat/completions");
  assert.equal(seen[0]!.headers.authorization, `Bearer ${KEY}`);
  assert.equal(seen[0]!.body.model, "tee/mapped-model");
  const rc = await s.receipt(r);
  assert.equal(rc.status, "ok");
  assert.equal(rc.backend, "near-ai-cloud");
  assert.equal(rc.route, null, "no laptop route: provider share stays with the reserve");
  assert.ok(rc.cost_mc! > 0, "billed like any request");
  s.db.close();
});

test("NEARAI_FALLBACK=false: no ready pool is still a 503", async () => {
  const s = await setup({ NEARAI_FALLBACK: "false" });
  const r = await s.chat();
  assert.equal(r.status, 503);
  assert.equal(seen.length, 0);
  s.db.close();
});

test("privacy tee: goes to NEAR AI Cloud even when a laptop pool is ready, and stores no transcript", async () => {
  const s = await setup({}, (cfg, db) => testDirectory(cfg, db));
  const r = await s.chat({ "x-ramx-privacy": "tee" });
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1, "the laptop pool was not called");
  const rc = await s.receipt(r);
  assert.equal(rc.privacy, "tee");
  assert.equal(rc.backend, "near-ai-cloud");
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM transcripts WHERE req_id = ?").get(rc.req_id) as { n: number }).n, 0);
  s.db.close();
});

test("privacy tee without NEARAI_API_KEY: refused with 503, never sent to a laptop pool", async () => {
  const s = await setup({ NEARAI_API_KEY: "" }, (cfg, db) => testDirectory(cfg, db));
  const r = await s.chat({ "x-ramx-privacy": "tee" });
  assert.equal(r.status, 503);
  s.db.close();
});

test("attestServed: fresh nonce, stored on the receipt; pool-served answers are not attested", async () => {
  const s = await setup();
  const r = await s.chat();
  const reqId = r.headers.get(REQUEST_ID_HEADER)!;
  let asked = "";
  const client: NearAiClient = {
    async attestation(model, nonce) {
      asked = model;
      return { gateway_attestation: { request_nonce: nonce }, model_attestations: [{ request_nonce: nonce, signing_address: `0x${"ab".repeat(20)}`, intel_quote: "quote" }] };
    },
    chat: async () => { throw new Error("not used"); },
    signature: async () => { throw new Error("not used"); },
  };
  assert.equal(await attestServed(s.db, s.cfg, client, { reqId, ok: true, poolId: "pool-x" } as never), null);
  const a = await attestServed(s.db, s.cfg, client, { reqId, ok: true, poolId: NEARAI_POOL_ID } as never);
  assert.ok(a);
  assert.equal(asked, nearAiModelFor(s.cfg, MODEL));
  assert.equal(a.nonce.length, 64);
  assert.deepEqual(teeAttestationOf(s.db, reqId), a);
  const rc = await s.receipt(r);
  assert.equal(rc.tee_attestation?.signing_address, `0x${"ab".repeat(20)}`);
  s.db.close();
});

test("nearAiFetch: other URLs go to the pool fetch unchanged, without the API key", async () => {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:9", DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET, NEARAI_API_KEY: KEY, NEARAI_BASE_URL: base() });
  let got: RequestInit | undefined;
  const f = nearAiFetch(cfg, async (_url, init) => { got = init; return new Response("{}"); });
  await f(new URL("http://127.0.0.1:3001/v1/chat/completions"), { method: "POST", headers: { "content-type": "application/json" }, body: "{\"model\":\"m\"}" });
  assert.equal((got!.headers as Record<string, string>).authorization, undefined);
  assert.equal(got!.body, "{\"model\":\"m\"}");
});
