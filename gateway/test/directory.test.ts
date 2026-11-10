import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { DirectoryNode, DirectoryPool, ModelsResponse, NetworkResponse, NODE_SIGNATURE_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { registerMessage } from "../src/nodes.ts";
import { gatewayDirectory, LISTING_TTL_MS } from "../src/directory.ts";
import { urlHash } from "../src/formation.ts";
import { signer, testAccount, TEST_JWT_SECRET } from "./helpers.ts";

/**
 * Phase 4: the gateway is the directory. These tests use NO injected directory: listings come only
 * from real signed heartbeats sent to POST /nodes/heartbeat.
 */
const MODEL = "Qwen/Qwen3-14B-FP8";
const POOL = "pool-dir-1";
const K = [4, 5, 6].map((i) => privateKeyToAccount(`0x${String(i).repeat(64)}` as `0x${string}`));
const id = (i: number) => K[i]!.address.toLowerCase();

let fake: Server;
before(async () => {
  fake = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "x", choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
});
after(() => fake.close());

function setup() {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET });
  const db = openDb(":memory:");
  const app = createApp({ cfg, db, signer, onComplete: () => {} }); // default = gatewayDirectory
  return { cfg, db, app, dir: gatewayDirectory(cfg, db) };
}

async function register(app: ReturnType<typeof setup>["app"], auth: Record<string, string>, i: number) {
  const ts = Date.now();
  const node_sig = await K[i]!.signMessage({ message: registerMessage(id(i), POOL, ts) });
  const r = await app.request("/nodes/register", { method: "POST", headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ node_id: id(i), pool_id: POOL, gpu: i === 0 ? "RTX 4060" : "Apple M4", mem_gb: 16, ts, node_sig, payout_address: "provider.testnet" }) });
  assert.equal(r.status, 200, await r.clone().text());
}

async function heartbeat(app: ReturnType<typeof setup>["app"], i: number, layers: [number, number] | null, online = true) {
  const raw = JSON.stringify({ node_id: id(i), pool_id: POOL, ts: Date.now(), online, model: i === 0 ? MODEL : "Qwen/Qwen3-14B-MLX-8bit", layers, tok_s: 5.5 });
  const sig = await K[i]!.signMessage({ message: { raw: new TextEncoder().encode(raw) } });
  const r = await app.request("/nodes/heartbeat", { method: "POST", headers: { "content-type": "application/json", [NODE_SIGNATURE_HEADER]: sig }, body: raw });
  assert.equal(r.status, 200, await r.clone().text());
}

test("signed heartbeats alone make a pool listed, then ready once the layers cover the model exactly once", async () => {
  const { cfg, db, app, dir } = setup();
  try {
    const owner = await testAccount(db, cfg);
    await register(app, owner.auth, 0);
    await register(app, owner.auth, 1);
    assert.deepEqual(await dir.pools(), [], "registered but silent nodes are not listed");

    await heartbeat(app, 0, [0, 29]);
    let pools = await dir.pools();
    assert.equal(pools.length, 1);
    assert.equal(pools[0]!.status, "loading", "half the layers: listed, not ready");
    assert.deepEqual(await dir.readyPools(MODEL), []);

    await heartbeat(app, 1, [29, 40]);
    pools = await dir.pools();
    const pool = DirectoryPool.parse(pools[0]);
    assert.equal(pool.status, "ready");
    assert.deepEqual(pool.models, [MODEL]);
    assert.deepEqual(pool.members, [id(0), id(1)].sort());
    assert.deepEqual(pool.layer_map, [{ node_id: id(0), layers: [0, 29] }, { node_id: id(1), layers: [29, 40] }]);
    assert.equal(pool.coordinator_url_hash, urlHash(cfg.env.POOL_COORDINATOR_URL), "hash of the coordinator the router will use");
    assert.deepEqual((await dir.readyPools(MODEL)).map((p) => p.pool_id), [POOL]);
    assert.deepEqual(await dir.readyPools("Qwen/Qwen3-8B-FP8"), []);

    const nodes = (await dir.nodes()).map((n) => DirectoryNode.parse(n));
    assert.deepEqual(nodes.map((n) => [n.node_id, n.status, n.layers, n.owner_account]), [
      [id(0), "online", [0, 29], owner.accountId], [id(1), "online", [29, 40], owner.accountId]].sort());
  } finally { db.close(); }
});

test("/v1/models and /network are served from the gateway directory; a request routes to the listed pool", async () => {
  const { cfg, db, app } = setup();
  try {
    const owner = await testAccount(db, cfg);
    await register(app, owner.auth, 0);
    await register(app, owner.auth, 1);
    await heartbeat(app, 0, [0, 29]);
    await heartbeat(app, 1, [29, 40]);
    const models = ModelsResponse.parse(await (await app.request("/v1/models")).json());
    assert.deepEqual(models.data.map((m) => [m.id, m.pools, m.source]), [[MODEL, 1, "gateway"]]);
    const network = NetworkResponse.parse(await (await app.request("/network")).json());
    assert.equal(network.source, "gateway");
    assert.deepEqual(network.pools.map((p) => [p.pool_id, p.status]), [[POOL, "ready"]]);
    assert.equal(network.nodes.length, 2);
    assert.ok(network.stats.some((s) => s.account_id === owner.accountId));
    assert.ok(!JSON.stringify(network).includes(cfg.env.POOL_COORDINATOR_URL), "the private coordinator URL never leaks");
    const r = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...owner.auth },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 64 }) });
    assert.equal(r.status, 200, await r.clone().text());
  } finally { db.close(); }
});

test("listings expire after the TTL; offline nodes are listed as offline; banned owners are not listed", async () => {
  const { cfg, db, app, dir } = setup();
  try {
    const owner = await testAccount(db, cfg);
    await register(app, owner.auth, 0);
    await register(app, owner.auth, 1);
    await heartbeat(app, 0, [0, 29]);
    await heartbeat(app, 1, [29, 40], false);
    const byId = new Map((await dir.nodes()).map((n) => [n.node_id, n]));
    assert.equal(byId.get(id(1))!.status, "offline");
    assert.equal(byId.get(id(1))!.layers, null);
    assert.notEqual((await dir.pools())[0]!.status, "ready");

    db.prepare("UPDATE nodes SET hb_ts = ? WHERE node_id = ?").run(Date.now() - LISTING_TTL_MS - 1, id(1));
    assert.deepEqual((await dir.nodes()).map((n) => n.node_id), [id(0)], "the silent node's listing expired");

    db.prepare("UPDATE nodes SET banned = 1 WHERE node_id = ?").run(id(0));
    assert.deepEqual(await dir.nodes(), []);
    assert.deepEqual(await dir.pools(), []);
  } finally { db.close(); }
});
