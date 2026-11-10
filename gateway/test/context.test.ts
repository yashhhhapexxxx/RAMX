import { test } from "node:test";
import assert from "node:assert/strict";
import { contentText, type ChatCompletionRequest, type ChatMessage } from "@ramx/shared";
import { cutMiddle, fitContext, marginTokens } from "../src/context.ts";
import { estimateInputTokens } from "../src/ledger.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";
const READ = { type: "function" as const, function: { name: "read", description: "Reads a file.\n\n" + "Long usage notes. ".repeat(80), parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } };

test("context: a full tool set gets shorter descriptions without losing tools, schema or the user turn", () => {
  const tools = Array.from({ length: 10 }, (_, i) => ({ type: "function" as const, function: {
    name: `tool_${i}`, description: "Function description with essential usage hints. ".repeat(8),
    parameters: { type: "object", properties: { path: { type: "string", description: "Path parameter documentation and examples. ".repeat(8) },
      mode: { type: "string", enum: ["read", "write"], description: "Mode parameter documentation and examples. ".repeat(8) } }, required: ["path"] },
  } }));
  const req: ChatCompletionRequest = { model: MODEL, tools, messages: [{ role: "system", content: "System rules. ".repeat(300) }, { role: "user", content: "Read the file." }] };
  const fit = fitContext(req, 3500, 64, true);
  assert.ok(fit.ok);
  assert.equal(fit.trimmed, 0);
  assert.deepEqual(fit.req.messages, req.messages);
  assert.deepEqual(fit.req.tools?.map(t => t.function.name), tools.map(t => t.function.name));
  for (const tool of fit.req.tools!) {
    const schema = tool.function.parameters as any;
    assert.deepEqual(schema.required, ["path"]);
    assert.deepEqual(schema.properties.mode.enum, ["read", "write"]);
    assert.equal(schema.properties.path.type, "string");
    assert.equal(schema.properties.path.description, undefined);
    assert.ok(tool.function.description!.length <= 80);
  }
});

/** An OpenCode-shaped session of about `turns` read-and-answer rounds, ~30k tokens in total. */
function session(turns: number, fileChars = 3900): ChatCompletionRequest {
  const messages: ChatMessage[] = [{ role: "system", content: "You are opencode. " + "Be concise. ".repeat(200) }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `Question ${i}: what is in file${i}.ts?` });
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: `/repo/file${i}.ts` }) } }] });
    messages.push({ role: "tool", tool_call_id: `call_${i}`, content: `// file${i}\n` + "const x = 1;\n".repeat(fileChars / 13) });
    messages.push({ role: "assistant", content: `file${i}.ts sets x.` });
  }
  messages.push({ role: "user", content: "Now summarise everything you read." });
  return { model: MODEL, tools: [READ], messages };
}

test("cutMiddle keeps head and tail and says what was cut", () => {
  const t = "a".repeat(100) + "\n".repeat(5) + "b".repeat(100);
  const c = cutMiddle(t, 50);
  assert.ok(c.startsWith("a".repeat(30)) && c.endsWith("b".repeat(20)));
  assert.match(c, /characters, 5 lines cut by the gateway/);
  assert.equal(cutMiddle("short", 50), "short");
});

test("a request that fits is not changed (apart from compact tools)", () => {
  const req: ChatCompletionRequest = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
  const f = fitContext(req, 4096, 256, false);
  assert.ok(f.ok);
  assert.equal(f.trimmed, 0);
  assert.equal(f.req, req);
});

for (const ctx of [8192, 16384]) {
  test(`a ~30k-token OpenCode session fits ${ctx}: system, tools and last user turn kept`, () => {
    const req = session(30);
    assert.ok(estimateInputTokens(req.messages, req.tools) > 28_000);
    const f = fitContext(req, ctx, 512, true);
    assert.ok(f.ok, JSON.stringify(f));
    assert.ok(f.promptTokens <= ctx - 512 - marginTokens(ctx));
    assert.equal(f.promptTokens, estimateInputTokens(f.req.messages, f.req.tools));
    assert.ok(f.trimmed > 0);
    const m = f.req.messages;
    assert.equal(m[0]!.role, "system");
    assert.equal(contentText(m[0]!.content), contentText(req.messages[0]!.content));
    assert.equal(contentText(m.at(-1)!.content), "Now summarise everything you read.");
    assert.ok(f.req.tools![0]!.function.description!.length < 60, "tools compacted");
    // no tool result without its call, no call without its result
    const calls = new Set(m.flatMap((x) => (x.role === "assistant" ? (x.tool_calls ?? []).map((c) => c.id) : [])));
    const results = new Set(m.flatMap((x) => (x.role === "tool" ? [x.tool_call_id] : [])));
    assert.deepEqual([...calls].sort(), [...results].sort());
    // the newest turns survive, the oldest go first
    const kept = m.flatMap((x) => /^Question (\d+):/.exec(contentText(x.content))?.[1] ?? []).map(Number);
    assert.equal(kept.at(-1), 29);
    assert.deepEqual(kept, Array.from({ length: kept.length }, (_, i) => 30 - kept.length + i));
    // 8k must drop turns; 16k gets by with cut tool results only
    assert.equal(kept.length < 30, ctx === 8192);
  });
}

test("one huge tool result in the last turn is cut, not dropped", () => {
  const req: ChatCompletionRequest = {
    model: MODEL,
    messages: [
      { role: "user", content: "read big.ts" },
      { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c", content: "HEAD" + "x".repeat(60_000) + "TAIL" },
    ],
  };
  const f = fitContext(req, 4096, 256, false);
  assert.ok(f.ok);
  const tool = contentText(f.req.messages[2]!.content);
  assert.ok(tool.startsWith("HEAD") && tool.endsWith("TAIL") && tool.length < 9000);
});

test("a system prompt bigger than the context cannot fit: clear numbers back", () => {
  const req: ChatCompletionRequest = { model: MODEL, messages: [{ role: "system", content: "s".repeat(40_000) }, { role: "user", content: "hi" }] };
  const f = fitContext(req, 4096, 256, false);
  assert.equal(f.ok, false);
  assert.ok(!f.ok && f.promptTokens > f.budget && f.budget === 4096 - 256 - marginTokens(4096));
});
