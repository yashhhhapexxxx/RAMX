import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { AgentKeyCreateResponse, AgentKeyListResponse, LedgerEvent, MeResponse, NODE_SIGNATURE_HEADER, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig, type Config } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { registerMessage } from "../src/nodes.ts";
import { urlHash } from "../src/formation.ts";
import { blameRoute } from "../src/billing.ts";
import {
  addReserve, ban, clawBack, collusionFlags, consumeEarned, creditEarned, credentialOf, expireEarned, nodeCap,
  payAvailability, recordPoolWait, reserveMc, runPenalties, unlockDue, upgradeCredential,
} from "../src/incentives.ts";
import type { Directory } from "../src/router.ts";
import { countPool } from "../src/reliability.ts";
import { balance, signer, testAccount, TEST_JWT_SECRET } from "./helpers.ts";

/** SPEC §16.3 incentives and reputation (src/incentives.ts, SPEC §8.8). */
const MODEL = "Qwen/Qwen3-14B-FP8";
const HOUR = 3_600_000;
const events = (db: Db, type: string) => (db.prepare("SELECT payload FROM ledger_events WHERE type = ? ORDER BY id").all(type) as { payload: string }[]).map((r) => LedgerEvent.parse(JSON.parse(r.payload)));

function fresh(env: Record<string, string> = {}) {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET, ...env });
  return { cfg, db: openDb(":memory:") };
}

// ---------- vesting, spending order, expiry ----------

test("vesting: earnings are locked until vesting_s, count in the ratio at once, then unlock", async () => {
  const { cfg, db } = fresh();
  const a = await testAccount(db, cfg);
  const t0 = 1_800_000_000_000;
  creditEarned(db, cfg.net, a.accountId, 5000, "request", "req_1", t0);
  let b = balance(db, a.accountId);
  assert.deepEqual([b.locked_mc, b.earned_mc, b.earned_total_mc], [5000, 0, 5000]);
  assert.equal(unlockDue(db, t0 + cfg.net.incentives.vesting_s * 1000 - 1), 0, "not yet");
  assert.equal(unlockDue(db, t0 + cfg.net.incentives.vesting_s * 1000), 1);
  b = balance(db, a.accountId);
  assert.deepEqual([b.locked_mc, b.earned_mc, b.earned_total_mc], [0, 5000, 5000]);
  assert.equal(unlockDue(db, t0 + 10 * HOUR), 0, "unlocks once");
  db.close();
});

test("spending from earned uses the oldest lots first; expiry takes only old, unspent credits", async () => {
  const { cfg, db } = fresh();
  const a = await testAccount(db, cfg);
  db.prepare("UPDATE balances SET starter_mc = 0 WHERE account_id = ?").run(a.accountId);
  const day = 86_400_000, t0 = 1_800_000_000_000, vest = cfg.net.incentives.vesting_s * 1000;
  creditEarned(db, cfg.net, a.accountId, 3000, "request", "old", t0);
  creditEarned(db, cfg.net, a.accountId, 4000, "request", "new", t0 + 60 * day);
  unlockDue(db, t0 + 60 * day + vest);
  // Spend 2000: from the old lot (3000 → 1000 left).
  db.prepare("UPDATE balances SET earned_mc = earned_mc - 2000 WHERE account_id = ?").run(a.accountId);
  consumeEarned(db, a.accountId, 2000);
  const lots = db.prepare("SELECT ref, remaining_mc FROM earned_lots ORDER BY id").all() as { ref: string; remaining_mc: number }[];
  assert.deepEqual(lots.map((l) => [l.ref, l.remaining_mc]), [["old", 1000], ["new", 4000]]);
  // 91 days after the old lot unlocked: only its 1000 mc expire.
  const n = expireEarned(db, cfg.net, signer, t0 + vest + (cfg.net.incentives.earned_expiry_days + 1) * day);
  assert.equal(n, 1);
  assert.equal(balance(db, a.accountId).earned_mc, 4000);
  const ev = events(db, "credits_expired").at(-1)!;
  assert.ok(ev.type === "credits_expired" && ev.kind === "earned" && ev.amount_mc === 1000);
  db.close();
});

test("expiry never takes credits that a running request holds", async () => {
  const { cfg, db } = fresh();
  const a = await testAccount(db, cfg);
  db.prepare("UPDATE balances SET starter_mc = 0 WHERE account_id = ?").run(a.accountId);
  const t0 = 1_800_000_000_000;
  creditEarned(db, cfg.net, a.accountId, 3000, "request", "old", t0);
  unlockDue(db, t0 + HOUR);
  db.prepare("UPDATE balances SET held_mc = 2500 WHERE account_id = ?").run(a.accountId);
  expireEarned(db, cfg.net, signer, t0 + 200 * 86_400_000);
  assert.equal(balance(db, a.accountId).earned_mc, 2500, "only the unheld 500 expire");
  db.close();
});

// ---------- fraud penalties and bans ----------

function verificationJob(db: Db, id: string, route: { node_id: string }[], verdict = "final_flag") {
  db.prepare("INSERT INTO requests (req_id, account_id, model, pay_type, status, prompt_hash, ts) VALUES (?, NULL, ?, 'x402', 'ok', ?, 1)").run(`req_${id}`, MODEL, `0x${"ab".repeat(32)}`);
  db.prepare(`INSERT INTO verification_jobs (id, req_id, pool_id, route, owner_accounts, model, seed, settings, verdict, created_at, appeal_until)
    VALUES (?, ?, 'pool-x', ?, '[]', ?, 1, '{}', ?, 1, 2)`).run(id, `req_${id}`, JSON.stringify(route), MODEL, verdict);
}

function node(db: Db, nodeId: string, accountId: string, pool = "pool-x") {
  db.prepare("INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at) VALUES (?, ?, ?, 'gpu', 16, 1)").run(nodeId, accountId, pool);
}

test("final fraud verdict: only the high-risk node's owner loses locked credits and is banned; once only", async () => {
  const { cfg, db } = fresh();
  const cheat = await testAccount(db, cfg);
  const honest = await testAccount(db, cfg);
  const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
  node(db, A, cheat.accountId);
  node(db, B, honest.accountId);
  const now = 1_800_000_000_000;
  creditEarned(db, cfg.net, cheat.accountId, 7000, "request", "r1", now);
  creditEarned(db, cfg.net, honest.accountId, 9000, "request", "r2", now);
  db.prepare("INSERT INTO verification_node_risk (node_id, alpha, beta, updated_at) VALUES (?, 9, 1, 1), (?, 1, 9, 1)").run(A, B);
  verificationJob(db, "ver_1", [{ node_id: A }, { node_id: B }]);
  verificationJob(db, "ver_2", [{ node_id: A }], "flag"); // not final: ignored
  assert.equal(runPenalties(db, cfg.net, signer, now), 1);
  assert.equal(balance(db, cheat.accountId).locked_mc, 0);
  assert.equal(balance(db, honest.accountId).locked_mc, 9000, "honest node untouched");
  assert.equal(reserveMc(db), 7000, "clawed credits go to the network reserve");
  assert.ok((db.prepare("SELECT banned_at FROM accounts WHERE id = ?").get(cheat.accountId) as { banned_at: number }).banned_at);
  assert.equal((db.prepare("SELECT banned FROM nodes WHERE node_id = ?").get(A) as { banned: number }).banned, 1);
  const claw = events(db, "credits_clawed_back")[0]!;
  assert.ok(claw.type === "credits_clawed_back" && claw.amount_mc === 7000 && claw.evidence_id === "ver_1");
  assert.equal(events(db, "account_banned").length, 1);
  assert.equal(runPenalties(db, cfg.net, signer, now + 1), 0, "handled once");
  assert.equal(nodeCap(db, cfg, cheat.accountId), 0, "a banned nullifier cannot register nodes");
  db.close();
});

test("final fraud verdict without enough evidence for any node → no penalty (recorded)", async () => {
  const { cfg, db } = fresh();
  const a = await testAccount(db, cfg), b = await testAccount(db, cfg);
  const A = "0x" + "c3".repeat(20), B = "0x" + "d4".repeat(20);
  node(db, A, a.accountId);
  node(db, B, b.accountId);
  creditEarned(db, cfg.net, a.accountId, 1000, "request", "r", Date.now());
  verificationJob(db, "ver_9", [{ node_id: A }, { node_id: B }]);
  runPenalties(db, cfg.net, signer);
  assert.equal(balance(db, a.accountId).locked_mc, 1000);
  assert.deepEqual(JSON.parse((db.prepare("SELECT nodes FROM penalties WHERE verification_id = 'ver_9'").get() as { nodes: string }).nodes), []);
  db.close();
});

test("clawBack takes only locked lots; unlocked credits stay", async () => {
  const { cfg, db } = fresh();
  const a = await testAccount(db, cfg);
  creditEarned(db, cfg.net, a.accountId, 1000, "request", "old", 0);
  unlockDue(db, HOUR * 2);
  creditEarned(db, cfg.net, a.accountId, 500, "request", "new", HOUR * 2);
  assert.equal(clawBack(db, signer, a.accountId, "ver_x", HOUR * 2), 500);
  const b = balance(db, a.accountId);
  assert.deepEqual([b.earned_mc, b.locked_mc], [1000, 0]);
  assert.equal(clawBack(db, signer, a.accountId, "ver_x"), 0);
  assert.equal(ban(db, signer, a.accountId, "ver_x"), true);
  assert.equal(ban(db, signer, a.accountId, "ver_x"), false, "one ban event");
  db.close();
});

// ---------- node cap and credential tier ----------

test("node cap: start = MVP cap; proven (age + Orb/Passport + reliability + work) = node_cap_proven", async () => {
  const { cfg, db } = fresh();
  const a = await testAccount(db, cfg);
  const inc = cfg.net.incentives;
  assert.equal(nodeCap(db, cfg, a.accountId), cfg.net.max_nodes_per_account);
  const N = "0x" + "e5".repeat(20);
  node(db, N, a.accountId);
  db.prepare("INSERT INTO node_reliability (node_id, requests_routed, requests_ok, score, updated_at) VALUES (?, ?, ?, 0.97, 1)").run(N, inc.proven_min_requests, inc.proven_min_requests);
  const later = Date.now() + (inc.proven_after_days + 1) * 86_400_000;
  assert.equal(nodeCap(db, cfg, a.accountId, later), cfg.net.max_nodes_per_account, "no proven credential yet");
  upgradeCredential(db, a.accountId, "selfie");
  assert.equal(nodeCap(db, cfg, a.accountId, later), cfg.net.max_nodes_per_account, "Selfie Check is not enough");
  upgradeCredential(db, a.accountId, "passport");
  assert.equal(nodeCap(db, cfg, a.accountId, later), inc.node_cap_proven);
  upgradeCredential(db, a.accountId, "selfie");
  assert.equal((db.prepare("SELECT credential FROM accounts WHERE id = ?").get(a.accountId) as { credential: string }).credential, "passport", "never downgrades");
  db.prepare("UPDATE node_reliability SET score = 0.5").run();
  assert.equal(nodeCap(db, cfg, a.accountId, later), cfg.net.max_nodes_per_account, "unreliable node → start cap");
  assert.equal(credentialOf(["selfie", "proof_of_human"]), "orb");
  assert.equal(credentialOf(["document"]), "passport");
  assert.equal(credentialOf(["device"]), null);
  db.close();
});

// ---------- collusion flags ----------

test("collusion flags: dominant requester, mutual flow, twin accounts (flags only)", async () => {
  const { cfg, db } = fresh();
  const a = await testAccount(db, cfg), b = await testAccount(db, cfg), c = await testAccount(db, cfg);
  const NA = "0x" + "aa".repeat(20), NB = "0x" + "bb".repeat(20), NC = "0x" + "cc".repeat(20);
  node(db, NA, a.accountId);
  node(db, NB, b.accountId);
  node(db, NC, c.accountId);
  let i = 0;
  const req = (from: string, to: string, mc: number) => db.prepare(`INSERT INTO requests (req_id, account_id, model, pay_type, status, prompt_hash, split, ts)
    VALUES (?, ?, ?, 'credits', 'ok', ?, ?, ?)`).run(`req_c${i++}`, from, MODEL, `0x${"ab".repeat(32)}`, JSON.stringify({ nodes: { [to]: mc }, burn_mc: 0, reserve_mc: 0 }), Date.now());
  req(a.accountId, NB, 50_000);
  req(b.accountId, NA, 40_000);
  req(c.accountId, NB, 5_000);
  const f = collusionFlags(db, cfg.net);
  const kinds = f.flags.map((x) => x.kind).sort();
  assert.ok(kinds.includes("mutual_flow"));
  assert.ok(kinds.includes("dominant_requester"), "a gave 91% of b's earnings");
  assert.ok(!f.flags.some((x) => x.kind === "twin_accounts"), "b also trades with c");
  // A clean pair created together that only trade with each other → twins.
  const { cfg: cfg2, db: db2 } = fresh();
  const x = await testAccount(db2, cfg2), y = await testAccount(db2, cfg2);
  node(db2, NA, x.accountId);
  node(db2, NB, y.accountId);
  db2.prepare(`INSERT INTO requests (req_id, account_id, model, pay_type, status, prompt_hash, split, ts) VALUES ('req_t1', ?, ?, 'credits', 'ok', ?, ?, ?)`)
    .run(x.accountId, MODEL, `0x${"ab".repeat(32)}`, JSON.stringify({ nodes: { [NB]: 20_000 }, burn_mc: 0, reserve_mc: 0 }), Date.now());
  assert.ok(collusionFlags(db2, cfg2.net).flags.some((z) => z.kind === "twin_accounts"));
  // No automatic penalty.
  assert.equal(balance(db, a.accountId).locked_mc, 0);
  db.close(); db2.close();
});

// ---------- availability rewards ----------

test("availability: nodes online in a pool that had a queue earn standby credits from the reserve, once per epoch", async () => {
  const { cfg, db } = fresh();
  const a = await testAccount(db, cfg), b = await testAccount(db, cfg);
  const NA = "0x" + "f1".repeat(20), NB = "0x" + "f2".repeat(20), NC = "0x" + "f3".repeat(20);
  node(db, NA, a.accountId, "busy");
  node(db, NB, b.accountId, "busy");
  node(db, NC, b.accountId, "idle");
  const av = cfg.net.incentives.availability, E = av.epoch_s * 1000;
  const now = 1_800_000_000_000 - (1_800_000_000_000 % E) + 1000;   // just after an epoch boundary
  const start = now - 1000 - E;
  const slot = cfg.env.HEARTBEAT_SECONDS * 1000;
  const hb = db.prepare("INSERT INTO node_heartbeats (node_id, slot_ts) VALUES (?, ?)");
  for (let t = start; t < start + E; t += slot) { hb.run(NA, t); hb.run(NC, t); }        // A full epoch, C idle pool
  for (let t = start; t < start + E / 2; t += slot) hb.run(NB, t);                       // B half
  recordPoolWait(db, "busy", av.min_wait_ms + 1, start + 5000);
  recordPoolWait(db, "idle", 10, start + 5000);                                           // too short
  addReserve(db, 1_000_000);
  const paid = payAvailability(db, cfg, signer, now);
  const full = Math.floor(av.reward_mc_per_min * (E / slot) * (cfg.env.HEARTBEAT_SECONDS / 60));
  assert.equal(balance(db, a.accountId).locked_mc, full, "vests like any earnings");
  assert.equal(balance(db, b.accountId).locked_mc, Math.floor(full / 2), "half the time online, idle pool earns nothing");
  assert.equal(paid, full + Math.floor(full / 2));
  assert.equal(reserveMc(db), 1_000_000 - paid);
  assert.equal(events(db, "availability_reward").length, 2);
  assert.equal(payAvailability(db, cfg, signer, now + 5), 0, "once per epoch");
  db.close();
});

test("availability is capped by the reserve (scaled down evenly)", async () => {
  const { cfg, db } = fresh();
  const a = await testAccount(db, cfg);
  const NA = "0x" + "f4".repeat(20);
  node(db, NA, a.accountId, "busy");
  const E = cfg.net.incentives.availability.epoch_s * 1000;
  const now = 1_800_000_000_000 - (1_800_000_000_000 % E) + 1000, start = now - 1000 - E;
  for (let t = start; t < start + E; t += cfg.env.HEARTBEAT_SECONDS * 1000) db.prepare("INSERT INTO node_heartbeats (node_id, slot_ts) VALUES (?, ?)").run(NA, t);
  recordPoolWait(db, "busy", 60_000, start + 1);
  addReserve(db, 37);
  assert.equal(payAvailability(db, cfg, signer, now), 37);
  assert.equal(reserveMc(db), 0);
  db.close();
});

// ---------- stage blame ----------

test("stage blame: only late (stalled) nodes get the failure when known; else the whole route", () => {
  const route = [{ node_id: "0x" + "01".repeat(20), layers: [0, 20] as [number, number] }, { node_id: "0x" + "02".repeat(20), layers: [20, 40] as [number, number] }];
  assert.deepEqual(blameRoute(route, ["0x" + "02".repeat(20)]), [route[1]]);
  assert.deepEqual(blameRoute(route, []), route);
  assert.equal(blameRoute(null, ["x"]), null);
});

// ---------- API: agent keys, routing preferences, private pools, settle → reserve ----------

let pool: Server;
before(async () => {
  pool = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "okay. ".repeat(5) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    });
  });
  await new Promise<void>((r) => pool.listen(0, "127.0.0.1", r));
});
after(() => pool.close());

async function apiSetup(env: Record<string, string> = {}) {
  const url = `http://127.0.0.1:${(pool.address() as AddressInfo).port}`;
  const cfg: Config = loadConfig({ POOL_COORDINATOR_URL: url, DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET, ...env });
  const db = openDb(":memory:");
  const listing = (id: string) => ({ type: "ramx.pool" as const, reliability: 0.8, pool_id: id, models: [MODEL], status: "ready" as const, coordinator_url_hash: urlHash(url), layer_map: null,
    members: (db.prepare("SELECT node_id FROM nodes WHERE pool_id = ?").all(id) as { node_id: string }[]).map((n) => n.node_id) });
  const directory: Directory = { models: async () => [], pools: async () => [listing("p1"), listing("p2")], nodes: async () => [], readyPools: async () => [listing("p1"), listing("p2")] };
  const app = createApp({ cfg, db, signer, directory, onComplete: () => {} });
  const human = await testAccount(db, cfg), provider = await testAccount(db, cfg);
  const K = [21, 22].map((i) => privateKeyToAccount(`0x${String(i).repeat(32)}` as `0x${string}`));
  for (const [i, poolId] of [[0, "p1"], [1, "p2"]] as const) {
    const k = K[i]!, nid = k.address.toLowerCase(), ts = Date.now();
    await app.request("/nodes/register", { method: "POST", headers: { "content-type": "application/json", ...provider.auth },
      body: JSON.stringify({ node_id: nid, pool_id: poolId, gpu: "g", mem_gb: 16, ts, node_sig: await k.signMessage({ message: registerMessage(nid, poolId, ts) }), payout_address: "provider.testnet" }) });
    const raw = JSON.stringify({ node_id: nid, pool_id: poolId, ts: Date.now(), online: true, model: MODEL, layers: [0, 40], tok_s: null });
    await app.request("/nodes/heartbeat", { method: "POST", headers: { [NODE_SIGNATURE_HEADER]: await k.signMessage({ message: { raw: new TextEncoder().encode(raw) } }) }, body: raw });
  }
  const chat = (auth: Record<string, string>, headers: Record<string, string> = {}) => app.request("/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", ...auth, ...headers }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 20 }) });
  return { cfg, db, app, human, provider, chat, nodeIds: K.map((k) => k.address.toLowerCase()) };
}

test("Agent Pass (MVP form): a human's agent key spends the human's credits within its budget; revoke works", async () => {
  const s = await apiSetup();
  const created = await s.app.request("/agents", { method: "POST", headers: { "content-type": "application/json", ...s.human.auth }, body: JSON.stringify({ name: "bot", budget_mc: 50_000 }) });
  assert.equal(created.status, 200);
  const key = AgentKeyCreateResponse.parse(await created.json());
  const agentAuth = { authorization: `Bearer ${key.token}` };
  const before = balance(s.db, s.human.accountId).spent_total_mc;
  const r = await s.chat(agentAuth);
  assert.equal(r.status, 200);
  const row = s.db.prepare("SELECT account_id, agent_id, cost_mc FROM requests WHERE req_id = ?").get(r.headers.get(REQUEST_ID_HEADER)) as { account_id: string; agent_id: string; cost_mc: number };
  assert.deepEqual([row.account_id, row.agent_id], [s.human.accountId, key.agent_id]);
  assert.equal(balance(s.db, s.human.accountId).spent_total_mc - before, row.cost_mc, "the human pays");
  const list = AgentKeyListResponse.parse(await (await s.app.request("/agents", { headers: s.human.auth })).json());
  assert.equal(list.agents[0]!.spent_mc, row.cost_mc);
  // Budget 50_000 − 21_000 spent = 29_000 left < next hold 1.75 × (20 + 0.2 × 1) = 35_350 mc.
  assert.equal(row.cost_mc, 21_000);
  assert.equal((await s.chat(agentAuth)).status, 403, "budget left is smaller than the hold");
  assert.equal(events(s.db, "agent_key_created").length, 1);
  // Agent keys work only on the chat route.
  assert.equal((await s.app.request("/me", { headers: agentAuth })).status, 401);
  assert.equal((await s.app.request(`/agents/${key.agent_id}`, { method: "DELETE", headers: s.human.auth })).status, 200);
  assert.equal((await s.chat(agentAuth)).status, 401, "revoked");
  assert.equal((await s.chat({ authorization: "Bearer gpa_agt_nope_" + "0".repeat(64) })).status, 401);
  s.db.close();
});

test("routing preferences: pin a pool, minimum reliability; private pools; banned owners skipped", async () => {
  const s = await apiSetup({ PRIVATE_POOLS: JSON.stringify({ p2: ["acc_nobody"] }) });
  assert.equal((await s.chat(s.human.auth, { "x-ramx-pool": "p1" })).status, 200);
  assert.equal((await s.chat(s.human.auth, { "x-ramx-pool": "p2" })).status, 503, "p2 is private");
  assert.equal((await s.chat(s.provider.auth, { "x-ramx-pool": "p2" })).status, 200, "the pool's own node owner may use it");
  assert.equal((await s.chat(s.human.auth, { "x-ramx-pool": "bad id!" })).status, 400);
  // SPEC §9.2: the POOL's record decides (6 served, 4 failed → ≈ 0.66), not a node's score.
  for (const pool of ["p1", "p2"]) for (let i = 0; i < 10; i++) countPool(s.db, s.cfg, pool, i < 6);
  assert.equal((await s.chat(s.human.auth, { "x-ramx-min-reliability": "0.9" })).status, 503, "no pool reaches 0.9");
  assert.equal((await s.chat(s.human.auth, { "x-ramx-min-reliability": "0.5", "x-ramx-pool": "p1" })).status, 200);
  assert.equal((await s.chat(s.human.auth, { "x-ramx-min-reliability": "2" })).status, 400);
  ban(s.db, signer, s.provider.accountId, "ver_test");
  assert.equal((await s.chat(s.human.auth)).status, 503, "pools of a banned owner leave routing");
  s.db.close();
});

test("settle books the reserve share; /me shows locked credits, credential, node cap", async () => {
  const s = await apiSetup();
  const r = await s.chat(s.human.auth, { "x-ramx-pool": "p1" });
  const row = s.db.prepare("SELECT split FROM requests WHERE req_id = ?").get(r.headers.get(REQUEST_ID_HEADER)) as { split: string };
  assert.equal(reserveMc(s.db), (JSON.parse(row.split) as { reserve_mc: number }).reserve_mc);
  const me = MeResponse.parse(await (await s.app.request("/me", { headers: s.provider.auth })).json());
  assert.ok(me.incentives.locked_mc > 0);
  assert.ok(me.incentives.next_unlock_at! > Date.now());
  assert.equal(me.incentives.node_cap, s.cfg.net.max_nodes_per_account);
  assert.equal(me.incentives.banned, false);
  assert.equal((await s.app.request("/incentives/flags")).status, 403, "operator view is loopback only");
  s.db.close();
});
