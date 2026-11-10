import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { countRouted, recordHeartbeat, refreshReliability } from "../src/reliability.ts";
import { me } from "../src/accounts.ts";

const NODE = "0x" + "1".repeat(40);
const START = 1_800_000_000_000;
const route = [{ node_id: NODE, layers: [0, 40] as [number, number] }];
const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001" });
function setup(path = ":memory:") {
  const db = openDb(path);
  db.prepare("INSERT INTO accounts (id, world_nullifier, created_at) VALUES ('acc_provider', 'unique', ?)").run(START);
  db.prepare("INSERT INTO balances (account_id) VALUES ('acc_provider')").run();
  db.prepare("INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at) VALUES (?, 'acc_provider', 'pool', 'gpu', 8, ?)").run(NODE, START);
  db.prepare("INSERT INTO node_reliability (node_id, score, updated_at) VALUES (?, 0.8, ?)").run(NODE, START);
  return db;
}
const stats = (db: ReturnType<typeof setup>) => db.prepare("SELECT * FROM node_reliability WHERE node_id = ?").get(NODE) as {
  requests_routed: number; requests_ok: number; heartbeats_expected: number; heartbeats_received: number; score: number;
};

test("new nodes start at 0.8; online samples deduplicate per slot; offline reports do not earn uptime", () => {
  const db = setup();
  try {
    refreshReliability(db, cfg, NODE, START);
    assert.equal(stats(db).score, 0.8);
    recordHeartbeat(db, cfg, NODE, true, START + 1);
    recordHeartbeat(db, cfg, NODE, true, START + 5000);
    assert.equal(stats(db).heartbeats_received, 1);
    assert.equal(stats(db).heartbeats_expected, 1);
    assert.equal(stats(db).score, 0.86);
    recordHeartbeat(db, cfg, NODE, false, START + 10_001);
    assert.equal(stats(db).heartbeats_received, 1);
    refreshReliability(db, cfg, NODE, START + 20_000);
    assert.equal(stats(db).heartbeats_expected, 2);
    assert.equal(stats(db).score, 0.71); // 0.7 × 0.8 + 0.3 × 0.5
  } finally { db.close(); }
});

test("successful/failed route outcomes use 70/30 weights and appear on /me without changing credits", () => {
  const db = setup();
  try {
    recordHeartbeat(db, cfg, NODE, true, START + 1);
    countRouted(db, cfg, route, true, START + 2);
    assert.equal(stats(db).score, 1);
    countRouted(db, cfg, route, false, START + 3);
    assert.equal(stats(db).score, 0.65);
    assert.equal(stats(db).requests_routed, 2);
    assert.equal(stats(db).requests_ok, 1);
    assert.equal(me(db, cfg, 'acc_provider', START + 4)?.nodes[0]?.reliability, 0.65);
    const balance = db.prepare("SELECT earned_mc, spent_total_mc FROM balances").get() as { earned_mc: number; spent_total_mc: number };
    assert.equal(balance.earned_mc, 0);
    assert.equal(balance.spent_total_mc, 0);
    countRouted(db, cfg, null, false, START + 5);
    assert.equal(stats(db).requests_routed, 2);
  } finally { db.close(); }
});

test("rolling seven-day window expires old successes, failures and heartbeats", () => {
  const db = setup();
  try {
    recordHeartbeat(db, cfg, NODE, true, START + 1);
    countRouted(db, cfg, route, false, START + 1);
    const week = 7 * 86_400_000;
    countRouted(db, cfg, route, true, START + week + 2);
    refreshReliability(db, cfg, undefined, START + week + 2);
    assert.equal(stats(db).requests_routed, 1);
    assert.equal(stats(db).requests_ok, 1);
    assert.equal(stats(db).heartbeats_received, 0);
    assert.equal(stats(db).score, 0.7);
    assert.equal((db.prepare("SELECT count(*) AS n FROM node_request_outcomes").get() as { n: number }).n, 1);
    assert.ok(stats(db).heartbeats_expected > 60_000);
  } finally { db.close(); }
});

test("persisted observations rebuild the same score after gateway restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "ramx-reliability-"));
  const path = join(dir, "test.sqlite");
  let db = setup(path);
  try {
    recordHeartbeat(db, cfg, NODE, true, START + 1);
    countRouted(db, cfg, route, true, START + 2);
    countRouted(db, cfg, route, false, START + 3);
    const before = stats(db);
    db.close();
    db = openDb(path);
    refreshReliability(db, cfg, NODE, START + 3);
    assert.deepEqual({ ...stats(db) }, { ...before });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
