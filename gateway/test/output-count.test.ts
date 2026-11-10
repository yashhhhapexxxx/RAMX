import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { countedOutput, observedOutputTokens, OUTPUT_MARGIN } from "../src/ledger.ts";
import { signer, testAccount, testDirectory, TEST_JWT_SECRET } from "./helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";
const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET });

test("counted output: honest counts pass, inflated counts are capped at observed + margin and flagged", () => {
  assert.deepEqual(countedOutput(100, 100), { billed: 100, overcount: false });
  assert.deepEqual(countedOutput(105, 100), { billed: 105, overcount: false }, "within the margin");
  assert.deepEqual(countedOutput(500, 100), { billed: 100 + OUTPUT_MARGIN, overcount: true });
  assert.equal(observedOutputTokens("x".repeat(30)), 10, "≈ 3 chars per token");
  assert.equal(observedOutputTokens("ab", 40), 40, "stream chunks count when higher");
});

/** A pool that streams `text` and reports `reported` completion tokens. */
const pool = (text: string, reported: number) => (async () => new Response(
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: reported, total_tokens: 10 + reported } })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } })) as typeof fetch;

for (const c of [{ name: "honest", text: "word ".repeat(60), reported: 100, billed: 100, ok: 1 }, { name: "inflating", text: "Hi", reported: 1000, billed: 1 + OUTPUT_MARGIN, ok: 0 }]) {
  test(`a ${c.name} pool: billed ${c.billed} output tokens, request counts ${c.ok ? "ok" : "as a failure"} for the pool`, async () => {
    const db = openDb(":memory:");
    const realFetch = globalThis.fetch;
    globalThis.fetch = pool(c.text, c.reported);
    try {
      const user = await testAccount(db, cfg);
      const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db), onComplete: () => {} });
      const r = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...user.auth },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 1000, stream: true }) });
      assert.equal(r.status, 200);
      await r.text();
      await new Promise((res) => setTimeout(res, 20));
      const row = db.prepare("SELECT out_tokens, status FROM requests").get() as { out_tokens: number; status: string };
      assert.deepEqual([row.status, row.out_tokens], ["ok", c.billed]);
      const outcome = db.prepare("SELECT ok FROM pool_request_outcomes").get() as { ok: number };
      assert.equal(outcome.ok, c.ok);
    } finally {
      globalThis.fetch = realFetch;
      db.close();
    }
  });
}
