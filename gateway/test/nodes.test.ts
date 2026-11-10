import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes } from "viem";
import { ErrorResponse, HeartbeatResponse, LedgerEvent, MeResponse, NODE_SIGNATURE_HEADER, PoolStateResponse, Receipt, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { registerMessage } from "../src/nodes.ts";
import { validLayerMap } from "../src/route.ts";
import { balance, signer, testAccount, TEST_JWT_SECRET, testDirectory } from "./helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";
const POOL = "pool-test-1";
// Test node keys (not real).
const K = [1, 2, 3].map((i) => privateKeyToAccount(`0x${String(i).repeat(64)}` as `0x${string}`));
const id = (i: number) => K[i]!.address.toLowerCase();

// Fake Parallax with usage (non-streaming only here).
let fake: Server;
let fakeFail = false;
before(async () => {
  fake = createServer((req, res) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      if (fakeFail) { res.statusCode = 500; res.end("boom"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "x", choices: [{ index: 0, message: { role: "assistant", content: "Hi there. ".repeat(30) }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 100, total_tokens: 140 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
});
after(() => fake.close());

function setup() {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET });
  const db = openDb(":memory:");
  const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db, POOL, false), onComplete: () => {} });
  return { cfg, db, app };
}

async function register(app: ReturnType<typeof setup>["app"], auth: Record<string, string>, i: number, extra: Record<string, unknown> = {}) {
  const ts = Date.now();
  const node_sig = await K[i]!.signMessage({ message: registerMessage(id(i), POOL, ts) });
  return app.request("/nodes/register", {
    method: "POST", headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ node_id: id(i), pool_id: POOL, gpu: "RTX 4060", mem_gb: 8, ts, node_sig, payout_address: "provider.testnet", ...extra }),
  });
}

async function heartbeat(app: ReturnType<typeof setup>["app"], i: number, layers: [number, number] | null, over: Record<string, unknown> = {}) {
  const raw = JSON.stringify({ node_id: id(i), pool_id: POOL, ts: Date.now(), online: true, model: i === 0 ? MODEL : "Qwen/Qwen3-14B-MLX-8bit", layers, tok_s: 5.5, ...over });
  const sig = await K[i]!.signMessage({ message: { raw: new TextEncoder().encode(raw) } });
  return app.request("/nodes/heartbeat", { method: "POST", headers: { "content-type": "application/json", [NODE_SIGNATURE_HEADER]: sig }, body: raw });
}

const chat = (app: ReturnType<typeof setup>["app"], auth: Record<string, string>, max_tokens = 200) =>
  app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hello there" }], max_tokens }) });

const events = (db: Db, type: string) => (db.prepare("SELECT payload FROM ledger_events WHERE type = ? ORDER BY id").all(type) as { payload: string }[]).map((r) => LedgerEvent.parse(JSON.parse(r.payload)));

test("layer map validity: exact cover of [0, total) only", () => {
  const a = "0x" + "a".repeat(40), b = "0x" + "b".repeat(40);
  assert.deepEqual(validLayerMap([{ node_id: b, layers: [29, 40] }, { node_id: a, layers: [0, 29] }], 40), [{ node_id: a, layers: [0, 29] }, { node_id: b, layers: [29, 40] }]);
  assert.equal(validLayerMap([{ node_id: a, layers: [0, 29] }], 40), null); // gap
  assert.equal(validLayerMap([{ node_id: a, layers: [0, 30] }, { node_id: b, layers: [29, 40] }], 40), null); // overlap
  assert.equal(validLayerMap([{ node_id: a, layers: [1, 40] }], 40), null); // no layer 0
  assert.equal(validLayerMap([], 40), null);
});

test("register: node_sig checked, payout address set once (+ event), max 3 nodes, other account → 409", async () => {
  const { app, db, cfg } = setup();
  const owner = await testAccount(db, cfg);
  const r = await register(app, owner.auth, 0);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { node_id: id(0), account_id: owner.accountId, pool_id: POOL });
  assert.equal(events(db, "payout_address_set").length, 1);
  assert.equal((await register(app, owner.auth, 0)).status, 200); // idempotent, no new event
  assert.equal(events(db, "payout_address_set").length, 1);
  // bad signature (signed by another key)
  const ts = Date.now();
  const bad = await app.request("/nodes/register", { method: "POST", headers: { "content-type": "application/json", ...owner.auth }, body: JSON.stringify({ node_id: id(1), pool_id: POOL, gpu: "g", mem_gb: 8, ts, node_sig: await K[0]!.signMessage({ message: registerMessage(id(1), POOL, ts) }) }) });
  assert.equal(bad.status, 401);
  // old link
  const old = Date.now() - 25 * 3600 * 1000;
  const stale = await app.request("/nodes/register", { method: "POST", headers: { "content-type": "application/json", ...owner.auth }, body: JSON.stringify({ node_id: id(1), pool_id: POOL, gpu: "g", mem_gb: 8, ts: old, node_sig: await K[1]!.signMessage({ message: registerMessage(id(1), POOL, old) }) }) });
  assert.equal(stale.status, 400);
  const other = await testAccount(db, cfg);
  assert.equal((await register(app, other.auth, 0)).status, 409);
  // no session → 401
  assert.equal((await register(app, {}, 1)).status, 401);
  // limit: 3 nodes per account
  db.prepare("INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at) VALUES ('0x" + "9".repeat(40) + "', ?, ?, 'g', 1, 1), ('0x" + "8".repeat(40) + "', ?, ?, 'g', 1, 1)").run(owner.accountId, POOL, owner.accountId, POOL);
  const lim = await register(app, owner.auth, 1);
  assert.equal(lim.status, 403);
  assert.equal(ErrorResponse.parse(await lim.json()).error.code, "node_limit_reached");
  db.close();
});

test("heartbeat: signed raw body; bad sig / stale ts / unregistered rejected; counts uptime; returns owner + reliability", async () => {
  const { app, db, cfg } = setup();
  const owner = await testAccount(db, cfg);
  await register(app, owner.auth, 0);
  const r = await heartbeat(app, 0, [29, 40]);
  assert.equal(r.status, 200);
  const { challenge: _challenge, ...hbResp } = HeartbeatResponse.parse(await r.json()) as Record<string, unknown>; // challenge: 16.2 hardware check (random)
  assert.deepEqual(hbResp, { ok: true, owner_account: owner.accountId, reliability: 0.86, restart_id: 0, assigned_pool: null, probe: [] });
  const row = db.prepare("SELECT hb_layers, hb_model FROM nodes WHERE node_id = ?").get(id(0)) as { hb_layers: string; hb_model: string };
  assert.deepEqual(JSON.parse(row.hb_layers), [29, 40]);
  assert.equal((db.prepare("SELECT heartbeats_received AS n FROM node_reliability WHERE node_id = ?").get(id(0)) as { n: number }).n, 1);
  // tampered body: signature over different bytes
  const raw = JSON.stringify({ node_id: id(0), pool_id: POOL, ts: Date.now(), online: true, model: MODEL, layers: [0, 40], tok_s: 1 });
  const sig = await K[0]!.signMessage({ message: { raw: new TextEncoder().encode(raw) } });
  const tampered = await app.request("/nodes/heartbeat", { method: "POST", headers: { [NODE_SIGNATURE_HEADER]: sig }, body: raw.replace("[0,40]", "[0, 40]") });
  assert.equal(tampered.status, 401);
  assert.equal((await heartbeat(app, 0, [29, 40], { ts: Date.now() - 120_000 })).status, 400);
  assert.equal((await heartbeat(app, 1, [0, 29])).status, 404);
  db.close();
});

test("credits end to end: hold → settle → split to node owners by layers (self node 0), receipt, ledger event, /pools state", async () => {
  const { app, db, cfg } = setup();
  const provider = await testAccount(db, cfg);
  const user = await testAccount(db, cfg);
  await register(app, provider.auth, 0);
  await register(app, provider.auth, 1);
  await register(app, user.auth, 2); // the requester's own node
  // Fresh members but incomplete layer coverage → route unknown, shares go to reserve.
  await heartbeat(app, 0, [0, 10]);
  await heartbeat(app, 1, null);
  await heartbeat(app, 2, null);
  let r = await chat(app, user.auth);
  assert.equal(r.status, 200);
  let receipt = Receipt.parse(await (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  assert.equal(receipt.route, null);
  assert.deepEqual(receipt.split?.nodes, {});
  // 1.75 × (100 + 0.2 × 40) = 189 credits
  assert.equal(receipt.cost_mc, 189_000);
  assert.equal(receipt.split!.reserve_mc, 189_000 - 9450);

  // Heartbeats: 0 → [0,20) (GPU model id), 1 → [20,29), 2 → [29,40) (MLX variant).
  // Node 0 goes through "no layers" first (a rejoin); a direct online [0,10) → [0,20) change would be
  // a live re-placement and order a pool restart (post-MVP P5.5, tested in p5.test.ts).
  await heartbeat(app, 0, null);
  await heartbeat(app, 0, [0, 20]);
  await heartbeat(app, 1, [20, 29]);
  await heartbeat(app, 2, [29, 40]);
  const pool = PoolStateResponse.parse(await (await app.request(`/pools/${POOL}`)).json());
  assert.equal(pool.status, "ready");
  assert.deepEqual(pool.models, [MODEL]);
  assert.deepEqual(pool.layer_map?.map((h) => h.layers), [[0, 20], [20, 29], [29, 40]]);

  const before = balance(db, user.accountId);
  r = await chat(app, user.auth);
  assert.equal(r.status, 200);
  receipt = Receipt.parse(await (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.pay_type, "credits");
  assert.equal(receipt.cost_mc, 189_000);
  assert.equal(receipt.in_tokens, 40);
  assert.match(receipt.prompt_hash, /^0x[0-9a-f]{64}$/);
  // nodes_share = floor(189000 × 0.9) = 170100; 20/40 → 85050, 9/40 → 38272 (38272.5), own node 11/40 → 0
  assert.deepEqual(receipt.split!.nodes, { [id(0)]: 85_050, [id(1)]: 38_272, [id(2)]: 0 });
  assert.equal(receipt.split!.burn_mc, 9450);
  assert.equal(receipt.split!.reserve_mc, 189_000 - 85_050 - 38_272 - 9450);
  const after = balance(db, user.accountId);
  assert.equal(after.starter_mc, before.starter_mc - 189_000);
  assert.equal(after.held_mc, 0);
  assert.equal(after.spent_total_mc, 2 * 189_000);
  assert.equal(after.earned_mc, 0); // own node earns nothing
  assert.equal(balance(db, provider.accountId).locked_mc, 85_050 + 38_272); // SPEC §16.3: vesting
  const me = MeResponse.parse(await (await app.request("/me", { headers: provider.auth })).json());
  assert.equal(me.balance.earned_total_mc, 85_050 + 38_272);
  assert.equal(me.nodes.length, 2);
  assert.ok(me.nodes.every((n) => n.online));
  assert.ok(me.ratio > 0);
  const settled = events(db, "request_settled");
  assert.equal(settled.length, 2);
  assert.equal(settled[1]!.type === "request_settled" && settled[1]!.req_id, receipt.req_id);
  const rel = db.prepare("SELECT requests_routed, requests_ok FROM node_reliability WHERE node_id = ?").get(id(0)) as { requests_routed: number; requests_ok: number };
  assert.deepEqual({ ...rel }, { requests_routed: 1, requests_ok: 1 });
  const tr = db.prepare("SELECT prompt, response, expires_at FROM transcripts WHERE req_id = ?").get(receipt.req_id) as { prompt: string; response: string; expires_at: number };
  assert.equal(tr.response, "Hi there. ".repeat(30));
  assert.ok(tr.expires_at > Date.now() + 6 * 86_400_000);

  // Failed request: hold released, cost 0, reliability penalty, no settle event.
  fakeFail = true;
  r = await chat(app, user.auth);
  fakeFail = false;
  assert.equal(r.status, 502);
  receipt = Receipt.parse(await (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.cost_mc, null);
  assert.deepEqual(balance(db, user.accountId), after);
  // Post-MVP P5.2: one failover (same pool, the only one) → two failed attempts, each one counted.
  assert.deepEqual(receipt.attempts?.map((a) => [a.outcome, a.streamed_tokens]), [["pool_error", 0], ["pool_error", 0]]);
  const rel2 = db.prepare("SELECT requests_routed, requests_ok FROM node_reliability WHERE node_id = ?").get(id(0)) as { requests_routed: number; requests_ok: number };
  assert.deepEqual({ ...rel2 }, { requests_routed: 3, requests_ok: 1 });
  assert.equal(events(db, "request_settled").length, 2);
  db.close();
});

test("insufficient credits → 403 insufficient_credits (shared error shape), nothing forwarded or held", async () => {
  const { app, db, cfg } = setup();
  const user = await testAccount(db, cfg);
  await register(app, user.auth, 0);
  await heartbeat(app, 0, [0, 40]);
  db.prepare("UPDATE balances SET starter_mc = 1000 WHERE account_id = ?").run(user.accountId);
  const r = await chat(app, user.auth);
  assert.equal(r.status, 403);
  assert.equal(ErrorResponse.parse(await r.json()).error.code, "insufficient_credits");
  assert.equal(balance(db, user.accountId).held_mc, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM requests").get() as { n: number }).n, 0);
  db.close();
});
