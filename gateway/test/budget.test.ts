import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { costMc } from "../src/ledger.ts";
import { affordableTokens, learnedNeed, MIN_ANSWER, pickMaxTokens } from "../src/budget.ts";
import { testAccount } from "./helpers.ts";

const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:" });
const model = cfg.model("Qwen/Qwen3-14B-FP8")!;

let n = 0;
function answer(db: Db, accountId: string, out: number, max: number, agentId: string | null = null) {
  n++;
  db.prepare("INSERT INTO requests (req_id, account_id, model, pay_type, status, prompt_hash, out_tokens, max_tokens, agent_id, ts) VALUES (?, ?, ?, 'credits', 'ok', '0x', ?, ?, ?, ?)")
    .run(`req_b${n}`, accountId, model.model_id, out, max, agentId, n);
}

test("learnedNeed: none below 5 answers; p90 × 1.25, at least 256; a cut-off answer doubles its cap", async () => {
  const db = openDb(":memory:");
  const { accountId } = await testAccount(db, cfg);
  for (let i = 0; i < 4; i++) answer(db, accountId, 100, 2048);
  assert.equal(learnedNeed(db, accountId, null), null);
  answer(db, accountId, 100, 2048);
  assert.equal(learnedNeed(db, accountId, null), 256); // p90 100 × 1.25 = 125 → floor 256
  for (let i = 0; i < 45; i++) answer(db, accountId, 400 + i, 2048);
  // 50 answers: 5 × 100 and 400..444; p90 = 45th smallest = 439 → ceil(548.75) = 549
  assert.equal(learnedNeed(db, accountId, null), 549);
  answer(db, accountId, 549, 549); // newest answer hit its cap
  assert.equal(learnedNeed(db, accountId, null), 1098);
});

test("learnedNeed: a key learns from its own answers only", async () => {
  const db = openDb(":memory:");
  const { accountId } = await testAccount(db, cfg);
  for (let i = 0; i < 10; i++) answer(db, accountId, 1500, 2048);
  for (let i = 0; i < 10; i++) answer(db, accountId, 300, 2048, "agt_k");
  assert.equal(learnedNeed(db, accountId, "agt_k"), 375);
  assert.ok(learnedNeed(db, accountId, null)! > 375);
});

test("affordableTokens: the largest answer whose cost fits, exactly", () => {
  const inTokens = 1000;
  const avail = 1_000_000; // 1,000 credits
  const t = affordableTokens(cfg.net, model, avail, inTokens);
  assert.ok(costMc(cfg.net, model, inTokens, t) <= avail);
  assert.ok(costMc(cfg.net, model, inTokens, t + 1) > avail);
  assert.equal(affordableTokens(cfg.net, model, 10, inTokens), 0); // cannot even pay the prompt
});

test("pickMaxTokens: new user gets the client's value (or the default), capped by the ceiling", () => {
  const base = { cfg: cfg.net, model, learned: null, availableMc: 10_000_000, inTokens: 500 };
  assert.deepEqual(pickMaxTokens({ ...base, ceiling: 2048, asked: null }), { maxTokens: cfg.net.cost.default_max_tokens });
  assert.deepEqual(pickMaxTokens({ ...base, ceiling: 2048, asked: 1024 }), { maxTokens: 1024 });
  assert.deepEqual(pickMaxTokens({ ...base, ceiling: 1500, asked: 2048 }), { maxTokens: 1500 });
});

test("pickMaxTokens: learned need wins over the client's large value", () => {
  assert.deepEqual(pickMaxTokens({ cfg: cfg.net, model, ceiling: 2048, asked: 2048, learned: 300, availableMc: 10_000_000, inTokens: 500 }), { maxTokens: 300 });
});

test("pickMaxTokens: a low balance gives a short answer; too little for MIN_ANSWER gives null", () => {
  const inTokens = 1000; // prompt costs 1.75 × 0.2 × 1000 = 350 credits
  const low = pickMaxTokens({ cfg: cfg.net, model, ceiling: 2048, asked: 2048, learned: null, availableMc: 500_000, inTokens });
  assert.ok(low.maxTokens !== null && low.maxTokens < 100 && low.maxTokens >= MIN_ANSWER, JSON.stringify(low));
  const none = pickMaxTokens({ cfg: cfg.net, model, ceiling: 2048, asked: 2048, learned: null, availableMc: 360_000, inTokens });
  assert.equal(none.maxTokens, null);
  const zero = pickMaxTokens({ cfg: cfg.net, model, ceiling: 2048, asked: null, learned: null, availableMc: 0, inTokens });
  assert.deepEqual(zero, { maxTokens: null, affordable: 0 });
});
