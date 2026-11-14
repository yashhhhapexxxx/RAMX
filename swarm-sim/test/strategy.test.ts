import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, llmFromEnv, parseDecision, promptFor, randomBid, type Profile } from "../src/strategy.ts";

const MODELS = ["Qwen/Qwen3-8B-FP8", "Qwen/Qwen3-14B-FP8"];
const buyer: Profile = { role: "buyer", model: MODELS[0]!, limit_mc: 1000, units: 4 };
const seller: Profile = { role: "seller", model: MODELS[1]!, limit_mc: 400, units: 8 };

const answer = (content: string) => (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as unknown as typeof fetch;
const LLM = { baseUrl: "https://llm.example/v1", apiKey: "k", model: "m", timeoutMs: 1000 };

test("the model's bid is used when it is valid", async () => {
  const d = await decide("buyer-1", buyer, {}, MODELS, LLM, answer('{"model":"Qwen/Qwen3-8B-FP8","units":3,"price_mc":750,"why":"shade 25% below value"}'));
  assert.equal(d.source, "llm");
  assert.deepEqual(d.bid, { role: "buyer", model: "Qwen/Qwen3-8B-FP8", units: 3, price_mc: 750 });
  assert.equal(d.why, "shade 25% below value");
});

test("a buyer never bids above its value, a seller never asks below its cost", () => {
  assert.equal(parseDecision('{"units":2,"price_mc":5000}', buyer, MODELS)!.bid.price_mc, 1000);
  assert.equal(parseDecision('{"units":2,"price_mc":10}', seller, MODELS)!.bid.price_mc, 400);
});

test("units are capped to the profile, unknown models fall back to the preferred one", () => {
  const d = parseDecision('thinking... {"model":"gpt-x","units":99,"price_mc":500}', buyer, MODELS)!;
  assert.equal(d.bid.units, 4);
  assert.equal(d.bid.model, buyer.model);
});

test("garbage, HTTP errors and timeouts fall back to a random bid inside the profile", async () => {
  for (const f of [answer("no json here"), (async () => new Response("x", { status: 500 })) as unknown as typeof fetch, (async () => { throw new Error("timeout"); }) as unknown as typeof fetch]) {
    const d = await decide("buyer-1", buyer, {}, MODELS, LLM, f);
    assert.equal(d.source, "random");
    assert.ok(d.bid.price_mc <= buyer.limit_mc && d.bid.units === buyer.units);
  }
});

test("random bids respect the profile; no key means the random strategy", async () => {
  for (let i = 0; i < 50; i++) {
    assert.ok(randomBid(buyer).price_mc <= buyer.limit_mc);
    assert.ok(randomBid(seller).price_mc >= seller.limit_mc);
  }
  assert.equal(llmFromEnv({}), null);
  assert.equal(llmFromEnv({ SWARM_LLM_API_KEY: "k", SWARM_STRATEGY: "random" }), null);
  assert.equal((await decide("s", seller, {}, MODELS, null)).source, "random");
});

test("the prompt carries the agent's limit and the recent clearing prices", () => {
  const { user } = promptFor("buyer-7", buyer, { [MODELS[0]!]: [600, 650] }, MODELS);
  assert.match(user, /worth at most 1000 mc/);
  assert.match(user, /600, 650/);
});
