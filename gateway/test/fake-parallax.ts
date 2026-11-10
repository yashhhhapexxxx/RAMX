#!/usr/bin/env node
/**
 * Fake Parallax scheduler for live checks without the pool (never port 3001):
 *   node test/fake-parallax.ts [port=3200] [model=Qwen/Qwen3-14B-FP8]
 * POST /v1/chat/completions → OpenAI-shaped answer with `usage` (streaming and non-streaming).
 * GET /v1/models → the model. Token counts: prompt = chars/4, completion = words of the answer.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3200);
const model = process.argv[3] ?? "Qwen/Qwen3-14B-FP8";

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model", created: 0, owned_by: "parallax" }] }));
  }
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    let body: any = {};
    try { body = JSON.parse(raw); } catch { res.statusCode = 400; return res.end("bad json"); }
    const q = String(body.messages?.at(-1)?.content ?? "");
    const answer = `(fake parallax) You asked: ${q.slice(0, 80)}`;
    const prompt_tokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
    const completion_tokens = Math.min(answer.split(/\s+/).length, body.max_tokens ?? 512);
    const usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ id: "fake", object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const w of answer.split(" ")) res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: w + " " } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1", () => console.log(`fake parallax on http://127.0.0.1:${port} (${model})`));
