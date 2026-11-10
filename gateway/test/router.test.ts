import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import type { DirectoryPool } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { createRouter, type Directory } from "../src/router.ts";
import { countPool, poolReliability, recordPoolUp, refreshPoolReliability } from "../src/reliability.ts";
import { poolContextLength, poolState } from "../src/route.ts";
import { balance, signer, testAccount, testDirectory, TEST_JWT_SECRET, TEST_NODE } from "./helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";

test("context minimum uses fresh nodes; stale/offline limits ignored and unknown limits stay optional", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    const now = Date.now();
    db.prepare("UPDATE nodes SET hb_max_seq = 16384").run();
    const other = "0x" + "d".repeat(40);
    db.prepare(`INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at, hb_ts, hb_online, hb_model, hb_max_seq)
      VALUES (?, 'acc_router', 'pool-router-test', 'fixture', 16, ?, ?, 1, ?, 8192)`).run(other, now, now, MODEL);
    assert.equal(poolContextLength(db, cfg.net, "pool-router-test", model, now), 8192);
    assert.equal(poolState(db, cfg, "pool-router-test", now).context_length, 8192);
    assert.equal((await createRouter(cfg, db, fake).models()).data.find((m) => m.id === MODEL)?.context_length, 8192);
    db.prepare("UPDATE nodes SET hb_ts = ? WHERE node_id = ?").run(now - 31_000, other);
    assert.equal(poolContextLength(db, cfg.net, "pool-router-test", model, now), 16384);
    db.prepare("UPDATE nodes SET hb_ts = ?, hb_online = 0 WHERE node_id = ?").run(now, other);
    assert.equal(poolContextLength(db, cfg.net, "pool-router-test", model, now), 16384);
    db.prepare("UPDATE nodes SET hb_online = 1, hb_max_seq = NULL WHERE node_id = ?").run(other);
    assert.equal(poolContextLength(db, cfg.net, "pool-router-test", model, now), undefined);
  } finally { db.close(); }
});
function setup() {
  const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET });
  const db = openDb(":memory:");
  const fake = testDirectory(cfg, db);
  return { cfg, db, fake, model: cfg.model(MODEL)! };
}

test("discovery requires both a catalog entry and a fresh ready pool; never probes Parallax", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    const catalog = (await fake.models()).filter((m) => m.model_id === MODEL);
    const directory: Directory = { ...fake, models: async () => catalog };
    const router = createRouter(cfg, db, directory);
    const result = await router.models();
    assert.deepEqual(result.data.map((m) => [m.id, m.pools, m.source]), [[MODEL, 1, "gateway"]]);
    assert.deepEqual((await createRouter(cfg, db, { ...directory, models: async () => [] }).models()).data, []);
    const selected = await router.select(model);
    assert.equal(selected?.poolId, "pool-router-test");
    assert.equal(selected?.coordinatorUrl, cfg.env.POOL_COORDINATOR_URL);
    assert.deepEqual(selected?.route, [{ node_id: TEST_NODE, layers: [0, 40] }]);
    db.prepare("UPDATE nodes SET hb_ts = ?").run(Date.now() - 31_000);
    assert.equal(await router.select(model), null);
    assert.deepEqual((await router.models()).data, []);
  } finally { db.close(); }
});

test("pool availability follows model discovery and reports routing failures", async () => {
  const { cfg, db, fake } = setup();
  try {
    const router = createRouter(cfg, db, fake);
    assert.equal((await router.availability("pool-router-test", MODEL)).available, true);
    assert.equal((await router.models()).data.some(entry => entry.id === MODEL), true);
    db.prepare("UPDATE nodes SET hb_online = 0 WHERE node_id = ?").run(TEST_NODE);
    const offline = await router.availability("pool-router-test", MODEL);
    assert.equal(offline.available, false);
    assert.match(offline.reason, /offline/i);
    assert.equal((await router.models()).data.some(entry => entry.id === MODEL), false);
    const missing = await createRouter(cfg, db, { ...fake, models: async () => [] }).availability("pool-router-test", MODEL);
    assert.equal(missing.available, false);
    assert.match(missing.reason, /model.*directory/i);
    await assert.rejects(() => createRouter(cfg, db, { ...fake, models: async () => { throw new Error("directory unavailable"); } }).availability("pool-router-test", MODEL));
  } finally { db.close(); }
});

test("router rejects offline, wrong-model, unknown URL, unregistered, wrong-pool, and stale-member listings", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    const base = (await fake.readyPools(MODEL))[0]!;
    const wrong = "0x" + "e".repeat(40);
    const cases: Partial<DirectoryPool>[] = [
      { status: "loading" }, { models: ["unknown"] }, { members: [] },
      { coordinator_url_hash: keccak256(toBytes("http://unknown:3001")) },
      { members: [wrong] }, { pool_id: "another-pool" }, { members: [TEST_NODE, wrong] },
    ];
    for (const change of cases) {
      const router = createRouter(cfg, db, { ...fake, readyPools: async () => [{ ...base, ...change }] });
      assert.equal(await router.select(model), null, JSON.stringify(change));
    }
    db.prepare("UPDATE nodes SET hb_model = 'Qwen/Qwen3-8B'").run();
    assert.equal(await createRouter(cfg, db, fake).select(model), null);
    db.prepare("UPDATE nodes SET hb_online = 0").run();
    assert.equal(await createRouter(cfg, db, fake).select(model), null);
  } finally { db.close(); }
});

test("score uses the pool's own reliability (SPEC §9.2) and active request load; release is idempotent", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    const a = (await fake.readyPools(MODEL))[0]!;
    const bNode = "0x" + "b".repeat(40);
    db.prepare(`INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at, hb_ts, hb_online, hb_model, hb_layers)
      VALUES (?, 'acc_router', 'pool-b', 'fixture', 8, ?, ?, 1, ?, '[0,40]')`).run(bNode, Date.now(), Date.now(), MODEL);
    const now = Date.now();
    // Pool A served its requests; pool B failed half of them.
    for (let i = 0; i < 4; i++) countPool(db, cfg, a.pool_id, true, now - 1000);
    for (let i = 0; i < 4; i++) countPool(db, cfg, "pool-b", i % 2 === 0, now - 1000);
    const b = { ...a, pool_id: "pool-b", members: [bNode] };
    const router = createRouter(cfg, db, { ...fake, readyPools: async () => [b, a, a] });
    assert.equal((await router.select(model))?.poolId, a.pool_id);
    assert.equal((await router.models()).data.find((m) => m.id === MODEL)?.pools, 2);
    const release = router.start(a.pool_id);
    assert.equal((await router.select(model))?.poolId, b.pool_id); // busy A (load 0.5) loses to idle B
    release(); release();
    assert.equal((await router.select(model))?.poolId, a.pool_id);
    // A weak member node no longer sets the pool score: the pool keeps its own record.
    db.prepare("INSERT INTO node_reliability (node_id, score, updated_at) VALUES (?, 0.1, ?)").run(TEST_NODE, now);
    const score = (await router.select(model))?.score;
    assert.equal(score, poolReliability(db, cfg, a.pool_id));
    assert.ok(score! > 0.9, `pool score ${score} must not drop to the node's 0.1`);
  } finally { db.close(); }
});

test("batching: load = running requests / slots, so a pool at 1 of 4 slots is 25 % loaded", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    const four = { ...cfg, net: { ...cfg.net, router: { ...cfg.net.router, max_concurrent_per_pool: 4 } } };
    const listing = (await fake.readyPools(MODEL))[0]!;
    const pool = listing.pool_id;
    const router = createRouter(four, db, { ...fake, pools: async () => [listing] });
    const idle = (await router.select(model))!.score;
    const releases = [router.start(pool)];
    assert.ok(Math.abs((await router.select(model))!.score - idle * 0.75) < 1e-9);
    assert.equal((await router.network()).pools[0]!.load, 0.25);
    for (let i = 0; i < 4; i++) releases.push(router.start(pool));
    // Over the slot count the load stays 1: the pool is still a candidate and the queue makes callers wait.
    assert.equal((await router.network()).pools[0]!.load, 1);
    assert.equal((await router.select(model))!.score, 0);
    releases.forEach((r) => r());
    assert.equal((await router.select(model))!.score, idle);
  } finally { db.close(); }
});

test("pool reliability: 0.7 × pool success + 0.3 × pool uptime; new pool starts at initial score", () => {
  const { cfg, db } = setup();
  try {
    const interval = cfg.env.HEARTBEAT_SECONDS * 1000;
    const t0 = Math.floor(Date.now() / interval) * interval;
    assert.equal(poolReliability(db, cfg, "pool-new", t0), cfg.net.reliability.initial_score);
    // 3 of 4 requests served; complete in 5 of 10 slots.
    countPool(db, cfg, "pool-r", true, t0); countPool(db, cfg, "pool-r", true, t0); countPool(db, cfg, "pool-r", true, t0); countPool(db, cfg, "pool-r", false, t0);
    for (let k = 0; k < 10; k += 2) recordPoolUp(db, cfg, "pool-r", t0 + k * interval);
    const score = refreshPoolReliability(db, cfg, "pool-r", t0 + 10 * interval + 1);
    const row = db.prepare("SELECT requests_routed, requests_ok, slots_expected, slots_up FROM pool_reliability WHERE pool_id = 'pool-r'").get() as Record<string, number>;
    assert.deepEqual(row, { requests_routed: 4, requests_ok: 3, slots_expected: 10, slots_up: 5 });
    assert.equal(score, Math.round((0.7 * 0.75 + 0.3 * 0.5) * 1e12) / 1e12);
  } finally { db.close(); }
});

test("receipt route stays scoped to selected pool; incomplete heartbeat coverage stays unknown", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    db.prepare("UPDATE nodes SET hb_layers = '[0,20]'").run();
    const selected = await createRouter(cfg, db, fake).select(model);
    assert.ok(selected);
    assert.equal(selected.route, null);
  } finally { db.close(); }
});

test("no pools / directory outage → 503 + Retry-After before a credit hold, payment, or inference", async () => {
  const { cfg, db, fake } = setup();
  try {
    const account = await testAccount(db, cfg);
    let charges = 0;
    for (const unavailable of [async () => [], async () => { throw new Error("RPC unavailable"); }]) {
      const app = createApp({ cfg, db, signer, directory: { ...fake, readyPools: unavailable },
        x402: { charge: async () => { charges++; throw new Error("must not charge"); }, topup: async () => { throw new Error("unused"); } } });
      for (const auth of [account.auth, {}]) {
        const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hello" }] }) });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("Retry-After"), String(cfg.net.router.retry_after_s));
        assert.equal((await response.json()).error.code, "no_pool_available");
      }
      assert.equal(balance(db, account.accountId).held_mc, 0);
      assert.equal((db.prepare("SELECT count(*) AS n FROM requests").get() as { n: number }).n, 0);
    }
    assert.equal(charges, 0);
    const app = createApp({ cfg, db, signer, directory: { ...fake, models: async () => { throw new Error("offline"); } } });
    const res = await app.request("/v1/models");
    assert.equal(res.status, 503);
    assert.ok(res.headers.get("Retry-After"));
  } finally { db.close(); }
});

test("billing credits only the selected directory pool, ignoring another pool and the advertised layer map", async () => {
  const { cfg, db, fake } = setup();
  const originalFetch = globalThis.fetch;
  try {
    const other = "0x" + "a".repeat(40);
    db.prepare(`INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at, hb_ts, hb_online, hb_model, hb_layers)
      VALUES (?, 'acc_router', 'aaa-other-pool', 'fixture', 8, ?, ?, 1, ?, '[0,40]')`).run(other, Date.now(), Date.now(), MODEL);
    const account = await testAccount(db, cfg);
    let forwarded = "";
    globalThis.fetch = async (url) => {
      forwarded = String(url);
      return Response.json({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
    };
    const app = createApp({ cfg, db, signer, onComplete: () => {}, directory: { ...fake,
      readyPools: async (model) => (await fake.readyPools(model)).map((p) => ({ ...p, layer_map: [{ node_id: other, layers: [0, 40] }] })) } });
    const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...account.auth },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(response.status, 200);
    assert.equal(forwarded, "http://127.0.0.1:3001/v1/chat/completions");
    const receipt = await (await app.request(`/requests/${response.headers.get("x-ramx-request-id")}`)).json();
    assert.deepEqual(receipt.route, [{ node_id: TEST_NODE, layers: [0, 40] }]);
    assert.deepEqual(Object.keys(receipt.split.nodes), [TEST_NODE]);
    assert.ok(balance(db, "acc_router").locked_mc > 0); // SPEC §16.3: earnings vest first
    assert.equal(balance(db, account.accountId).held_mc, 0);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("P5.7: a pool with a swapping member loses the score race to a healthy pool, but stays routable alone", async () => {
  const { cfg, db, fake, model } = setup();
  try {
    const a = (await fake.readyPools(MODEL))[0]!;
    const bNode = "0x" + "c".repeat(40);
    db.prepare(`INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at, hb_ts, hb_online, hb_model, hb_layers)
      VALUES (?, 'acc_router', 'pool-b', 'fixture', 8, ?, ?, 1, ?, '[0,40]')`).run(bNode, Date.now(), Date.now(), MODEL);
    const b = { ...a, pool_id: "pool-b", members: [bNode] };
    // Pool A's member swaps; A would otherwise win the alphabetical tie-break.
    db.prepare("UPDATE nodes SET hb_mem_pressure = 'swap_growing' WHERE pool_id = ?").run(a.pool_id);
    const both = createRouter(cfg, db, { ...fake, readyPools: async () => [a, b] });
    assert.equal((await both.select(model))?.poolId, "pool-b");
    const alone = createRouter(cfg, db, { ...fake, readyPools: async () => [a] });
    assert.equal((await alone.select(model))?.poolId, a.pool_id, "still served when it is the only pool");
  } finally { db.close(); }
});
