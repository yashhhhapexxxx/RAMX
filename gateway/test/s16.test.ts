import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { HeartbeatResponse, NODE_SIGNATURE_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { registerMessage } from "../src/nodes.ts";
import { createPoolQueue } from "../src/queue.ts";
import { dhtPrefix, poolPlan, urlHash } from "../src/formation.ts";
import type { Directory } from "../src/router.ts";
import { signer, testAccount, TEST_JWT_SECRET } from "./helpers.ts";

/** SPEC §16.1 items built on the MVP model (docs/SECTION16_REPORT.md). */
const MODEL = "Qwen/Qwen3-14B-FP8";
const K = [1, 2, 3, 4].map((i) => privateKeyToAccount(`0x${String(i + 5).repeat(64)}` as `0x${string}`));
const id = (i: number) => K[i]!.address.toLowerCase() as `0x${string}`;

// Two fake schedulers (two pools); each answers with its own name.
const servers: Server[] = [];
const hits: string[] = [];
const fakeUrl = (i: number) => `http://127.0.0.1:${(servers[i]!.address() as AddressInfo).port}`;
before(async () => {
  for (const name of ["A", "B"]) {
    const s = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        hits.push(name);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "x", choices: [{ index: 0, message: { role: "assistant", content: name }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
  }
});
after(() => servers.forEach((s) => s.close()));

type Listing = { pool_id: string; url: string };

async function setup(listings: Listing[], env: Record<string, string> = {}) {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: fakeUrl(0), DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET, ...env });
  const db = openDb(":memory:");
  const members = (pool: string) => (db.prepare("SELECT node_id FROM nodes WHERE pool_id = ?").all(pool) as { node_id: string }[]).map((n) => n.node_id);
  const toListing = (l: Listing) => ({ type: "ramx.pool" as const, reliability: 0.8, pool_id: l.pool_id, models: [MODEL], status: "ready" as const, coordinator_url_hash: urlHash(l.url), layer_map: null, members: members(l.pool_id) });
  const directory: Directory = {
    models: async () => cfg.net.models.map((m) => ({ ...m, type: "ramx.model" as const })),
    pools: async () => listings.map(toListing), nodes: async () => [], readyPools: async () => listings.map(toListing),
  };
  const app = createApp({ cfg, db, signer, directory, onComplete: () => {} });
  const owner = await testAccount(db, cfg);
  const other = await testAccount(db, cfg);
  const register = async (i: number, pool: string, auth = owner.auth) => {
    const ts = Date.now();
    const node_sig = await K[i]!.signMessage({ message: registerMessage(id(i), pool, ts) });
    const r = await app.request("/nodes/register", { method: "POST", headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ node_id: id(i), pool_id: pool, gpu: "M4", mem_gb: 16, ts, node_sig, payout_address: "provider.testnet" }) });
    assert.equal(r.status, 200, await r.clone().text());
  };
  const hb = async (i: number, pool: string, layers: [number, number] | null, over: Record<string, unknown> = {}) => {
    const raw = JSON.stringify({ node_id: id(i), pool_id: pool, ts: Date.now(), online: true, model: MODEL, layers, tok_s: null, ...over });
    const sig = await K[i]!.signMessage({ message: { raw: new TextEncoder().encode(raw) } });
    const r = await app.request("/nodes/heartbeat", { method: "POST", headers: { "content-type": "application/json", [NODE_SIGNATURE_HEADER]: sig }, body: raw });
    assert.equal(r.status, 200, await r.clone().text());
    return HeartbeatResponse.parse(await r.json());
  };
  const chat = (headers: Record<string, string> = {}, auth = owner.auth) => app.request("/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", ...auth, ...headers }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 20 }) });
  return { cfg, db, app, owner, other, register, hb, chat };
}

test("batching: max_concurrent_per_pool slots run at once; the next waits for a free slot", async () => {
  const q = createPoolQueue(2);
  const sig = new AbortController().signal;
  const r1 = await q.acquire("p", 1, sig);
  await q.acquire("p", 1, sig);
  let third = false;
  const p3 = q.acquire("p", 1, sig).then((rel) => { third = true; return rel; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(third, false, "two slots busy");
  r1();
  (await p3)();
  assert.equal(third, true);
});

test("batching: 4 slots admit 4 requests at once; waiters get freed slots in ratio order", async () => {
  const q = createPoolQueue(4);
  const sig = new AbortController().signal;
  const running = await Promise.all([1, 1, 1, 1].map((r) => q.acquire("p", r, sig)));
  const order: string[] = [];
  const low = q.acquire("p", 0.5, sig).then((rel) => { order.push("low"); return rel; });
  const high = q.acquire("p", 2, sig).then((rel) => { order.push("high"); return rel; });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, [], "four slots busy");
  assert.equal(q.queued(["p"]), 2);
  running[0]!();
  (await high)();
  assert.deepEqual(order, ["high"]);
  running[1]!();
  (await low)();
  assert.deepEqual(order, ["high", "low"]);
  running.slice(2).forEach((r) => r());
  assert.equal(q.isIdle("p"), true);
});

test("many pools: each pool routes to its own private coordinator (POOL_COORDINATORS)", async () => {
  const s = await setup([{ pool_id: "pool-a", url: fakeUrl(0) }, { pool_id: "pool-b", url: fakeUrl(1) }],
    { POOL_COORDINATORS: JSON.stringify({ "pool-b": fakeUrl(1) }) });
  await s.register(0, "pool-b");
  await s.hb(0, "pool-b", [0, 40]);
  hits.length = 0;
  const r = await s.chat();
  assert.equal(r.status, 200);
  assert.deepEqual(hits, ["B"], "pool-b's scheduler answered");
  // A listing whose hash does not match the pool's configured coordinator is not reachable.
  const t = await setup([{ pool_id: "pool-b", url: fakeUrl(0) }], { POOL_COORDINATORS: JSON.stringify({ "pool-b": fakeUrl(1) }) });
  await t.register(0, "pool-b");
  await t.hb(0, "pool-b", [0, 40]);
  assert.equal((await t.chat()).status, 503);
  s.db.close(); t.db.close();
});

test("automatic pool formation: auto nodes measure delay, the gateway groups them (< 5 ms) and assigns a pool", async () => {
  const s = await setup([]);
  for (const i of [0, 1, 2]) await s.register(i, "auto");
  const base = { lan_ip: "10.0.0.1", p2p_port: 5101 };
  // First heartbeats: memory + address; the gateway hands out probes.
  await s.hb(0, "auto", null, { ...base, lan_ip: "10.0.0.10", usable_mem_gb: 12 });
  await s.hb(1, "auto", null, { ...base, lan_ip: "10.0.0.11", usable_mem_gb: 12 });
  const h2 = await s.hb(2, "auto", null, { ...base, lan_ip: "10.0.0.12", usable_mem_gb: 4 });
  assert.deepEqual(h2.probe.map((p) => p.node_id).sort(), [id(0), id(1)].sort());
  assert.equal(h2.assigned_pool, null);
  // Nodes 0 and 1 are 1 ms apart; node 2 is 40 ms away.
  await s.hb(2, "auto", null, { usable_mem_gb: 4, rtt_ms: { [id(0)]: 40, [id(1)]: 41 } });
  const h0 = await s.hb(0, "auto", null, { usable_mem_gb: 12, rtt_ms: { [id(1)]: 1.2 } });
  assert.ok(h0.assigned_pool, "pool formed");
  assert.equal(h0.assigned_pool!.model, MODEL, "24 GB holds the 14B model (16.3 GB × 1.2)");
  assert.equal(h0.assigned_pool!.dht_prefix, dhtPrefix(s.cfg, h0.assigned_pool!.pool_id));
  const plan = poolPlan(s.db, s.cfg);
  assert.deepEqual(plan.pools[0]!.members.sort(), [id(0), id(1)].sort());
  assert.deepEqual(plan.waiting, [id(2)]);
  // The node now heartbeats with its assigned pool; "auto" is still accepted until it learns it.
  assert.equal((await s.hb(1, "auto", null, { usable_mem_gb: 12 })).assigned_pool?.pool_id, h0.assigned_pool!.pool_id);
  await s.hb(1, h0.assigned_pool!.pool_id, null);
  // Re-registering as "auto" keeps the assignment.
  await s.register(0, "auto");
  assert.equal((s.db.prepare("SELECT pool_id FROM nodes WHERE node_id = ?").get(id(0)) as { pool_id: string }).pool_id, h0.assigned_pool!.pool_id);
  // The plan (with private DHT names) is for the gateway host only.
  assert.equal((await s.app.request("/pools/plan")).status, 403);
  s.db.close();
});

test("privacy: x-ramx-privacy: trusted-ends needs the first and last layers on trusted nodes", async () => {
  const s = await setup([{ pool_id: "pool-p", url: fakeUrl(0) }]);
  await s.register(0, "pool-p");                 // owner's node: layers [0, 20)
  await s.register(1, "pool-p", s.other.auth);   // a stranger's node: layers [20, 40)
  await s.hb(0, "pool-p", [0, 20]);
  await s.hb(1, "pool-p", [20, 40]);
  assert.equal((await s.chat({ "x-ramx-privacy": "nope" })).status, 400);
  assert.equal((await s.chat()).status, 200, "no header: normal routing");
  assert.equal((await s.chat({ "x-ramx-privacy": "trusted-ends" })).status, 503, "last layers on a stranger's node");
  // The stranger's account is trusted by the operator → allowed.
  const t = await setup([{ pool_id: "pool-p", url: fakeUrl(0) }]);
  await t.register(0, "pool-p");
  await t.register(1, "pool-p", t.other.auth);
  await t.hb(0, "pool-p", [0, 20]);
  await t.hb(1, "pool-p", [20, 40]);
  t.cfg.env.TRUSTED_ACCOUNTS = t.other.accountId;
  assert.equal((await t.chat({ "x-ramx-privacy": "trusted-ends" })).status, 200);
  s.db.close(); t.db.close();
});
