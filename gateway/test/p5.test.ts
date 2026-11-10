import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HeartbeatResponse, NetworkResponse, NODE_SIGNATURE_HEADER, PoolStateResponse, Receipt, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { registerMessage } from "../src/nodes.ts";
import { readRouteLog } from "../src/pools.ts";
import type { Directory } from "../src/router.ts";
import { signer, testAccount, TEST_JWT_SECRET } from "./helpers.ts";

/** Post-MVP P5.4 / P5.5 / P5.7 / P5.8 / P5.9 gateway behaviour (docs/POST_MVP_PLAN.md). */
const MODEL = "Qwen/Qwen3-14B-FP8";
const POOL = "pool-p5";
const K = [1, 2, 3].map((i) => privateKeyToAccount(`0x${String(i + 4).repeat(64)}` as `0x${string}`));
const id = (i: number) => K[i]!.address.toLowerCase();
const PEER = ["12D3KooWpeerA", "12D3KooWpeerB", "12D3KooWpeerC"];

// Fake Parallax: plays the scheduler hook — logs the route of a tagged request (P5.8).
let fake: Server;
let routeLog = "";
let routeTable: string[] = [];
const bodies: any[] = [];
before(async () => {
  fake = createServer((req, res) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      const body = JSON.parse(s);
      bodies.push(body);
      if (body.ramx_req_id && routeLog) {
        appendFileSync(routeLog, JSON.stringify({ ramx_req_id: body.ramx_req_id, parallax_request_id: "uuid", routing_table: routeTable, ts: Date.now() }) + "\n");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "x", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
});
after(() => fake.close());

async function setup(withHooks = false) {
  const dir = mkdtempSync(join(tmpdir(), "ramx-p5-"));
  routeLog = withHooks ? join(dir, "routes.jsonl") : "";
  const env: Record<string, string> = { POOL_COORDINATOR_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET };
  if (withHooks) Object.assign(env, { PARALLAX_ROUTE_LOG: routeLog, PARALLAX_ALLOWED_PEERS_FILE: join(dir, "allowed-peers.json") });
  const cfg = loadConfig(env);
  const db = openDb(":memory:");
  const urlHash = keccak256(toBytes(cfg.env.POOL_COORDINATOR_URL));
  const listing = () => ({ type: "ramx.pool" as const, reliability: 0.8, pool_id: POOL, models: [MODEL], status: "ready" as const, coordinator_url_hash: urlHash, layer_map: null,
    members: (db.prepare("SELECT node_id FROM nodes WHERE pool_id = ?").all(POOL) as { node_id: string }[]).map((n) => n.node_id) });
  const directory: Directory = {
    models: async () => cfg.net.models.map((m) => ({ ...m, type: "ramx.model" as const })),
    pools: async () => [listing()],
    nodes: async () => [],
    readyPools: async () => [listing()],
  };
  const app = createApp({ cfg, db, signer, directory, onComplete: () => {} });
  const owner = await testAccount(db, cfg);
  const user = await testAccount(db, cfg);
  for (let i = 0; i < 3; i++) {
    const ts = Date.now();
    const node_sig = await K[i]!.signMessage({ message: registerMessage(id(i), POOL, ts) });
    const r = await app.request("/nodes/register", { method: "POST", headers: { "content-type": "application/json", ...owner.auth },
      body: JSON.stringify({ node_id: id(i), pool_id: POOL, gpu: "RTX 4060", mem_gb: 8, ts, node_sig, payout_address: "provider.testnet" }) });
    assert.equal(r.status, 200);
  }
  const hb = async (i: number, layers: [number, number] | null, over: Record<string, unknown> = {}) => {
    const raw = JSON.stringify({ node_id: id(i), pool_id: POOL, ts: Date.now(), online: true, model: MODEL, layers, tok_s: null, peer_id: PEER[i], ...over });
    const sig = await K[i]!.signMessage({ message: { raw: new TextEncoder().encode(raw) } });
    const r = await app.request("/nodes/heartbeat", { method: "POST", headers: { "content-type": "application/json", [NODE_SIGNATURE_HEADER]: sig }, body: raw });
    assert.equal(r.status, 200, await r.clone().text());
    return HeartbeatResponse.parse(await r.json());
  };
  const ready = async (ack = 0) => { await hb(0, [0, 20], { restart_ack: ack }); await hb(1, [20, 29], { restart_ack: ack }); await hb(2, [29, 40], { restart_ack: ack }); };
  const chat = () => app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...user.auth },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 50 }) });
  const poolState = async () => PoolStateResponse.parse(await (await app.request(`/pools/${POOL}`)).json());
  return { cfg, db, app, hb, ready, chat, poolState, dir };
}

test("P5.5: a live re-placement orders one clean pool restart; router skips the pool until every member acks", async () => {
  const s = await setup();
  await s.ready();
  assert.equal((await s.chat()).status, 200);
  assert.equal((await s.poolState()).status, "ready");

  // Node 1 changes layers while online: Parallax re-placed it live.
  const r = await s.hb(1, [20, 30]);
  assert.equal(r.restart_id, 1, "restart ordered");
  assert.equal((await s.hb(0, [0, 20])).restart_id, 1, "every member gets the order");
  const st = await s.poolState();
  assert.equal(st.restarting, true);
  assert.equal(st.status, "loading");
  assert.equal((await s.chat()).status, 503, "router skips a restarting pool");

  // Cool-down: another live change does not order a second restart.
  assert.equal((await s.hb(2, [30, 40])).restart_id, 1);

  // Members restart (offline → rejoin) and ack the restart ID.
  for (const i of [0, 1, 2]) await s.hb(i, null, { online: false, restart_ack: 1 });
  await s.ready(1);
  assert.equal((await s.poolState()).restarting, false);
  assert.equal((await s.chat()).status, 200);
  s.db.close();
});

test("P5.5: an unacknowledged restart stops blocking after restart_timeout_s", async () => {
  const s = await setup();
  await s.ready();
  await s.hb(1, [20, 30]);
  assert.equal((await s.poolState()).restarting, true);
  s.db.prepare("UPDATE pools SET restart_at = ?").run(Date.now() - (s.cfg.net.resilience.restart_timeout_s + 1) * 1000);
  assert.equal((await s.poolState()).restarting, false);
  s.db.close();
});

test("P5.7: a member that swaps while serving degrades its pool's score but keeps it routable", async () => {
  const s = await setup();
  await s.ready();
  await s.hb(2, [29, 40], { mem_pressure: "swap_growing", usable_mem_gb: 11.5 });
  // The only pool stays usable (slower is better than no answer); with other pools it would lose the score race.
  assert.equal((await s.chat()).status, 200);
  await s.hb(2, [29, 40], { mem_pressure: "ok" });
  assert.equal((await s.chat()).status, 200);
  s.db.close();
});

test("P5.4: the gateway writes the admission allow-list from fresh signed heartbeats", async () => {
  const s = await setup(true);
  const file = s.cfg.env.PARALLAX_ALLOWED_PEERS_FILE!;
  await s.hb(0, null, { online: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).peer_ids, [PEER[0]]);
  await s.hb(1, null);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).peer_ids, [PEER[0], PEER[1]].sort());
  // Node 0 goes stale: it drops off at the next write.
  s.db.prepare("UPDATE nodes SET hb_ts = ? WHERE node_id = ?").run(Date.now() - 3_600_000, id(0));
  await s.hb(2, null);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).peer_ids, [PEER[1], PEER[2]].sort());
  s.db.close();
});

test("P5.8: receipts use the route Parallax really used (hook route log), mapped by peer ID", async () => {
  const s = await setup(true);
  await s.ready();
  routeTable = [PEER[0], PEER[1], PEER[2]];
  let r = await s.chat();
  assert.equal(r.status, 200);
  assert.ok(bodies.at(-1).ramx_req_id, "request tagged for the hook");
  let rc = Receipt.parse(await (await s.app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  assert.equal(rc.route_source, "scheduler");
  assert.deepEqual(rc.route?.map((h) => [h.node_id, h.layers]), [[id(0), [0, 20]], [id(1), [20, 29]], [id(2), [29, 40]]]);
  assert.equal(readRouteLog(routeLog).at(-1)!.ramx_req_id, rc.req_id);

  // An unknown peer in the scheduler route → keep the heartbeat layer map.
  routeTable = [PEER[0], "12D3KooWstranger", PEER[2]];
  r = await s.chat();
  rc = Receipt.parse(await (await s.app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  assert.equal(rc.route_source, "heartbeat");
  assert.equal(rc.route?.length, 3);
  s.db.close();
});

test("P5.8: without the hooks the gateway never adds its field to the Parallax body", async () => {
  const s = await setup(false);
  await s.ready();
  assert.equal((await s.chat()).status, 200);
  assert.equal(bodies.at(-1).ramx_req_id, undefined);
  assert.ok(!existsSync(join(s.dir, "routes.jsonl")));
  s.db.close();
});

test("P5.9: node-reported served sessions vs scheduler routes → route_dispute on /network", async () => {
  const s = await setup(true);
  await s.ready();
  routeTable = [PEER[0], PEER[1], PEER[2]];
  for (let i = 0; i < 6; i++) assert.equal((await s.chat()).status, 200);
  const network = async () => NetworkResponse.parse(await (await s.app.request("/network")).json()).pools[0]!;
  // Nobody reported yet: 6 routed, 0 reported → dispute.
  assert.equal((await network()).route_dispute, true);
  // Every node reports the 6 sessions it served → no dispute.
  for (const i of [0, 1, 2]) await s.hb(i, i === 0 ? [0, 20] : i === 1 ? [20, 29] : [29, 40], { served_sessions: 6 });
  assert.equal((await network()).route_dispute, false);
  // Node 1 over-reports (claims work it did not do) → dispute.
  await s.hb(1, [20, 29], { served_sessions: 10 });
  assert.equal((await network()).route_dispute, true);
  s.db.close();
});
