/** Actual OpenCode -> real gateway -> fixture inference -> local read -> final answer.
 * No live pool, credentials or chain writes. Run: pnpm e2e:opencode [opencode command...]
 * The fixture deliberately omits finish_reason, as some upstream streams do.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { signer, testAccount, testDirectory, TEST_JWT_SECRET } from "../test/helpers.ts";

// macOS /var and /tmp are symlinks; use the same canonical path for cwd and tools.
const root = realpathSync(mkdtempSync(join(tmpdir(), "ramx-opencode-e2e-")));
const phrase = `RAMX-LIVE-${randomBytes(6).toString("hex").toUpperCase()}`;
const model = "Qwen/Qwen3-14B-FP8";
writeFileSync(join(root, "fixture.txt"), `The verification phrase is ${phrase}.\n`);
const requests: { messages: unknown[]; tools?: unknown }[] = [];
const backend = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  requests.push(input);
  if (requests.length > 2) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Unexpected extra turn: final finish_reason is missing" } }));
    return;
  }
  const messages = JSON.stringify(input.messages);
  const answer = messages.includes("<tool_response>")
    ? messages.match(/RAMX-LIVE-[A-F0-9]+/)?.[0] ?? "No successful file read"
    : `<tool_call>${JSON.stringify({ name: "read", arguments: { filePath: join(root, "fixture.txt") } })}</tool_call>`;
  const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(event({ id: "fixture", object: "chat.completion.chunk", created: 0, model,
    choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })
    + event({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }) + "data: [DONE]\n\n");
});
await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
const cfg = loadConfig({ DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET,
  POOL_COORDINATOR_URL: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, TOOLS_MODE: "emulate" });
const db = openDb(":memory:");
const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db), onComplete: () => {} });
const account = await testAccount(db, cfg);
const key = await (await app.request("/agents", { method: "POST", headers: { authorization: `Bearer ${account.token}`,
  "content-type": "application/json" }, body: JSON.stringify({ name: "opencode-regression" }) })).json() as { token: string };
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
const command = process.argv.slice(2);
if (!command.length) command.push("opencode");
writeFileSync(join(root, "opencode.json"), JSON.stringify({
  model: `ramx/${model}`, enabled_providers: ["ramx"],
  permission: { edit: "ask", bash: "ask", external_directory: "deny" },
  compaction: { auto: false },
  provider: { ramx: { npm: "@ai-sdk/openai-compatible", options: {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: "{env:RAMX_API_KEY}" },
    models: { [model]: { name: "Fixture inference", limit: { context: 4096, output: 128 } } } } },
}));
const child = spawn(command[0]!, [...command.slice(1), "run", "--pure", "--format", "json", "--agent", "build",
  "--title", "RAMX tool regression", "Read fixture.txt using your read tool and tell me its verification phrase."], {
  cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RAMX_API_KEY: key.token,
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state") },
});
let output = "";
child.stdout!.on("data", chunk => { output += chunk; });
child.stderr!.on("data", chunk => { output += chunk; });
const stop = () => { if (child.pid && child.exitCode === null && child.signalCode === null) {
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* child already exited */ }
} };
const timer = setTimeout(stop, 45_000);
try {
  const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  assert.equal(code, 0, output.replaceAll(key.token, "[REDACTED]").slice(-3000));
  const events = output.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const tools = events.filter(e => e.type === "tool_use");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].part.state.status, "completed", tools[0].part.state.error ?? "the read must succeed, not merely emit a tool event");
  assert.equal(requests.length, 2, "one tool turn, one final answer; no unknown-finish loop");
  assert.ok(requests.every(r => !r.tools), "Parallax receives emulated text, not native tools");
  assert.ok(JSON.stringify(requests[1]).includes(`<tool_response>`));
  assert.ok(JSON.stringify(requests[1]).includes(phrase), "the actual file contents reach the second model turn");
  assert.ok(events.some(e => e.type === "text" && e.part.text.includes(phrase)));
  assert.equal(events.filter(e => e.type === "step_finish").at(-1)?.part.reason, "stop");
  assert.match(readFileSync(join(root, "fixture.txt"), "utf8"), new RegExp(phrase));
  console.log("PASS: stock OpenCode build completed read -> tool result -> final answer in exactly two gateway turns. Fixture inference; no live credits or chain writes.");
} finally {
  clearTimeout(timer); stop();
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
  db.close(); rmSync(root, { recursive: true, force: true });
}
