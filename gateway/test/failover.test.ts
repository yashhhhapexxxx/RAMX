import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Receipt, REQUEST_ID_HEADER, type ChatCompletionRequest } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import type { Completion } from "../src/chat.ts";
import { continuationBody } from "../src/chat.ts";
import { createStallTracker } from "../src/stall.ts";
import { balance, signer, testAccount, TEST_JWT_SECRET, TEST_NODE, testDirectory } from "./helpers.ts";

/** Post-MVP P5.1 stall detection and P5.2 failover (docs/POST_MVP_PLAN.md). */
const MODEL = "Qwen/Qwen3-14B-FP8";

// ---------- scripted fake Parallax: one mode per incoming request ----------
type Mode = "stall-after-3" | "continue" | "hang" | "no-headers" | "normal" | "error-after-2";
let script: Mode[] = [];
const bodies: any[] = [];
let fake: Server;
const ev = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (t: string) => ev({ id: "p", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: t } }] });
const usageEv = (p: number, c: number) => ev({ id: "p", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });

before(async () => {
  fake = createServer((req, res) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      const body = JSON.parse(s);
      bodies.push(body);
      const mode = script.shift() ?? "normal";
      if (mode === "no-headers") return; // never answers at all
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "hang") { res.flushHeaders(); return; } // headers only, never a token
      if (mode === "stall-after-3") { res.write(delta("A") + delta("B") + delta("C")); return; }
      if (mode === "error-after-2") {
        res.write(delta("A") + delta("B") + ev({ error: { message: "peer lost" } }));
        res.end();
        return;
      }
      if (mode === "continue") {
        res.write(delta("D") + delta("E") + usageEv(20, 2));
        res.end("data: [DONE]\n\n");
        return;
      }
      res.write(delta("Hel") + delta("lo") + usageEv(12, 2));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
});
after(() => fake.close());

async function setup(resilience: Partial<ReturnType<typeof loadConfig>["net"]["resilience"]> = {}) {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET });
  Object.assign(cfg.net.resilience, { stall_min_ms: 200, first_token_base_ms: 300, first_token_ms_per_input_token: 0 }, resilience);
  const db = openDb(":memory:");
  const completions: Completion[] = [];
  const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db), onComplete: (c) => completions.push(c) });
  const user = await testAccount(db, cfg);
  bodies.length = 0;
  const chat = () => app.request("/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", ...user.auth },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 200 }),
  });
  const receipt = async (r: Response) => Receipt.parse(await (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  const outcomes = () => db.prepare("SELECT ok FROM node_request_outcomes WHERE node_id = ? ORDER BY id").all(TEST_NODE).map((r: any) => r.ok);
  return { cfg, db, app, user, completions, chat, receipt, outcomes };
}

/** Content chunks in the order the client received them. */
const contents = (sse: string) => [...sse.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]);

test("stall mid-stream → continuation on the next attempt: one answer, one [DONE], billed by the answering attempt", async () => {
  const s = await setup();
  script = ["stall-after-3", "continue"];
  const before = balance(s.db, s.user.accountId);
  const t0 = Date.now();
  const r = await s.chat();
  assert.equal(r.status, 200);
  const sse = await r.text();
  assert.ok(Date.now() - t0 < 2000, "stall detected well before Parallax's 30 s heartbeat timeout");
  assert.deepEqual(contents(sse), ["A", "B", "C", "D", "E"]);
  assert.match(sse, /^: failover$/m);
  assert.equal(sse.match(/data: \[DONE\]/g)?.length, 1);

  // The second attempt continues the partial answer.
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].messages.at(-1), { role: "assistant", content: "ABC" });
  assert.equal(bodies[1].continue_final_message, true);
  assert.equal(bodies[1].add_generation_prompt, false);
  assert.equal(bodies[1].max_tokens, 197);
  assert.equal(bodies[1].chat_template_kwargs.enable_thinking, false);
  assert.equal(bodies[1].logprobs, undefined);

  const rc = await s.receipt(r);
  assert.equal(rc.status, "ok");
  assert.equal(rc.in_tokens, 20);
  assert.equal(rc.out_tokens, 2);
  assert.deepEqual(rc.attempts?.map((a) => [a.outcome, a.streamed_tokens]), [["stalled", 3], ["ok", 2]]);
  // SPEC §8.1 cost of what the answering attempt processed; the hold is released.
  const after = balance(s.db, s.user.accountId);
  assert.equal(after.held_mc, 0);
  assert.equal(before.starter_mc - after.starter_mc, rc.cost_mc);
  // Failed attempt = reliability failure; answering attempt = success.
  assert.deepEqual(s.outcomes(), [0, 1]);
  const tr = s.db.prepare("SELECT response FROM transcripts WHERE req_id = ?").get(rc.req_id) as { response: string };
  assert.equal(tr.response, "ABCDE");
  assert.equal(s.completions[0]!.text, "ABCDE");
  s.db.close();
});

test("no first token in time → fresh retry from the beginning (no partial answer to continue)", async () => {
  const s = await setup();
  script = ["hang", "normal"];
  const r = await s.chat();
  const sse = await r.text();
  assert.deepEqual(contents(sse), ["Hel", "lo"]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].continue_final_message, undefined);
  assert.deepEqual(bodies[1].messages, [{ role: "user", content: "hi" }]);
  assert.equal(bodies[1].max_tokens, 200);
  const rc = await s.receipt(r);
  assert.deepEqual(rc.attempts?.map((a) => [a.outcome, a.streamed_tokens]), [["stalled", 0], ["ok", 2]]);
  s.db.close();
});

test("streaming: no response headers within the first-token limit → stalled, retried (not POOL_TIMEOUT_MS)", async () => {
  const s = await setup();
  script = ["no-headers", "normal"];
  const t0 = Date.now();
  const r = await s.chat();
  assert.equal(r.status, 200);
  assert.deepEqual(contents(await r.text()), ["Hel", "lo"]);
  assert.ok(Date.now() - t0 < 2000);
  const rc = await s.receipt(r);
  assert.deepEqual(rc.attempts?.map((a) => a.outcome), ["stalled", "ok"]);
  s.db.close();
});

test("continuation off: an error event after content ends the stream with pool_error, no retry, nothing charged", async () => {
  const s = await setup({ continuation: false });
  script = ["error-after-2"];
  const before = balance(s.db, s.user.accountId);
  const r = await s.chat();
  const sse = await r.text();
  assert.deepEqual(contents(sse), ["A", "B"]);
  assert.doesNotMatch(sse, /peer lost/, "the upstream error event is not forwarded");
  assert.match(sse, /"code":"pool_error"/);
  assert.doesNotMatch(sse, /\[DONE\]/);
  assert.equal(bodies.length, 1);
  const rc = await s.receipt(r);
  assert.equal(rc.status, "failed");
  assert.equal(rc.attempts, null);
  assert.deepEqual(balance(s.db, s.user.accountId), before);
  assert.deepEqual(s.outcomes(), [0]);
  s.db.close();
});

test("max_failovers 0: a stall ends the stream after stall_min_ms with pool_error", async () => {
  const s = await setup({ max_failovers: 0 });
  script = ["stall-after-3"];
  const t0 = Date.now();
  const r = await s.chat();
  const sse = await r.text();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 190 && elapsed < 1500, `elapsed ${elapsed} ms`);
  assert.match(sse, /stalled for 200 ms/);
  assert.equal(bodies.length, 1);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(s.completions[0]!.ok, false);
  assert.equal(s.completions[0]!.reason, "stalled");
  assert.equal((await s.receipt(r)).status, "failed");
  s.db.close();
});

test("stall limits: p95 gap × factor with a floor; first-token limit grows with the input", () => {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:" });
  const t = createStallTracker(cfg.net);
  assert.equal(t.stallMs("p"), cfg.net.resilience.stall_min_ms, "no samples → floor");
  for (let i = 0; i < 100; i++) t.gap("p", i < 95 ? 100 : 2000);
  assert.equal(t.p95("p"), 2000);
  assert.equal(t.stallMs("p"), Math.max(cfg.net.resilience.stall_min_ms, 2000 * cfg.net.resilience.stall_p95_factor));
  for (let i = 0; i < 100; i++) t.gap("q", 130);
  assert.equal(t.stallMs("q"), Math.max(cfg.net.resilience.stall_min_ms, 1300));
  const r = cfg.net.resilience;
  assert.equal(t.firstTokenMs(1000), Math.ceil(r.first_token_base_ms + r.first_token_ms_per_input_token * 1000));
});

test("continuationBody: partial answer as the final assistant message; budget = max_tokens − streamed (min 1)", () => {
  const req = { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true } as ChatCompletionRequest;
  const b = continuationBody(req, 50, "partial", 10);
  assert.deepEqual(b.messages, [{ role: "user", content: "hi" }, { role: "assistant", content: "partial" }]);
  assert.equal(b.max_tokens, 40);
  assert.equal(b.continue_final_message, true);
  assert.equal(continuationBody(req, 50, "x", 80).max_tokens, 1);
  const fresh = continuationBody(req, 50, "", 0);
  assert.equal(fresh.continue_final_message, undefined);
  assert.equal(fresh.max_tokens, 50);
});
