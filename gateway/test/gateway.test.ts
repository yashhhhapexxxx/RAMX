import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { ChatCompletionResponse, ErrorResponse, ModelsResponse, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb, TABLES, type Db } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import type { Completion } from "../src/chat.ts";
import { signer, testAccount, TEST_JWT_SECRET, testDirectory } from "./helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";

// ---------- fake Parallax ----------
type Seen = { body: any; closedEarly: boolean };
const seen: Seen[] = [];
let streamMode: "normal" | "slow" | "slow-then-end" | "usage-then-hang" = "normal";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => res(s));
  });
}

const fake: Server = createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "parallax" }] }));
    return;
  }
  const body = JSON.parse(await readBody(req));
  const entry: Seen = { body, closedEarly: false };
  seen.push(entry);
  res.on("close", () => { if (!res.writableFinished) entry.closedEarly = true; });
  const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
  if (!body.stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "parallax-uuid", object: "chat.completion", created: 1, model: "x",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello there" }, finish_reason: "stop" }], usage,
    }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
  const delta = (t: string) => chunk({ id: "p", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: t } }] });
  if (streamMode === "usage-then-hang") {
    res.write(delta("Hel"));
    res.write(chunk({ id: "p", object: "chat.completion.chunk", choices: [], usage }));
    return; // never sends [DONE]
  }
  if (streamMode === "slow-then-end") {
    // A real pool answer: content for a while, then usage and [DONE].
    res.write(delta("Hel"));
    let n = 0;
    const t = setInterval(() => {
      if (++n < 8) { res.write(delta(".")); return; }
      clearInterval(t);
      res.write(chunk({ id: "p", object: "chat.completion.chunk", choices: [], usage }));
      res.end("data: [DONE]\n\n");
    }, 50);
    res.on("close", () => clearInterval(t));
    return;
  }
  if (streamMode === "slow") {
    res.write(delta("Hel"));
    const t = setInterval(() => res.write(delta(".")), 50);
    res.on("close", () => clearInterval(t));
    return;
  }
  res.write(delta("Hel"));
  res.write(delta("lo"));
  res.write(chunk({ id: "p", object: "chat.completion.chunk", choices: [], usage }));
  res.end("data: [DONE]\n\n");
});

// ---------- gateway under test ----------
let gw: ServerType;
let base = "";
let db: Db;
const completions: Completion[] = [];
let auth: Record<string, string> = {};

function listen(s: { listen: (port: number, host: string, cb: () => void) => unknown; address: () => unknown }): Promise<number> {
  return new Promise((res) => s.listen(0, "127.0.0.1", () => res((s.address() as AddressInfo).port)));
}

before(async () => {
  const poolPort = await listen(fake);
  const cfg = loadConfig({ POOL_COORDINATOR_URL: `http://127.0.0.1:${poolPort}`, DATABASE_PATH: ":memory:", PORT: "0", JWT_SECRET: TEST_JWT_SECRET });
  db = openDb(":memory:");
  auth = (await testAccount(db, cfg)).auth;
  const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db), onComplete: (c) => completions.push(c) });
  await new Promise<void>((res) => {
    gw = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => { base = `http://127.0.0.1:${info.port}`; res(); });
  });
});
after(() => { gw.close(); fake.close(); db.close(); });

const post = (body: unknown, signal?: AbortSignal) =>
  fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body), signal });
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), "condition not met in time");
};

test("schema creates every SPEC §8.7 table; nullifier is UNIQUE", () => {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of TABLES) assert.ok(names.includes(t), `missing table ${t}`);
  db.prepare("INSERT INTO accounts (id, world_nullifier, created_at) VALUES ('acc_a', 'n1', 1)").run();
  assert.throws(() => db.prepare("INSERT INTO accounts (id, world_nullifier, created_at) VALUES ('acc_b', 'n1', 1)").run(), /UNIQUE/);
  db.prepare("DELETE FROM accounts WHERE id = 'acc_a'").run();
});

test("config: missing required keys fail with a clear message", () => {
  assert.throws(() => loadConfig({}), /POOL_COORDINATOR_URL[\s\S]*DATABASE_PATH/);
});

test("non-streaming: forwards with thinking off, no logprobs, req id header + body id, usage captured", async () => {
  completions.length = 0;
  const r = await post({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_completion_tokens: 64, logprobs: true });
  assert.equal(r.status, 200);
  const reqId = r.headers.get(REQUEST_ID_HEADER);
  assert.match(reqId ?? "", /^req_[A-Za-z0-9]+$/);
  const body = ChatCompletionResponse.parse(await r.json());
  assert.equal(body.id, reqId);
  const up = seen.at(-1)!.body;
  assert.deepEqual(up.chat_template_kwargs, { enable_thinking: false });
  assert.equal(up.max_tokens, 64);
  assert.equal("logprobs" in up, false);
  assert.equal("max_completion_tokens" in up, false);
  assert.equal(completions.length, 1);
  assert.deepEqual(completions[0], { reqId, model: MODEL, usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }, text: "Hello there", ok: true, poolId: "pool-router-test" });
});

test("non-streaming: client-set enable_thinking is kept; default max_tokens from config", async () => {
  await post({ model: MODEL, messages: [{ role: "user", content: "hi" }], chat_template_kwargs: { enable_thinking: true } });
  const up = seen.at(-1)!.body;
  assert.equal(up.chat_template_kwargs.enable_thinking, true);
  assert.equal(up.max_tokens, 512);
});

test("streaming: SSE passed through unchanged, include_usage forced, usage + text captured", async () => {
  completions.length = 0;
  streamMode = "normal";
  const r = await post({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
  const reqId = r.headers.get(REQUEST_ID_HEADER);
  assert.ok(reqId);
  const text = await r.text();
  assert.match(text, /"content":"Hel"/);
  assert.match(text, /data: \[DONE\]/);
  assert.deepEqual(seen.at(-1)!.body.stream_options, { include_usage: true });
  await waitFor(() => completions.length === 1);
  assert.equal(completions[0]!.ok, true);
  assert.equal(completions[0]!.text, "Hello");
  assert.equal(completions[0]!.usage?.completion_tokens, 3);
  assert.equal(completions[0]!.reqId, reqId);
});

test("streaming: client disconnect lets the pool finish (drained, not aborted), costs nothing, no penalty", async () => {
  const outcomesBefore = (db.prepare("SELECT count(*) AS n FROM node_request_outcomes").get() as { n: number }).n;
  completions.length = 0;
  streamMode = "slow-then-end";
  const ac = new AbortController();
  const r = await post({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true }, ac.signal);
  const reader = r.body!.getReader();
  await reader.read();
  ac.abort();
  const entry = seen.at(-1)!;
  await waitFor(() => completions.length === 1);
  // Parallax 162354a crashes its last stage when a running request is aborted: never close it early.
  assert.equal(entry.closedEarly, false);
  assert.equal(completions[0]!.ok, false);
  assert.equal(completions[0]!.reason, "client_aborted");
  assert.equal((db.prepare("SELECT count(*) AS n FROM node_request_outcomes").get() as { n: number }).n, outcomesBefore);
  streamMode = "normal";
});

test("streaming: a client abort AFTER the usage chunk settles normally (no free answers)", async () => {
  completions.length = 0;
  streamMode = "usage-then-hang";
  const ac = new AbortController();
  const r = await post({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true }, ac.signal);
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let got = "";
  while (!got.includes("usage")) got += dec.decode((await reader.read()).value);
  ac.abort();
  await waitFor(() => completions.length === 1);
  assert.equal(completions[0]!.ok, true);
  assert.equal(completions[0]!.usage?.completion_tokens, 3);
  const row = db.prepare("SELECT status, cost_mc FROM requests WHERE req_id = ?").get(completions[0]!.reqId) as { status: string; cost_mc: number };
  assert.equal(row.status, "ok");
  assert.ok(row.cost_mc > 0);
  streamMode = "normal";
});

test("validation failure → 400 bad_request with the shared error shape and req id", async () => {
  const r = await post({ model: MODEL, messages: [] });
  assert.equal(r.status, 400);
  assert.ok(r.headers.get(REQUEST_ID_HEADER));
  assert.equal(ErrorResponse.parse(await r.json()).error.code, "bad_request");
});

test("unknown model → 404 model_not_found; x402 max_tokens above the last tier → 400; credits are capped instead", async () => {
  const a = await post({ model: "nope/model", messages: [{ role: "user", content: "hi" }] });
  assert.equal(a.status, 404);
  assert.equal(ErrorResponse.parse(await a.json()).error.code, "model_not_found");
  const b = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 2049 }) });
  assert.equal(b.status, 400);
  assert.equal(ErrorResponse.parse(await b.json()).error.code, "bad_request");
  const capped = await post({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 32000 });
  assert.equal(capped.status, 200);
  assert.ok(Number(capped.headers.get("x-ramx-max-tokens")) <= 2048);
  assert.ok(seen.at(-1)!.body.max_tokens <= 2048);
});

test("GET /v1/models lists catalog models with fresh directory pools", async () => {
  const r = await fetch(`${base}/v1/models`);
  const body = ModelsResponse.parse(await r.json());
  assert.ok(body.data.some((m) => m.id === MODEL));
  assert.equal(body.data.find((m) => m.id === MODEL)!.model_factor, 1.75);
});

test("healthz and unknown route", async () => {
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  const r = await fetch(`${base}/nope`);
  assert.equal(r.status, 404);
  assert.equal(ErrorResponse.parse(await r.json()).error.code, "not_found");
});

test("pool down after directory lookup → 502 pool_error; discovery still follows the directory", async () => {
  // A port with nothing listening.
  const dead = createServer();
  const port = await listen(dead);
  await new Promise((r) => dead.close(r));
  const cfg = loadConfig({ POOL_COORDINATOR_URL: `http://127.0.0.1:${port}`, DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET });
  const local = openDb(":memory:");
  const failed: Completion[] = [];
  const app = createApp({ cfg, db: local, signer, directory: testDirectory(cfg, local), onComplete: (c) => failed.push(c) });
  const acc = await testAccount(local, cfg);
  const r = await app.request("/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", ...acc.auth },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 502);
  assert.ok(r.headers.get(REQUEST_ID_HEADER));
  assert.equal(ErrorResponse.parse(await r.json()).error.code, "pool_error");
  assert.equal(failed[0]!.ok, false);
  const m = ModelsResponse.parse(await (await app.request("/v1/models")).json());
  assert.ok(m.data.some((entry) => entry.id === MODEL));
  local.close();
});

test("POOL_TIMEOUT_MS bounds time to headers only: a long stream is not cut", async () => {
  streamMode = "slow";
  const cfg = loadConfig({ POOL_COORDINATOR_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, DATABASE_PATH: ":memory:", POOL_TIMEOUT_MS: "150", JWT_SECRET: TEST_JWT_SECRET });
  const local = openDb(":memory:");
  const done: Completion[] = [];
  const app = createApp({ cfg, db: local, signer, directory: testDirectory(cfg, local), onComplete: (c) => done.push(c) });
  const acc = await testAccount(local, cfg);
  const r = await app.request("/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", ...acc.auth },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  const reader = r.body!.getReader();
  const end = Date.now() + 400;
  let chunks = 0;
  while (Date.now() < end) { const { done: d } = await reader.read(); if (d) break; chunks++; }
  assert.ok(chunks > 3, `stream stopped early after ${chunks} chunks`);
  assert.equal(done.length, 0, "no completion while still streaming");
  await reader.cancel();
  // The client left: the never-ending pool stream is drained only up to the cap (POOL_TIMEOUT_MS), then aborted.
  await waitFor(() => done.length === 1);
  assert.equal(done[0]!.ok, false);
  assert.equal(done[0]!.reason, "client_aborted");
  streamMode = "normal";
  local.close();
});
