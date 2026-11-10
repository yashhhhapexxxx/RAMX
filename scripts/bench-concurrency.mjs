#!/usr/bin/env node
// Concurrency benchmark through the gateway (batching, docs/BATCHING-HANDOFF.md §3.5).
// Sends N concurrent streaming requests (256 output tokens each) for every N in LEVELS and prints,
// per request: time to first token and decode tok/s; per level: aggregate tok/s and wall time.
//
//   TOKEN=$(cd gateway && node --env-file=.env scripts/dev-session.ts bench | jq -r .token)
//   TOKEN=$TOKEN node scripts/bench-concurrency.mjs            # levels 1,2,4,8
//   TOKEN=$TOKEN LEVELS=1,2,4 GATEWAY=http://127.0.0.1:8080 node scripts/bench-concurrency.mjs
const GATEWAY = (process.env.GATEWAY ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const TOKEN = process.env.TOKEN;
const LEVELS = (process.env.LEVELS ?? "1,2,4,8").split(",").map(Number);
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 256);
const MODEL = process.env.MODEL ?? "Qwen/Qwen3-14B-FP8";
if (!TOKEN) { console.error("Set TOKEN (a dev session token, see the header of this file)"); process.exit(1); }

const PROMPTS = [
  "Explain how a pipeline-parallel LLM split across three laptops works, in detail.",
  "Write a short story about a lighthouse keeper who finds a robot on the beach.",
  "List and explain ten practical tips for writing clean Python code.",
  "Describe the water cycle step by step for a high school student.",
  "Compare TCP and UDP and when to use each, with examples.",
  "Explain how a hash map works and what makes a good hash function.",
  "Describe the history of the printing press and its effect on Europe.",
  "Explain photosynthesis to a ten year old, then to a biology student.",
];

async function one(i) {
  const t0 = performance.now();
  const res = await fetch(GATEWAY + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: PROMPTS[i % PROMPTS.length] + " Write at least 400 words." }] }),
  });
  if (!res.ok || !res.body) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const times = [];
  let usage = null, buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      let d;
      try { d = JSON.parse(line.slice(6)); } catch { continue; }
      if (d.error) return { error: JSON.stringify(d.error).slice(0, 200) };
      if (d.usage) usage = d.usage;
      if (d.choices?.some((c) => c.delta?.content)) times.push(performance.now());
    }
  }
  const end = performance.now();
  const n = usage?.completion_tokens ?? times.length;
  if (!times.length) return { error: "no content tokens" };
  const gaps = times.slice(1).map((t, k) => t - times[k]);
  return { n, ttft: (times[0] - t0) / 1000, decode: times.length > 1 ? (n - 1) / ((times.at(-1) - times[0]) / 1000) : 0,
    worstGapMs: gaps.length ? Math.max(...gaps) : 0, start: t0, end };
}

const rows = [];
for (const level of LEVELS) {
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: level }, (_, i) => one(i)));
  const wall = (performance.now() - t0) / 1000;
  const ok = results.filter((r) => !r.error);
  for (const [i, r] of results.entries()) {
    console.log(r.error ? `  c=${level} #${i + 1}: ERROR ${r.error}`
      : `  c=${level} #${i + 1}: tokens=${r.n} ttft=${r.ttft.toFixed(2)}s decode=${r.decode.toFixed(2)} tok/s worst_gap=${r.worstGapMs.toFixed(0)}ms`);
  }
  const tokens = ok.reduce((s, r) => s + r.n, 0);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
  const row = { level, ok: ok.length, errors: results.length - ok.length, wall, aggregate: tokens / wall,
    ttft: median(ok.map((r) => r.ttft)), decode: median(ok.map((r) => r.decode)) };
  rows.push(row);
  console.log(`c=${level}: ok=${row.ok}/${level} wall=${wall.toFixed(1)}s aggregate=${row.aggregate.toFixed(2)} tok/s median_ttft=${row.ttft.toFixed(2)}s median_decode=${row.decode.toFixed(2)} tok/s`);
}
console.log("\n| Concurrent | OK | Wall (s) | Aggregate tok/s | Median TTFT (s) | Median decode tok/s per request |");
console.log("|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.level} | ${r.ok}/${r.level} | ${r.wall.toFixed(1)} | ${r.aggregate.toFixed(2)} | ${r.ttft.toFixed(2)} | ${r.decode.toFixed(2)} |`);
