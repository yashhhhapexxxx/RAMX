import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LedgerEvent, Receipt, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { createX402, httpFacilitator, priceUnits } from "../src/x402.ts";
import { signer, TEST_JWT_SECRET, testDirectory } from "./helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const PAYER = "agent-1.ramx.testnet";
const TX = "4PQy4V66tfykETHsSgt49GBpPdWMAUSbnVLDkMz7RsxC";

let facilitator: Server;
let pool: Server;
let poolFail = false;
/** Fail this many pool requests, then answer (post-MVP P5.2 failover). */
let poolFailNext = 0;
const facCalls: string[] = [];
let facUrl = "";

before(async () => {
  facilitator = createServer((req, res) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      facCalls.push(req.url ?? "");
      if (req.url?.endsWith("/supported")) return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "near:testnet" }], extensions: [], signers: { "near:*": ["relayer.ramx.testnet"] } }));
      if (req.url?.endsWith("/verify")) return res.end(JSON.stringify({ isValid: true, payer: PAYER }));
      if (req.url?.endsWith("/settle")) return res.end(JSON.stringify({ success: true, payer: PAYER, transaction: TX, network: "near:testnet" }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  pool = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (poolFail || poolFailNext > 0) { poolFailNext = Math.max(0, poolFailNext - 1); res.statusCode = 500; return res.end("down"); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "x", choices: [{ index: 0, message: { role: "assistant", content: "paid answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }));
    });
  });
  await new Promise<void>((r) => facilitator.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => pool.listen(0, "127.0.0.1", r));
  facUrl = `http://127.0.0.1:${(facilitator.address() as AddressInfo).port}`;
});
after(() => { facilitator.close(); pool.close(); });

function setup() {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: `http://127.0.0.1:${(pool.address() as AddressInfo).port}`, DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET });
  const db = openDb(":memory:");
  const x402 = createX402({ cfg: cfg.net, facilitator: httpFacilitator(facUrl), payTo: "treasury.ramx.testnet" });
  const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db), x402, onComplete: () => {} });
  return { cfg, db, app };
}

const send = (app: ReturnType<typeof setup>["app"], body: object, headers: Record<string, string> = {}) =>
  app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body) });

const requirementsOf = (r: Response) => JSON.parse(Buffer.from(r.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8"));

test("pricing tiers (SPEC §7.3): model and max_tokens", () => {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://x", DATABASE_PATH: ":memory:" });
  assert.equal(priceUnits(cfg.net, MODEL, 1), "4000");
  assert.equal(priceUnits(cfg.net, MODEL, 512), "4000");
  assert.equal(priceUnits(cfg.net, MODEL, 513), "12000");
  assert.equal(priceUnits(cfg.net, MODEL, 2048), "12000");
  assert.equal(priceUnits(cfg.net, "Qwen/Qwen3-8B-FP8", 512), "2000");
  assert.equal(priceUnits(cfg.net, "Qwen/Qwen3-8B-FP8", 2048), "6000");
  assert.throws(() => priceUnits(cfg.net, MODEL, 2049), /last tier/);
});

test("unpaid request (no session) → 402 with USDC-on-NEAR requirements priced by the body; nothing recorded", async () => {
  const { app, db } = setup();
  const small = await send(app, { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 100 });
  assert.equal(small.status, 402);
  assert.ok(small.headers.get(REQUEST_ID_HEADER));
  const req = requirementsOf(small);
  assert.equal(req.x402Version, 2);
  const a = req.accepts[0];
  assert.deepEqual({ scheme: a.scheme, network: a.network, asset: a.asset, amount: a.amount, payTo: a.payTo }, { scheme: "exact", network: "near:testnet", asset: USDC, amount: "4000", payTo: "treasury.ramx.testnet" });
  const big = await send(app, { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 1000 });
  assert.equal(requirementsOf(big).accepts[0].amount, "12000");
  const s8 = await send(app, { model: "Qwen/Qwen3-8B-FP8", messages: [{ role: "user", content: "hi" }] });
  assert.equal(s8.status, 503); // No eligible 8B pool: never offer payment for unavailable inference.
  assert.equal(s8.headers.get("PAYMENT-REQUIRED"), null);
  assert.equal((db.prepare("SELECT count(*) AS n FROM requests").get() as { n: number }).n, 0);
  // Validation still comes first: bad body → 400, not 402.
  assert.equal((await send(app, { model: MODEL, messages: [] })).status, 400);
  db.close();
});

test("paid request: verify + settle BEFORE the pool runs; row with payer/tx/amount; x402_payment event; PAYMENT-RESPONSE", async () => {
  const { app, db } = setup();
  const providerAddress = "provider-1.testnet";
  db.prepare("UPDATE accounts SET payout_address = ? WHERE id = 'acc_router'").run(providerAddress);
  const unpaid = await send(app, { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 64 });
  const reqs = requirementsOf(unpaid);
  const payload = { x402Version: 2, resource: reqs.resource, accepted: reqs.accepts[0], payload: { transaction: "AAAA" } };
  facCalls.length = 0;
  const r = await send(app, { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 64 }, { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(facCalls.filter((u) => !u.endsWith("/supported")).map((u) => u.split("/").pop()), ["verify", "settle"]);
  assert.ok(r.headers.get("PAYMENT-RESPONSE"));
  const receipt = Receipt.parse(await (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  assert.equal(receipt.pay_type, "x402");
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.x402_payer, PAYER);
  assert.equal(receipt.x402_tx, TX);
  assert.equal(receipt.x402_amount, "4000");
  assert.equal(receipt.x402_asset, USDC);
  assert.equal(receipt.account_id, null);
  assert.equal(receipt.cost_mc, null);
  db.prepare("UPDATE accounts SET payout_address = ? WHERE id = 'acc_router'").run("provider-2.testnet");
  const snapshot = JSON.parse((db.prepare("SELECT payout_snapshot FROM requests WHERE req_id = ?").get(receipt.req_id) as { payout_snapshot: string }).payout_snapshot);
  assert.equal(snapshot[0].payout_address, providerAddress); // later wallet changes cannot redirect this request
  const ev = LedgerEvent.parse(JSON.parse((db.prepare("SELECT payload FROM ledger_events WHERE type = 'x402_payment'").get() as { payload: string }).payload));
  assert.equal(ev.type === "x402_payment" && ev.tx_id, TX);
  assert.equal(ev.type === "x402_payment" && ev.out_tokens, 2);

  // Paid, then the pool fails: recorded as failed, no refund, no event.
  poolFail = true;
  const f = await send(app, { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 64 }, { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") });
  poolFail = false;
  assert.equal(f.status, 502);
  const fr = Receipt.parse(await (await app.request(`/requests/${f.headers.get(REQUEST_ID_HEADER)}`)).json());
  assert.equal(fr.status, "failed");
  assert.equal(fr.x402_tx, TX);
  assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE type = 'x402_payment'").get() as { n: number }).n, 1);
  db.close();
});

test("x402 + failover: paid once, first attempt fails, retry answers; one settle, one event, snapshot of the answering route", async () => {
  const { app, db } = setup();
  db.prepare("UPDATE accounts SET payout_address = ? WHERE id = 'acc_router'").run("provider-3.testnet");
  const unpaid = await send(app, { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 64 });
  const reqs = requirementsOf(unpaid);
  const payload = { x402Version: 2, resource: reqs.resource, accepted: reqs.accepts[0], payload: { transaction: "AAAA" } };
  facCalls.length = 0;
  poolFailNext = 1;
  const r = await send(app, { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 64 }, { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(facCalls.filter((u) => u.endsWith("/settle")).length, 1, "the payment settles once");
  const receipt = Receipt.parse(await (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  assert.equal(receipt.status, "ok");
  assert.deepEqual(receipt.attempts?.map((a) => a.outcome), ["pool_error", "ok"]);
  const snapshot = JSON.parse((db.prepare("SELECT payout_snapshot FROM requests WHERE req_id = ?").get(receipt.req_id) as { payout_snapshot: string }).payout_snapshot);
  assert.equal(snapshot[0].payout_address, "provider-3.testnet");
  assert.deepEqual(snapshot.map((h: { node_id: string; layers: number[] }) => [h.node_id, h.layers]), receipt.route!.map((h) => [h.node_id, h.layers]));
  const events = db.prepare("SELECT payload FROM ledger_events WHERE type = 'x402_payment'").all() as { payload: string }[];
  assert.equal(events.length, 1);
  const ev = LedgerEvent.parse(JSON.parse(events[0]!.payload));
  assert.deepEqual(ev.type === "x402_payment" && ev.route, receipt.route);
  db.close();
});

test("API key top-up through the real x402 server: 402 asks exactly usdc × 1e6 base units of USDC; paid → 1000 credits per USDC on that key", async () => {
  const { app, db, cfg } = setup();
  const { testAccount } = await import("./helpers.ts");
  const { createAgentKey } = await import("../src/incentives.ts");
  const user = await testAccount(db, cfg);
  const key = createAgentKey(db, signer, user.accountId, "opencode", null);
  const topup = (headers: Record<string, string> = {}) => app.request("/v1/credits/topup", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key.token}`, ...headers }, body: JSON.stringify({ usdc: 0.05 }) });
  const unpaid = await topup();
  assert.equal(unpaid.status, 402);
  const reqs = requirementsOf(unpaid);
  assert.equal(reqs.accepts.length, 1, "USDC only");
  assert.deepEqual({ asset: reqs.accepts[0].asset, amount: reqs.accepts[0].amount, payTo: reqs.accepts[0].payTo }, { asset: USDC, amount: "50000", payTo: "treasury.ramx.testnet" });
  assert.match(reqs.resource.url, /\/v1\/credits\/topup$/);
  const payload = { x402Version: 2, resource: reqs.resource, accepted: reqs.accepts[0], payload: { transaction: "AAAA" } };
  const paid = await topup({ "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") });
  assert.equal(paid.status, 200, await paid.clone().text());
  assert.ok(paid.headers.get("PAYMENT-RESPONSE"));
  const body = await paid.json() as { added_mc: number; payer: string; tx_id: string; credits: { key_credits_mc: number } };
  assert.deepEqual({ added: body.added_mc, payer: body.payer, tx: body.tx_id, credits: body.credits.key_credits_mc }, { added: 50_000, payer: PAYER, tx: TX, credits: 50_000 });
  // The facilitator answers with the same tx again: never credited twice.
  const replay = await topup({ "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") });
  assert.equal(replay.status, 400);
  assert.equal((db.prepare("SELECT key_credits_mc FROM agent_keys WHERE id = ?").get(key.agent_id) as { key_credits_mc: number }).key_credits_mc, 50_000);
  // Chat x402 pricing is unchanged by the second route.
  assert.equal(requirementsOf(await send(app, { model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 100 })).accepts[0].amount, "4000");
  db.close();
});
