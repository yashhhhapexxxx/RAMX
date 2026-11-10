#!/usr/bin/env node
/**
 * SPEC §16.3 incentives demo (src/incentives.ts, SPEC §8.8). Real gateway code, a fake pool, a
 * temporary SQLite database; no network, no keys, no money.
 *   pnpm --filter @ramx/gateway demo:incentives
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { NODE_SIGNATURE_HEADER, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { registerMessage } from "../src/nodes.ts";
import { urlHash } from "../src/formation.ts";
import { collusionFlags, incentivesFor, nodeCap, payAvailability, recordPoolWait, reserveMc, runPenalties, unlockDue, upgradeCredential } from "../src/incentives.ts";
import type { Directory } from "../src/router.ts";
import { balance, signer, testAccount, TEST_JWT_SECRET } from "../test/helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";
const line = (s = "") => console.log(s);
const head = (s: string) => { line(); line(`=== ${s} ===`); };
const mc = (n: number) => `${n.toLocaleString("en-US")} mc (${(n / 1000).toFixed(1)} credits)`;

const pool = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 100, total_tokens: 140 } }));
  });
});
await new Promise<void>((r) => pool.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(pool.address() as AddressInfo).port}`;
const cfg = loadConfig({ POOL_COORDINATOR_URL: url, DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET });
const db = openDb(":memory:");
const listing = () => ({ type: "ramx.pool" as const, reliability: 0.8, pool_id: "pool-demo", models: [MODEL], status: "ready" as const, coordinator_url_hash: urlHash(url), layer_map: null,
  members: (db.prepare("SELECT node_id FROM nodes").all() as { node_id: string }[]).map((n) => n.node_id) });
const directory: Directory = { models: async () => [], pools: async () => [listing()], nodes: async () => [], readyPools: async () => [listing()] };
const app = createApp({ cfg, db, signer, directory, onComplete: () => {} });

const alice = await testAccount(db, cfg, "0x" + "a1".repeat(32)); // requester
const bob = await testAccount(db, cfg, "0x" + "b0".repeat(32));   // honest provider
const mallory = await testAccount(db, cfg, "0x" + "e7".repeat(32)); // cheating provider
const keys = [31, 32].map((i) => privateKeyToAccount(`0x${String(i).repeat(32)}` as `0x${string}`));
const owners = [bob, mallory];
const ranges: [number, number][] = [[0, 20], [20, 40]];
for (let i = 0; i < 2; i++) {
  const k = keys[i]!, nid = k.address.toLowerCase(), ts = Date.now();
  await app.request("/nodes/register", { method: "POST", headers: { "content-type": "application/json", ...owners[i]!.auth },
    body: JSON.stringify({ node_id: nid, pool_id: "pool-demo", gpu: "demo", mem_gb: 16, ts, node_sig: await k.signMessage({ message: registerMessage(nid, "pool-demo", ts) }), payout_address: "provider.testnet" }) });
  const raw = JSON.stringify({ node_id: nid, pool_id: "pool-demo", ts: Date.now(), online: true, model: MODEL, layers: ranges[i], tok_s: null });
  await app.request("/nodes/heartbeat", { method: "POST", headers: { [NODE_SIGNATURE_HEADER]: await k.signMessage({ message: { raw: new TextEncoder().encode(raw) } }) }, body: raw });
}
const [bobNode, malloryNode] = keys.map((k) => k.address.toLowerCase()) as [string, string];
const chat = (auth: Record<string, string>) => app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 200 }) });

head("1. Vesting: earnings are locked first (fraud can be taken back)");
const r1 = await chat(alice.auth);
const split = JSON.parse((db.prepare("SELECT split FROM requests WHERE req_id = ?").get(r1.headers.get(REQUEST_ID_HEADER)) as { split: string }).split) as { nodes: Record<string, number>; reserve_mc: number; burn_mc: number };
line(`  Alice's request split: Bob ${split.nodes[bobNode]}, Mallory ${split.nodes[malloryNode]}, burn ${split.burn_mc}, reserve ${split.reserve_mc}`);
for (const [n, a] of [["Bob", bob], ["Mallory", mallory]] as const) {
  const b = balance(db, a.accountId);
  line(`  ${n.padEnd(8)} locked ${mc(b.locked_mc)} | spendable ${mc(b.earned_mc)} | ratio counts it: earned_total ${b.earned_total_mc}`);
}
line(`  network reserve: ${mc(reserveMc(db))}`);
await chat(alice.auth);

head("2. Fraud: a final verification verdict blames Mallory's node");
db.prepare(`INSERT INTO verification_node_risk (node_id, alpha, beta, updated_at) VALUES (?, 9, 1, 1), (?, 1, 9, 1)`).run(malloryNode, bobNode);
db.prepare(`INSERT INTO verification_jobs (id, req_id, pool_id, route, owner_accounts, model, seed, settings, verdict, created_at, appeal_until)
  VALUES ('ver_demo', ?, 'pool-demo', ?, '[]', ?, 1, '{}', 'final_flag', 1, 2)`).run(r1.headers.get(REQUEST_ID_HEADER), JSON.stringify([{ node_id: bobNode }, { node_id: malloryNode }]), MODEL);
line(`  group-test risk: Mallory 0.90, Bob 0.10 (16.2 verification); appeal window over → final_flag`);
runPenalties(db, cfg.net, signer);
line(`  Mallory: locked ${mc(balance(db, mallory.accountId).locked_mc)}, banned=${incentivesFor(db, cfg, mallory.accountId).banned}, node cap ${nodeCap(db, cfg, mallory.accountId)}`);
line(`  Bob:     locked ${mc(balance(db, bob.accountId).locked_mc)} (untouched)`);
line(`  network reserve now ${mc(reserveMc(db))} (clawed credits added)`);
const after = await chat(alice.auth);
line(`  Alice's next request → HTTP ${after.status} (Mallory's pool left routing)`);
const ev = db.prepare("SELECT type FROM ledger_events WHERE type IN ('credits_clawed_back','account_banned') ORDER BY id").all() as { type: string }[];
line(`  ledger events: ${ev.map((e) => e.type).join(", ")}`);

head("3. Vesting ends: Bob's credits unlock");
unlockDue(db, Date.now() + cfg.net.incentives.vesting_s * 1000 + 1);
line(`  Bob: locked ${mc(balance(db, bob.accountId).locked_mc)} | spendable ${mc(balance(db, bob.accountId).earned_mc)}`);

head("4. Reputation-based node cap");
line(`  Bob now: ${nodeCap(db, cfg, bob.accountId)} nodes (MVP start cap)`);
upgradeCredential(db, bob.accountId, "orb");
db.prepare("UPDATE node_reliability SET score = 0.97, requests_ok = 500 WHERE node_id = ?").run(bobNode);
line(`  Bob after 8 days, Orb, reliability 0.97, 500 good requests: ${nodeCap(db, cfg, bob.accountId, Date.now() + 8 * 86_400_000)} nodes`);

head("5. Collusion flags (flag only, no automatic penalty)");
const f = collusionFlags(db, cfg.net);
for (const x of f.flags) line(`  ${x.kind}: ${x.detail}`);
if (!f.flags.length) line("  none");

head("6. Availability rewards from the reserve");
const E = cfg.net.incentives.availability.epoch_s * 1000;
const now = Date.now() + E;
const start = Math.floor(now / E) * E - E;
for (let t = start; t < start + E; t += cfg.env.HEARTBEAT_SECONDS * 1000) db.prepare("INSERT OR IGNORE INTO node_heartbeats (node_id, slot_ts) VALUES (?, ?)").run(bobNode, t);
db.prepare("UPDATE nodes SET pool_id = 'pool-busy' WHERE node_id = ?").run(bobNode);
recordPoolWait(db, "pool-busy", 9000, start + 1000);
const before = balance(db, bob.accountId).locked_mc;
const paid = payAvailability(db, cfg, signer, now);
line(`  pool-busy had a 9 s queue; Bob's node was online all ${cfg.net.incentives.availability.epoch_s / 60} min → +${mc(balance(db, bob.accountId).locked_mc - before)} (vesting), reserve paid ${mc(paid)}`);

head("7. Agent Pass (MVP form): Alice's agent spends Alice's credits within a budget");
const key = await (await app.request("/agents", { method: "POST", headers: { "content-type": "application/json", ...alice.auth }, body: JSON.stringify({ name: "research-bot", budget_mc: 1_000_000 }) })).json() as { agent_id: string; token: string };
line(`  agent ${key.agent_id}, token ${key.token.slice(0, 22)}… (shown once)`);
db.prepare("UPDATE nodes SET pool_id = 'pool-demo' WHERE node_id = ?").run(bobNode);
db.prepare("UPDATE accounts SET banned_at = NULL WHERE id = ?").run(mallory.accountId);
db.prepare("UPDATE nodes SET banned = 0").run();
const ar = await chat({ authorization: `Bearer ${key.token}` });
const agents = await (await app.request("/agents", { headers: alice.auth })).json() as { agents: { spent_mc: number; budget_mc: number }[] };
line(`  agent request → HTTP ${ar.status}; agent spent ${agents.agents[0]!.spent_mc} of ${agents.agents[0]!.budget_mc} mc; billed to Alice (${alice.accountId})`);
line();
db.close();
pool.close();
