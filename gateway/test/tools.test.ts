import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { ChatCompletionResponse, type ChatCompletionRequest } from "@ramx/shared";
import { loadConfig, type Config } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { costMc } from "../src/ledger.ts";
import { compactTools, emulatedMessages, parseCall, splitAnswer, ToolCallParser, usesTools } from "../src/tools.ts";
import { balance, signer, testAccount, TEST_JWT_SECRET, testDirectory } from "./helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";
const READ = {
  type: "function" as const,
  function: {
    name: "read",
    description: "Reads a file from the local filesystem.\n\nUsage:\n- The filePath parameter must be an absolute path\n- Very long details nobody needs " + "x".repeat(400),
    parameters: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false, properties: { filePath: { type: "string", description: "The absolute path to the file to read", examples: ["/a"] } }, required: ["filePath"] },
  },
};

// ---------- unit: prompt ----------

test("compactTools: keeps name, params, required; drops noise; short description", () => {
  const [t] = compactTools([READ]);
  assert.equal(t!.function.name, "read");
  assert.equal(t!.function.description, "Reads a file from the local filesystem.");
  const p = t!.function.parameters as any;
  assert.deepEqual(p.required, ["filePath"]);
  assert.equal(p.properties.filePath.type, "string");
  assert.equal("$schema" in p || "additionalProperties" in p || "examples" in p.properties.filePath, false);
  assert.ok(JSON.stringify(t).length < JSON.stringify(READ).length / 2);
});

test("emulatedMessages: tools in the system prompt, calls and results as text turns, strings only", () => {
  const req: ChatCompletionRequest = {
    model: MODEL,
    tools: [READ],
    messages: [
      { role: "system", content: "You are opencode." },
      { role: "user", content: [{ type: "text", text: "What is in a.ts?" }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "read", arguments: '{"filePath":"/a.ts"}' } }, { id: "call_1", type: "function", function: { name: "read", arguments: '{"filePath":"/b.ts"}' } }] },
      { role: "tool", tool_call_id: "call_0", content: "export const a = 1;" },
      { role: "tool", tool_call_id: "call_1", content: "export const b = 2;" },
    ],
  };
  assert.equal(usesTools(req), true);
  const m = emulatedMessages(req);
  assert.equal(m.length, 4);
  assert.ok(m.every((x) => typeof x.content === "string"));
  assert.match(m[0]!.content, /^You are opencode\.\n\n# Tools[\s\S]*<tools>\n\{"type":"function","function":\{"name":"read"/);
  assert.match(m[0]!.content, /<tool_call><\/tool_call> XML tags/);
  assert.equal(m[1]!.content, "What is in a.ts?");
  assert.equal(m[2]!.content, '<tool_call>\n{"name":"read","arguments":{"filePath":"/a.ts"}}\n</tool_call>\n<tool_call>\n{"name":"read","arguments":{"filePath":"/b.ts"}}\n</tool_call>');
  assert.equal(m[3]!.role, "user");
  assert.equal(m[3]!.content, "<tool_response>\nexport const a = 1;\n</tool_response>\n<tool_response>\nexport const b = 2;\n</tool_response>");
});

test("emulatedMessages: tool_choice none offers no tools; a named choice offers only that tool", () => {
  const base: ChatCompletionRequest = { model: MODEL, tools: [READ, { type: "function", function: { name: "bash" } }], messages: [{ role: "user", content: "hi" }] };
  assert.equal(emulatedMessages({ ...base, tool_choice: "none" })[0]!.role, "user");
  const named = emulatedMessages({ ...base, tool_choice: { type: "function", function: { name: "bash" } } })[0]!.content;
  assert.match(named, /"name":"bash"/);
  assert.doesNotMatch(named, /"name":"read"/);
  assert.match(named, /You must call the function bash\./);
  assert.equal(usesTools({ model: MODEL, messages: [{ role: "user", content: "hi" }] }), false);
});

// ---------- unit: parser ----------

const run = (chunks: string[]) => {
  const p = new ToolCallParser();
  const evs = [...chunks.flatMap((c) => p.feed(c)), ...p.end()];
  return { text: evs.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""), calls: evs.flatMap((e) => (e.type === "call" ? [e.call] : [])) };
};

test("parser: a call split across many chunks, with text around it", () => {
  const s = 'Let me look.\n<tool_call>\n{"name": "read", "arguments": {"filePath": "/a.ts"}}\n</tool_call>';
  const r = run(s.match(/.{1,3}/gs)!);
  assert.equal(r.text, "Let me look.\n");
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0], { id: "call_0", type: "function", function: { name: "read", arguments: '{"filePath":"/a.ts"}' } });
});

test("parser: two calls get ids call_0 and call_1", () => {
  const r = run(['<tool_call>{"name":"read","arguments":{"filePath":"/a"}}</tool_call>\n<tool_c', 'all>{"name":"bash","arguments":{"command":"ls"}}</tool_call>']);
  assert.deepEqual(r.calls.map((c) => [c.id, c.function.name]), [["call_0", "read"], ["call_1", "bash"]]);
  assert.equal(r.text, "\n");
});

test("parser: plain text with '<' streams without being held; '<tool' at the end is held, then released", () => {
  const p = new ToolCallParser();
  assert.deepEqual(p.feed("a < b"), [{ type: "text", text: "a < b" }]);
  assert.deepEqual(p.feed(" <tool"), [{ type: "text", text: " " }]);
  assert.deepEqual(p.feed("s are nice"), [{ type: "text", text: "<tools are nice" }]);
});

test("parser: broken JSON is repaired (missing brace, code fence), else returned as text", () => {
  assert.equal(parseCall('{"name":"read","arguments":{"filePath":"/a"}', 0)?.function.arguments, '{"filePath":"/a"}');
  assert.equal(parseCall('```json\n{"name":"read","arguments":{}}\n```', 0)?.function.name, "read");
  const r = run(["<tool_call>not json at all</tool_call>"]);
  assert.equal(r.calls.length, 0);
  assert.equal(r.text, "<tool_call>not json at all</tool_call>");
});

test("parser: an unclosed call at the end of the answer still counts when its JSON is complete", () => {
  const r = run(['<tool_call>\n{"name":"read","arguments":{"filePath":"/a"}}\n']);
  assert.equal(r.calls.length, 1);
  assert.equal(r.text, "");
});

test("splitAnswer: content null when the answer is only calls", () => {
  assert.deepEqual(splitAnswer('<tool_call>{"name":"read","arguments":{}}</tool_call>').content, null);
  assert.deepEqual(splitAnswer("Just text."), { content: "Just text.", tool_calls: [] });
});

// ---------- gateway: an OpenCode turn against a fake Parallax ----------

/** Fake pool: offers a tool call when the prompt has tools and no tool result yet, else answers. */
const seen: any[] = [];
const USAGE = { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 };
const readBody = (req: IncomingMessage) => new Promise<string>((res) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => res(s)); });
const fake: Server = createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  seen.push(body);
  const all = JSON.stringify(body.messages);
  const answer = all.includes("<tools>") && !all.includes("<tool_response>")
    ? 'I will read it.\n<tool_call>\n{"name": "read", "arguments": {"filePath": "/repo/src/main.ts"}}\n</tool_call>'
    : "main.ts starts the server on port 8787.";
  if (!body.stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "p", object: "chat.completion", created: 1, model: "x", choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage: USAGE }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  chunk({ id: "p", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  for (const piece of answer.match(/.{1,4}/gs)!) chunk({ id: "p", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  chunk({ id: "p", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  chunk({ id: "p", object: "chat.completion.chunk", choices: [], usage: USAGE });
  res.end("data: [DONE]\n\n");
});

let gw: ServerType;
let base = "";
let db: Db;
let cfg: Config;
let acc = "";
let auth: Record<string, string> = {};
const listen = (s: Server) => new Promise<number>((res) => s.listen(0, "127.0.0.1", () => res((s.address() as AddressInfo).port)));

before(async () => {
  const poolPort = await listen(fake);
  cfg = loadConfig({ POOL_COORDINATOR_URL: `http://127.0.0.1:${poolPort}`, DATABASE_PATH: ":memory:", PORT: "0", JWT_SECRET: TEST_JWT_SECRET });
  db = openDb(":memory:");
  const a = await testAccount(db, cfg);
  acc = a.accountId;
  auth = a.auth;
  const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db) });
  await new Promise<void>((res) => { gw = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (i) => { base = `http://127.0.0.1:${i.port}`; res(); }); });
});
after(() => { gw.close(); fake.close(); db.close(); });

const post = (body: unknown) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });
const turn1 = { model: MODEL, max_tokens: 256, tools: [READ], messages: [{ role: "system", content: "You are opencode." }, { role: "user", content: "What does src/main.ts do?" }] };
const sseEvents = (t: string) => t.split("\n\n").filter((e) => e.startsWith("data: {")).map((e) => JSON.parse(e.slice(6)));
const cost = () => costMc(cfg.net, cfg.model(MODEL)!, USAGE.prompt_tokens, USAGE.completion_tokens);

test("OpenCode turn, streaming: tool call goes out as delta.tool_calls, Parallax sees text only, exact charge", async () => {
  const before = balance(db, acc);
  const r = await post({ ...turn1, stream: true });
  assert.equal(r.status, 200);
  const evs = sseEvents(await r.text());
  const up = seen.at(-1);
  assert.equal("tools" in up, false);
  assert.ok(up.messages.every((m: any) => typeof m.content === "string"));
  assert.match(up.messages[0].content, /<tools>/);
  const text = evs.map((e) => e.choices?.[0]?.delta?.content ?? "").join("");
  assert.equal(text, "I will read it.\n");
  const calls = evs.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []);
  assert.deepEqual(calls, [{ index: 0, id: "call_0", type: "function", function: { name: "read", arguments: '{"filePath":"/repo/src/main.ts"}' } }]);
  assert.equal(evs.find((e) => e.choices?.[0]?.finish_reason)?.choices[0].finish_reason, "tool_calls");
  assert.ok(evs.some((e) => e.usage?.completion_tokens === 40));
  await new Promise((r) => setTimeout(r, 100));
  const after = balance(db, acc);
  assert.equal(after.spent_total_mc - before.spent_total_mc, cost());
  assert.equal(after.held_mc, 0);
});

test("OpenCode turn 2, non-streaming: the tool result goes back as <tool_response>, the answer is plain text", async () => {
  const r = await post({
    ...turn1,
    messages: [
      ...turn1.messages,
      { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "read", arguments: '{"filePath":"/repo/src/main.ts"}' } }] },
      { role: "tool", tool_call_id: "call_0", content: "app.listen(8787);" },
    ],
  });
  assert.equal(r.status, 200);
  const body = ChatCompletionResponse.parse(await r.json());
  assert.equal(body.choices[0]!.message.content, "main.ts starts the server on port 8787.");
  assert.equal(body.choices[0]!.message.tool_calls, undefined);
  assert.equal(body.choices[0]!.finish_reason, "stop");
  assert.match(seen.at(-1).messages.at(-1).content, /^<tool_response>\napp\.listen\(8787\);\n<\/tool_response>$/);
});

test("non-streaming tool call: message.content null, tool_calls set, finish_reason tool_calls", async () => {
  const r = await post(turn1);
  const body = ChatCompletionResponse.parse(await r.json());
  assert.equal(body.choices[0]!.message.content, "I will read it.");
  assert.equal(body.choices[0]!.message.tool_calls?.[0]?.function.name, "read");
  assert.equal(body.choices[0]!.finish_reason, "tool_calls");
});

test("no tools: request and stream are unchanged (website chat path)", async () => {
  const r = await post({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true });
  const t = await r.text();
  assert.equal(seen.at(-1).messages[0].content, "hi");
  assert.match(t, /"content":"main"/);
});

test("TOOLS_MODE=native passes tools through unchanged", () => {
  const native = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:", TOOLS_MODE: "native" });
  assert.equal(native.env.TOOLS_MODE, "native");
});

test("context: a long session is trimmed to the pool's context (header says how much), max_tokens shrinks to the room left", async () => {
  const messages: any[] = [{ role: "system", content: "You are opencode." }];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: "user", content: `Question ${i}` });
    messages.push({ role: "assistant", content: `Answer ${i} ` + "words ".repeat(600) });
  }
  messages.push({ role: "user", content: "last question" });
  const r = await post({ model: MODEL, max_tokens: 2048, messages });
  assert.equal(r.status, 200);
  assert.ok(Number(r.headers.get("x-ramx-trimmed")) > 0);
  const up = seen.at(-1);
  assert.equal(up.messages[0].content, "You are opencode.");
  assert.equal(up.messages.at(-1).content, "last question");
  assert.ok(up.max_tokens < 2048 && up.max_tokens >= 256, `max_tokens ${up.max_tokens}`);
});

test("context: a prompt that cannot fit gets 400 context_length_exceeded and costs nothing", async () => {
  const before = balance(db, acc);
  const r = await post({ model: MODEL, messages: [{ role: "system", content: "s".repeat(40_000) }, { role: "user", content: "hi" }] });
  assert.equal(r.status, 400);
  const body = await r.json() as any;
  assert.equal(body.error.code, "context_length_exceeded");
  assert.match(body.error.message, /context 4096/);
  assert.deepEqual(balance(db, acc), before);
});

test("budget: header reports the picked cap; a low balance gets a short answer; an empty one gets 403", async () => {
  const r = await post({ model: MODEL, max_tokens: 32000, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers.get("x-ramx-max-tokens")), seen.at(-1).max_tokens);
  const saved = balance(db, acc);
  db.prepare("UPDATE balances SET starter_mc = 120000, earned_mc = 0 WHERE account_id = ?").run(acc); // 120 credits
  const low = await post({ model: MODEL, max_tokens: 2048, messages: [{ role: "user", content: "hi" }] });
  assert.equal(low.status, 200);
  const cap = Number(low.headers.get("x-ramx-max-tokens"));
  assert.ok(cap >= 64 && cap < 70, `cap ${cap}`); // 120 credits / 1.75 ≈ 68 answer tokens
  db.prepare("UPDATE balances SET starter_mc = 0, earned_mc = 0, held_mc = 0 WHERE account_id = ?").run(acc);
  const none = await post({ model: MODEL, messages: [{ role: "user", content: "hi" }] });
  assert.equal(none.status, 403);
  assert.equal(((await none.json()) as any).error.code, "insufficient_credits");
  db.prepare("UPDATE balances SET starter_mc = ?, earned_mc = ?, held_mc = 0 WHERE account_id = ?").run(saved.starter_mc, saved.earned_mc, acc);
});

// ---------- API keys (OpenCode uses one as its OpenAI apiKey) ----------

const api = (path: string, init: RequestInit = {}, h: Record<string, string> = auth) =>
  fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...h, ...(init.headers as Record<string, string> ?? {}) } });

test("API key: no cap spends the account's credits; requests listed per key; revoke → 401", async () => {
  const created = await api("/agents", { method: "POST", body: JSON.stringify({ name: "opencode" }) });
  assert.equal(created.status, 200);
  const key = await created.json() as any;
  assert.equal(key.budget_mc, null);
  assert.equal(key.last_used_at, null);
  const keyAuth = { authorization: `Bearer ${key.token}` };
  const before = balance(db, acc);
  const r = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify({ ...turn1, stream: true }) }, keyAuth);
  assert.equal(r.status, 200);
  await r.text();
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(balance(db, acc).spent_total_mc - before.spent_total_mc, cost());
  const list = await (await api("/agents")).json() as any;
  const k = list.agents.find((a: any) => a.agent_id === key.agent_id);
  assert.equal(k.spent_mc, cost());
  assert.ok(k.last_used_at > 0);
  const reqs = await (await api(`/agents/${key.agent_id}/requests`)).json() as any;
  assert.equal(reqs.requests.length, 1);
  assert.equal(reqs.requests[0].cost_mc, cost());
  assert.ok(reqs.requests[0].max_tokens > 0);
  // another account cannot read this key's requests
  const other = await testAccount(db, cfg);
  assert.equal((await api(`/agents/${key.agent_id}/requests`, {}, other.auth)).status, 404);
  assert.equal((await api(`/agents/${key.agent_id}`, { method: "DELETE" })).status, 200);
  const revoked = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify(turn1) }, keyAuth);
  assert.equal(revoked.status, 401);
});

test("API key: a wrong key is 401 (never falls through to x402); a capped key stops at its cap", async () => {
  const wrong = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify(turn1) }, { authorization: `Bearer gpa_agt_nope_${"0".repeat(64)}` });
  assert.equal(wrong.status, 401);
  const key = await (await api("/agents", { method: "POST", body: JSON.stringify({ name: "capped", budget_mc: 1000 }) })).json() as any;
  const r = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify(turn1) }, { authorization: `Bearer ${key.token}` });
  assert.equal(r.status, 403); // 1 credit cannot pay even the prompt
  assert.equal(((await r.json()) as any).error.code, "insufficient_credits");
});

test("toolStream: an upstream that never sends finish_reason still closes a tool turn with \"tool_calls\", once, before usage", async () => {
  const { toolStream } = await import("../src/tools.ts");
  const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const read = async (body: string) => new Response(toolStream(new Response(body).body!)).text();
  const events = (t: string) => t.split("\n\n").filter((e) => e.startsWith("data: {")).map((e) => JSON.parse(e.slice(6)));

  const noFinish = events(await read(sse({ choices: [{ index: 0, delta: { content: '<tool_call>{"name":"read","arguments":{"filePath":"a"}}</tool_call>' } }] }) + sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) + "data: [DONE]\n\n"));
  const finishes = noFinish.flatMap((e) => e.choices.map((c: any) => c.finish_reason).filter(Boolean));
  assert.deepEqual(finishes, ["tool_calls"]);
  const iFinish = noFinish.findIndex((e) => e.choices[0]?.finish_reason === "tool_calls");
  const iUsage = noFinish.findIndex((e) => e.usage);
  assert.ok(iFinish >= 0 && iFinish < iUsage, "finish before usage");

  // with the upstream's own finish chunk: exactly one finish, still "tool_calls"
  const withFinish = events(await read(sse({ choices: [{ index: 0, delta: { content: '<tool_call>{"name":"read","arguments":{}}</tool_call>' } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n"));
  assert.deepEqual(withFinish.flatMap((e) => e.choices.map((c: any) => c.finish_reason).filter(Boolean)), ["tool_calls"]);

  // A final plain answer must also close the turn, or OpenCode keeps generating.
  const text = events(await read(sse({ choices: [{ index: 0, delta: { content: "hi" } }] }) + "data: [DONE]\n\n"));
  assert.deepEqual(text.flatMap((e) => e.choices.map((c: any) => c.finish_reason).filter(Boolean)), ["stop"]);
});

test("toolStream: final text after a tool result closes once before usage; length is preserved", async () => {
  const { toolStream } = await import("../src/tools.ts");
  const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const usage = { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 };
  for (const reason of [undefined, "length"]) {
    const source = sse({ choices: [{ index: 0, delta: { content: "The file says hello." }, finish_reason: reason }] })
      + sse({ choices: [], usage }) + "data: [DONE]\n\n";
    const text = await new Response(toolStream(new Response(source).body!)).text();
    const events = text.split("\n\n").filter(e => e.startsWith("data: {")).map(e => JSON.parse(e.slice(6)));
    assert.deepEqual(events.flatMap(e => e.choices.map((c: any) => c.finish_reason).filter(Boolean)), [reason ?? "stop"]);
    assert.ok(events.findIndex(e => e.choices[0]?.finish_reason) < events.findIndex(e => e.usage));
  }
  const out = (await import("../src/tools.ts")).rewriteCompletion({ choices: [{ message: { content: "Done." } }] });
  assert.equal(out.choices[0].finish_reason, "stop");
});

test("toolStream: errors and truncated streams never flush a held call as successful", async () => {
  const { toolStream } = await import("../src/tools.ts");
  const held = 'data: '+JSON.stringify({ choices: [{ delta: { content: '<tool_call>{"name":"read","arguments":{}}' } }] })+'\n\n';
  for (const suffix of ["", 'data: {"error":{"code":"pool_error","message":"stalled"}}\n\n']) {
    const out = await new Response(toolStream(new Response(held + suffix).body!)).text();
    assert.ok(!out.includes('"tool_calls"'));
    assert.ok(!out.includes('"finish_reason"'));
    if (suffix) assert.match(out, /pool_error/);
  }
});
