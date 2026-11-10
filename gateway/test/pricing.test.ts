import { test } from "node:test";
import assert from "node:assert/strict";
import { LedgerEvent, PRICE_HEADER, Receipt } from "@ramx/shared";
import { createPricing } from "../src/pricing.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { costMc, holdMc, splitCost } from "../src/ledger.ts";
import { createRouter } from "../src/router.ts";
import { createApp } from "../src/app.ts";
import { createPoolQueue } from "../src/queue.ts";
import { affordableTokens } from "../src/budget.ts";
import { balance, signer, testAccount, testDirectory, TEST_JWT_SECRET, TEST_NODE } from "./helpers.ts";

const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET });
const model = cfg.model("Qwen/Qwen3-14B-FP8")!;

test("price starts at base, refreshes at 30s, discounts idle load and bounds contention", () => {
  let time = 100, active = 0, queued = 0;
  const pricing = createPricing(() => ({ active, queued }), () => time);
  assert.equal(pricing.quote(model).multiplier, 1);
  time += 29_999;
  assert.equal(pricing.quote(model).multiplier, 1);
  time++;
  const idle = pricing.quote(model);
  assert.equal(idle.multiplier, 0.5);
  assert.equal(idle.credits_per_1k_in, 175);
  assert.equal(idle.credits_per_1k_out, 875);
  idle.multiplier = 99; // callers cannot mutate the cached quote
  assert.equal(pricing.quote(model).multiplier, 0.5);
  active = 1; queued = 2; time += 30_000;
  assert.equal(pricing.quote(model).multiplier, 2);
  queued = 10_000; time += 30_000;
  assert.equal(pricing.quote(model).multiplier, 2);
});

test("queue exposes waiting demand and removes cancelled waiters", async () => {
  const queue = createPoolQueue();
  const first = await queue.acquire("p", 1, new AbortController().signal);
  const abort = new AbortController();
  const waiting = queue.acquire("p", 1, abort.signal);
  assert.equal(queue.queued(["p"]), 1);
  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(queue.queued(["p"]), 0);
  first();
});

test("floating costs retain exact split sums and never exceed the matching hold", () => {
  assert.equal(affordableTokens(cfg.net, model, 100_000, 0, 1), 57);
  assert.equal(affordableTokens(cfg.net, model, 100_000, 0, 2), 28);
  assert.equal(affordableTokens(cfg.net, model, 100_000, 0, 0.5), 114);
  for (const multiplier of [0.5, 1, 1.5, 2]) {
    for (let tokens = 1; tokens < 500; tokens += 7) {
      const cost = costMc(cfg.net, model, 17, tokens, multiplier);
      const hold = holdMc(cfg.net, model, 500, 17, multiplier);
      assert.ok(cost <= hold);
      const split = splitCost(cfg.net, cost, [{ node_id: TEST_NODE, layers: [0, 40] }], 40, () => "acc_provider", "acc_requester");
      assert.equal(Object.values(split.nodes).reduce((a, b) => a + b, 0) + split.burn_mc + split.reserve_mc, cost);
      assert.equal(split.nodes[TEST_NODE], Math.floor(cost * 0.9));
      assert.equal(split.burn_mc, Math.floor(cost * 0.05));
    }
  }
});

test("request locks its quote: load changes during inference, receipt/ledger and debit retain original price", async () => {
  const db = openDb(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    const directory = testDirectory(cfg, db);
    const router = createRouter(cfg, db, directory);
    let now = 100, demand = 0;
    const pricing = createPricing(() => ({ active: demand, queued: 0 }), () => now);
    router.pricing.quote = pricing.quote;
    const user = await testAccount(db, cfg);
    const before = balance(db, user.accountId).starter_mc;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        const send = (value: object) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
        send({ choices: [{ index: 0, delta: { content: "hello" } }] });
        demand = 3; now += 30_000;
        assert.equal(pricing.quote(model).multiplier, 2);
        send({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const app = createApp({ cfg, db, signer, router, onComplete: () => {} });
    const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...user.auth },
      body: JSON.stringify({ model: model.model_id, messages: [{ role: "user", content: "hello" }], max_tokens: 32, stream: true }) });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(JSON.parse(response.headers.get(PRICE_HEADER)!).multiplier, 1);
    const receipt = Receipt.parse(await (await app.request(`/requests/${response.headers.get("x-ramx-request-id")}`)).json());
    assert.equal(receipt.price_multiplier, 1);
    assert.equal(receipt.cost_mc, 4900);
    assert.equal(before - balance(db, user.accountId).starter_mc, 4900);
    assert.equal(balance(db, user.accountId).held_mc, 0);
    const event = LedgerEvent.parse(JSON.parse((db.prepare("SELECT payload FROM ledger_events WHERE type = 'request_settled'").get() as { payload: string }).payload));
    assert.ok(event.type === "request_settled");
    assert.equal(event.price_multiplier, 1);
    const models = await router.models();
    assert.equal(models.data.find((m) => m.id === model.model_id)?.price?.multiplier, 2);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

function fakeUpstream(usage: { prompt_tokens: number; completion_tokens: number }) {
  const sent: Record<string, unknown>[] = [];
  const fetch = async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

const chat = (auth: Record<string, string>, content: string, extra: Record<string, unknown> = {}) => ({
  method: "POST", headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ model: model.model_id, messages: [{ role: "user", content }], max_tokens: 32, stream: true, ...extra }),
});

test("a locked 2× quote doubles the hold and the charge, and the receipt says 2", async () => {
  const db = openDb(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    const router = createRouter(cfg, db, testDirectory(cfg, db));
    router.pricing.quote = (m) => ({ credits_per_1k_in: m.model_factor * 400, credits_per_1k_out: m.model_factor * 2000, multiplier: 2, quoted_at: 1 });
    const user = await testAccount(db, cfg);
    const before = balance(db, user.accountId).starter_mc;
    globalThis.fetch = fakeUpstream({ prompt_tokens: 4, completion_tokens: 2 }).fetch;
    const app = createApp({ cfg, db, signer, router, onComplete: () => {} });
    const res = await app.request("/v1/chat/completions", chat(user.auth, "hello"));
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(JSON.parse(res.headers.get(PRICE_HEADER)!).multiplier, 2);
    const receipt = Receipt.parse(await (await app.request(`/requests/${res.headers.get("x-ramx-request-id")}`)).json());
    assert.equal(receipt.price_multiplier, 2);
    assert.equal(receipt.cost_mc, costMc(cfg.net, model, 4, 2, 2));
    assert.equal(receipt.cost_mc, 2 * 4900);
    assert.equal(before - balance(db, user.accountId).starter_mc, 9800);
    assert.equal(balance(db, user.accountId).held_mc, 0);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("context fitting uses the pool's live context, and falls back to config when it is unknown", async () => {
  const db = openDb(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    const router = createRouter(cfg, db, testDirectory(cfg, db));
    const user = await testAccount(db, cfg);
    const up = fakeUpstream({ prompt_tokens: 10, completion_tokens: 2 });
    globalThis.fetch = up.fetch;
    const app = createApp({ cfg, db, signer, router, onComplete: () => {} });
    const prompt = "word ".repeat(2400); // ~3000 tokens: fits config 4096, not a 1024 pool
    assert.equal(model.context_length, 4096);

    router.contextLength = async () => 1024;
    const small = await app.request("/v1/chat/completions", chat(user.auth, prompt));
    assert.equal(small.status, 400);
    assert.match(await small.text(), /context_length_exceeded[\s\S]*context 1024/);

    router.contextLength = async () => { throw new Error("directory down"); };
    const fallback = await app.request("/v1/chat/completions", chat(user.auth, prompt));
    assert.equal(fallback.status, 200, await fallback.clone().text());
    await fallback.text();

    // A bigger live context lets the answer use the room config would have refused.
    router.contextLength = async () => 16384;
    const big = await app.request("/v1/chat/completions", chat(user.auth, prompt, { max_tokens: 2048 }));
    assert.equal(big.status, 200);
    await big.text();
    assert.equal(up.sent.at(-1)!.max_tokens, Number(big.headers.get("x-ramx-max-tokens")));
    router.contextLength = async () => undefined;
    const cfgOnly = await app.request("/v1/chat/completions", chat(user.auth, prompt, { max_tokens: 2048 }));
    await cfgOnly.text();
    assert.ok(Number(cfgOnly.headers.get("x-ramx-max-tokens")) < 1100, "config 4096 leaves under ~1000 tokens for the answer");
    assert.ok(Number(big.headers.get("x-ramx-max-tokens")) > Number(cfgOnly.headers.get("x-ramx-max-tokens")));
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("router.contextLength: smallest reported pool context; unknown when any pool has none", async () => {
  const db = openDb(":memory:");
  const router = createRouter(cfg, db, testDirectory(cfg, db));
  // testDirectory's pool has nodes without max_seq heartbeats: unknown, so config applies.
  assert.equal(await router.contextLength(model), undefined);
  db.close();
});

test("x402 keeps its fixed USDC tiers: no floating price header, no multiplier on the receipt", async () => {
  const db = openDb(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    const router = createRouter(cfg, db, testDirectory(cfg, db));
    router.pricing.quote = (m) => ({ credits_per_1k_in: m.model_factor * 400, credits_per_1k_out: m.model_factor * 2000, multiplier: 2, quoted_at: 1 });
    globalThis.fetch = fakeUpstream({ prompt_tokens: 4, completion_tokens: 2 }).fetch;
    const x402 = { charge: async () => ({ payer: "acct-9.testnet", tx: "HEqAxC3rbvSwWW6KQbzt69wp6MeWqL4JLsv1jY1gCDQy", amountUnits: "4000", asset: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", headers: {} }), topup: async () => { throw new Error("unused"); } };
    const app = createApp({ cfg, db, signer, router, x402, onComplete: () => {} });
    const res = await app.request("/v1/chat/completions", chat({}, "hello"));
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(res.headers.get(PRICE_HEADER), null);
    const receipt = Receipt.parse(await (await app.request(`/requests/${res.headers.get("x-ramx-request-id")}`)).json());
    assert.equal(receipt.pay_type, "x402");
    assert.equal(receipt.price_multiplier ?? null, null);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
