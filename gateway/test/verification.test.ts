import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createRouter } from "../src/router.ts";
import { createPoolQueue } from "../src/queue.ts";
import { signer } from "./helpers.ts";
import { testDirectory } from "./helpers.ts";
import { challengeForHeartbeat, challengeResultHash, expectedCapabilityOutputHash, recordChallengeReply, requestAppeal, runAppealOnce, runCanaryOnce, runVerificationOnce, sampleProbability, verificationForAccount } from "../src/verification.ts";

const node = `0x${"a".repeat(40)}`;
const route = JSON.stringify([{ node_id: node, layers: [0, 40] }]);

test("sampled output gets a signed flag, route risk, owner-only appeal, and independent final check", async () => {
  let score = 2;
  const fake = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ score, threshold: 1, reference_hash: `0x${"b".repeat(64)}` }));
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = (fake.address() as AddressInfo).port;
  const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:3001", DATABASE_PATH: ":memory:",
    VERIFIER_URL: `http://127.0.0.1:${port}`, VERIFIER_OWNER_ACCOUNT: "acc_verifier",
    VERIFIER_SECONDARY_URL: `http://127.0.0.1:${port}`, VERIFIER_SECONDARY_OWNER_ACCOUNT: "acc_second" });
  const db = openDb(":memory:");
  try {
    db.prepare("INSERT INTO accounts (id, world_nullifier, created_at) VALUES ('acc_owner', 'owner', ?), ('acc_verifier', 'verifier', ?), ('acc_second', 'second', ?)").run(Date.now(), Date.now(), Date.now());
    db.prepare("INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at) VALUES (?, 'acc_owner', 'pool-v', 'test', 8, ?)").run(node, Date.now());
    db.prepare(`INSERT INTO requests (req_id, model, pay_type, status, prompt_hash, route, sampling_seed, sampling_settings, ts)
      VALUES ('req_verify1', 'Qwen/Qwen3-14B-FP8', 'credits', 'ok', ?, ?, 9, '{}', ?)`)
      .run(`0x${"c".repeat(64)}`, route, Date.now());
    db.prepare("INSERT INTO transcripts (req_id, prompt, response, expires_at) VALUES ('req_verify1', ?, 'answer', ?)").run('[{"role":"user","content":"hi"}]', Date.now() + 10000);
    db.prepare(`INSERT INTO verification_jobs (id, req_id, pool_id, route, owner_accounts, model, seed, settings, verdict, created_at, appeal_until)
      VALUES ('ver_test1', 'req_verify1', 'pool-v', ?, '["acc_owner"]', 'Qwen/Qwen3-14B-FP8', 9, '{}', 'queued', ?, ?)`)
      .run(route, Date.now(), Date.now() + 60_000);

    assert.equal(await runVerificationOnce(db, cfg, signer), 1);
    const result = db.prepare("SELECT verdict, score, reference_hash FROM verification_jobs WHERE id='ver_test1'").get() as { verdict: string; score: number; reference_hash: string };
    assert.deepEqual(result, { verdict: "flag", score: 2, reference_hash: `0x${"b".repeat(64)}` });
    assert.equal((db.prepare("SELECT flagged FROM verification_node_risk WHERE node_id = ?").get(node) as { flagged: number }).flagged, 1);
    assert.equal((db.prepare("SELECT type FROM ledger_events ORDER BY id DESC LIMIT 1").get() as { type: string }).type, "verification_result");
    const denied = requestAppeal(db, cfg, signer, "ver_test1", "acc_unrelated", "wrong owner");
    assert.ok("status" in denied && denied.status === 403);
    const accepted = requestAppeal(db, cfg, signer, "ver_test1", "acc_owner", "please recheck");
    assert.ok("ok" in accepted && accepted.ok);
    const pending = verificationForAccount(db, "ver_test1", "acc_owner");
    assert.ok(pending);
    assert.equal(pending.verdict, "appealed");
    score = 0.1;
    assert.equal(await runAppealOnce(db, cfg, signer), true);
    const final = verificationForAccount(db, "ver_test1", "acc_owner");
    assert.ok(final);
    assert.equal(final.verdict, "final_pass");
    assert.equal((db.prepare("SELECT type FROM ledger_events ORDER BY id DESC LIMIT 1").get() as { type: string }).type, "verification_final");
  } finally {
    db.close();
    fake.close();
  }
});

test("verification sampling raises the rate for a new pool", () => {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:3001", DATABASE_PATH: ":memory:" });
  const db = openDb(":memory:");
  try {
    db.prepare("INSERT INTO accounts (id, world_nullifier, created_at) VALUES ('acc_owner', 'owner-sample', ?)").run(Date.now());
    db.prepare("INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at) VALUES (?, 'acc_owner', 'pool-sample', 'test', 8, ?)").run(node, Date.now());
    assert.equal(sampleProbability(db, cfg, "pool-sample"), 0.2);
  } finally { db.close(); }
});

test("idle pool heartbeats deliver a one-hour hardware challenge and failed nodes are excluded", () => {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:3001", DATABASE_PATH: ":memory:" });
  const db = openDb(":memory:");
  try {
    const now = Date.now();
    db.prepare("INSERT INTO accounts (id, world_nullifier, created_at) VALUES ('acc_owner', 'owner-hw', ?)").run(now);
    db.prepare("INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at) VALUES (?, 'acc_owner', 'pool-hw', 'NVIDIA RTX 4060', 8, ?)").run(node, now);
    const challenge = challengeForHeartbeat(db, signer, node, "pool-hw", true, 10, now)!;
    assert.ok(challenge);
    assert.equal(challengeForHeartbeat(db, signer, node, "pool-hw", true, 10, now + 1000)?.challenge_id, challenge.challenge_id);
    const result = { backend: "cuda" as const, memory_gb: 8, elapsed_ms: 500, output_hash: expectedCapabilityOutputHash(challenge.seed) };
    const ok = recordChallengeReply(db, cfg, signer, node, { challenge_id: challenge.challenge_id, ...result,
      result_hash: challengeResultHash(challenge.challenge_id, challenge.seed, result) as `0x${string}` }, now + 2000);
    assert.equal(ok, true);
    assert.equal((db.prepare("SELECT hb_hw_verified FROM nodes WHERE node_id = ?").get(node) as { hb_hw_verified: number }).hb_hw_verified, 1);
    assert.equal(challengeForHeartbeat(db, signer, node, "pool-hw", false, 10, now + 3000), null);
  } finally { db.close(); }
});

test("scheduled canary calls only an idle routed pool and writes a signed audit result", async () => {
  const pool = createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "READY" } }] }));
  });
  const verifier = createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ score: 0.1, threshold: 1, reference_hash: `0x${"e".repeat(64)}` }));
  });
  await Promise.all([pool, verifier].map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))));
  const poolPort = (pool.address() as AddressInfo).port;
  const verifierPort = (verifier.address() as AddressInfo).port;
  const cfg = loadConfig({ POOL_COORDINATOR_URL: `http://127.0.0.1:${poolPort}`, DATABASE_PATH: ":memory:",
    VERIFIER_URL: `http://127.0.0.1:${verifierPort}`, VERIFIER_OWNER_ACCOUNT: "acc_verifier" });
  const db = openDb(":memory:");
  try {
    const directory = testDirectory(cfg, db, "pool-canary");
    const router = createRouter(cfg, db, directory);
    const queue = createPoolQueue();
    assert.equal(await runCanaryOnce(db, cfg, signer, router, queue, "Qwen/Qwen3-14B-FP8"), true);
    assert.equal((db.prepare("SELECT count(*) AS n FROM verification_canaries").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT type FROM ledger_events ORDER BY id DESC LIMIT 1").get() as { type: string }).type, "verification_canary");
    assert.equal(queue.isIdle("pool-canary"), true);
  } finally { db.close(); pool.close(); verifier.close(); }
});
