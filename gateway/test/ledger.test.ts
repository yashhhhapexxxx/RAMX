import { test } from "node:test";
import assert from "node:assert/strict";
import { LedgerEvent, type Route } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { costMc, estimateInputTokens, expireStarterCredits, holdMc, releaseHold, settle, splitCost, tryHold, availableMc, paysNode } from "../src/ledger.ts";
import { loginOrCreate } from "../src/accounts.ts";
import { balance, signer, TEST_JWT_SECRET } from "./helpers.ts";

const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET });
const M14 = cfg.model("Qwen/Qwen3-14B-FP8")!;
const M8 = cfg.model("Qwen/Qwen3-8B-FP8")!;
const A = "0xa4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4";
const B = "0xa5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5";
const C = "0x4646464646464646464646464646464646464646";
const ROUTE: Route = [{ node_id: A, layers: [0, 20] }, { node_id: B, layers: [20, 29] }, { node_id: C, layers: [29, 40] }];

const sumSplit = (s: { nodes: Record<string, number>; burn_mc: number; reserve_mc: number }) =>
  Object.values(s.nodes).reduce((a, b) => a + b, 0) + s.burn_mc + s.reserve_mc;

test("cost: model_factor × (out + 0.2 × in), integer millicredits", () => {
  assert.equal(costMc(cfg.net, M14, 412, 256), 592_200); // 1.75 × (256 + 82.4) = 592.2 credits
  assert.equal(costMc(cfg.net, M8, 0, 1), 1000); // 1 credit = 1 output token on 8B
  assert.equal(costMc(cfg.net, M8, 1, 0), 200);
  assert.equal(costMc(cfg.net, M14, 1, 0), 350);
  assert.equal(costMc(cfg.net, M14, 3, 1), 2800); // 1.75 × 1.6 = 2.8
  assert.equal(costMc(cfg.net, M14, 0, 0), 0);
});

test("hold: max_tokens + 0.2 × ceil(chars / 4)", () => {
  assert.equal(estimateInputTokens([{ role: "user", content: "abcd" }, { role: "user", content: "e" }]), 2);
  // text parts, tool calls and tool definitions count too
  assert.equal(estimateInputTokens([{ role: "user", content: [{ type: "text", text: "abcd" }] }, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] }]), 3); // 4 + "read" + "{}" = 10 chars
  const tools = [{ type: "function" as const, function: { name: "read", parameters: { type: "object" } } }];
  assert.equal(estimateInputTokens([{ role: "user", content: "abcd" }], tools), Math.ceil((4 + JSON.stringify(tools).length) / 4));
  assert.equal(holdMc(cfg.net, M14, 512, 2), costMc(cfg.net, M14, 2, 512));
});

test("split: spec example (490 credits, 20/9/11 of 40 layers) and parts sum exactly", () => {
  const s = splitCost(cfg.net, 490_000, ROUTE, 40, () => "acc_other", "acc_me");
  assert.deepEqual(s, { nodes: { [A]: 220_500, [B]: 99_225, [C]: 121_275 }, burn_mc: 24_500, reserve_mc: 24_500 });
  assert.equal(sumSplit(s), 490_000);
});

test("split: rounding remainders go to reserve; sum is exact for many costs", () => {
  const s = splitCost(cfg.net, 592_201, ROUTE, 40, () => "acc_other", "acc_me");
  // nodes_share = floor(532980.9) = 532980; A floor(532980×20/40)=266490, B floor(×9/40)=119920 (119920.5), C floor(×11/40)=146569 (146569.5)
  assert.deepEqual(s.nodes, { [A]: 266_490, [B]: 119_920, [C]: 146_569 });
  assert.equal(s.burn_mc, 29_610);
  assert.equal(sumSplit(s), 592_201);
  for (let cost = 0; cost < 3000; cost += 7) assert.equal(sumSplit(splitCost(cfg.net, cost, ROUTE, 40, () => "x", "y")), cost);
});

test("split: self-request — the requester's own node gets 0, its share goes to reserve", () => {
  const owners: Record<string, string> = { [A]: "acc_me", [B]: "acc_other", [C]: "acc_other" };
  const s = splitCost(cfg.net, 490_000, ROUTE, 40, (n) => owners[n]!, "acc_me");
  assert.equal(s.nodes[A], 0);
  assert.equal(s.nodes[B], 99_225);
  assert.equal(s.reserve_mc, 24_500 + 220_500);
  assert.equal(sumSplit(s), 490_000);
  assert.equal(paysNode("acc_me", "acc_me"), false);
  assert.equal(paysNode("acc_me", null), true); // x402 requester has no account
});

test("split: unknown route → every node share goes to reserve", () => {
  const s = splitCost(cfg.net, 490_000, null, 40, () => null, "acc_me");
  assert.deepEqual(s, { nodes: {}, burn_mc: 24_500, reserve_mc: 465_500 });
});

test("hold / settle / release: starter first, then earned; owners credited; totals; event", () => {
  const db = openDb(":memory:");
  const me = loginOrCreate(db, cfg, signer, "0x01").accountId;
  const other = loginOrCreate(db, cfg, signer, "0x02").accountId;
  for (const [n, acc] of [[A, other], [B, other], [C, me]] as const) {
    db.prepare("INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at) VALUES (?, ?, 'p', 'g', 8, 1)").run(n, acc);
  }
  assert.equal(balance(db, me).starter_mc, 10_000_000);
  // starter 1000 mc left + 5000 earned
  db.prepare("UPDATE balances SET starter_mc = 1000, earned_mc = 5000 WHERE account_id = ?").run(me);
  assert.equal(availableMc(db, me), 6000);
  assert.equal(tryHold(db, me, 4000), true);
  assert.equal(balance(db, me).held_mc, 4000);
  assert.equal(availableMc(db, me), 2000);
  db.prepare("INSERT INTO requests (req_id, account_id, model, pay_type, route, status, prompt_hash, ts) VALUES ('req_1', ?, ?, 'credits', ?, 'pending', '0x00', 1)").run(me, M14.model_id, JSON.stringify(ROUTE));
  const r = settle(db, cfg.net, signer, { reqId: "req_1", accountId: me, model: M14, hold: 4000, inTokens: 5, outTokens: 1, route: ROUTE, promptHash: `0x${"ab".repeat(32)}`, respHash: `0x${"cd".repeat(32)}` });
  assert.equal(r.cost, 3500); // 1.75 × (1 + 1) = 3.5 credits
  const b = balance(db, me);
  assert.equal(b.held_mc, 0);
  assert.equal(b.starter_mc, 0); // starter spent first
  // earned: 5000 − 2500 (rest of cost) + own node C share 0 (self-request)
  assert.equal(b.earned_mc, 2500);
  assert.equal(b.spent_total_mc, 3500);
  assert.equal(r.split.nodes[C], 0);
  // nodes_share = floor(3500 × 0.9) = 3150; A floor(3150 × 20/40) = 1575, B floor(3150 × 9/40) = 708
  // SPEC §16.3: the owner's share vests first (locked), then becomes spendable.
  assert.equal(balance(db, other).earned_mc, 0);
  assert.equal(balance(db, other).locked_mc, 1575 + 708);
  assert.equal(balance(db, other).earned_total_mc, 1575 + 708);
  const ev = db.prepare("SELECT payload FROM ledger_events WHERE type = 'request_settled'").get() as { payload: string };
  const parsed = LedgerEvent.parse(JSON.parse(ev.payload));
  assert.equal(parsed.type === "request_settled" && parsed.cost_mc, 3500);
  const row = db.prepare("SELECT status, cost_mc FROM requests WHERE req_id = 'req_1'").get() as { status: string; cost_mc: number };
  assert.deepEqual({ ...row }, { status: "ok", cost_mc: 3500 });

  // failed request: release the whole hold, nothing spent
  assert.equal(tryHold(db, me, 2000), true);
  releaseHold(db, me, 2000);
  assert.equal(balance(db, me).held_mc, 0);
  assert.equal(balance(db, me).earned_mc, 2500);
  db.close();
});

test("settle never charges more than the hold", () => {
  const db = openDb(":memory:");
  const me = loginOrCreate(db, cfg, signer, "0x03").accountId;
  db.prepare("INSERT INTO requests (req_id, account_id, model, pay_type, route, status, prompt_hash, ts) VALUES ('req_2', ?, ?, 'credits', NULL, 'pending', '0x00', 1)").run(me, M8.model_id);
  assert.equal(tryHold(db, me, 1000), true);
  const r = settle(db, cfg.net, signer, { reqId: "req_2", accountId: me, model: M8, hold: 1000, inTokens: 100, outTokens: 50, route: null, promptHash: `0x${"ab".repeat(32)}`, respHash: `0x${"cd".repeat(32)}` });
  assert.equal(r.cost, 1000);
  assert.equal(r.split.reserve_mc + r.split.burn_mc, 1000);
  db.close();
});

test("insufficient credits: the hold is refused; holds of concurrent requests cannot overspend", () => {
  const db = openDb(":memory:");
  const me = loginOrCreate(db, cfg, signer, "0x04").accountId;
  db.prepare("UPDATE balances SET starter_mc = 10000 WHERE account_id = ?").run(me);
  const results = Array.from({ length: 5 }, () => tryHold(db, me, 3000));
  assert.deepEqual(results, [true, true, true, false, false]);
  assert.equal(balance(db, me).held_mc, 9000);
  assert.equal(tryHold(db, me, 1001), false);
  assert.equal(tryHold(db, me, 1000), true);
  db.close();
});

test("starter expiry: expired starter credits are not spendable and are zeroed with a credits_expired event", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  const me = loginOrCreate(db, cfg, signer, "0x05", now).accountId;
  const b = balance(db, me);
  assert.equal(b.starter_expires_at, now + 14 * 86_400_000);
  const later = b.starter_expires_at + 1;
  assert.equal(availableMc(db, me, later), 0);
  assert.equal(tryHold(db, me, 1, later), false);
  assert.equal(expireStarterCredits(db, signer, now), 0);
  assert.equal(expireStarterCredits(db, signer, later), 1);
  assert.equal(balance(db, me).starter_mc, 0);
  const ev = LedgerEvent.parse(JSON.parse((db.prepare("SELECT payload FROM ledger_events WHERE type = 'credits_expired'").get() as { payload: string }).payload));
  assert.equal(ev.type === "credits_expired" && ev.amount_mc, 10_000_000);
  assert.equal(expireStarterCredits(db, signer, later), 0);
  db.close();
});
