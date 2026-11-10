import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson, LedgerEvent, PayoutsResponse } from "@ramx/shared";
import { openDb } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";
import { payoutLeaf, payoutTree, verifyPayoutProof, ZERO_ROOT, type Hash } from "../src/merkle.ts";
import { createSettlement, payoutsFor, providerPayouts, type PaidRequest } from "../src/settlement.ts";
import { signer } from "./helpers.ts";
import { FakeChain } from "./fake-settlement.ts";

const A = "alice.testnet";
const B = "bob.testnet";
const PAYER = "agent-9.testnet";
const NOW = 1_200_000;
const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", EPOCH_SECONDS: "600" });
const snapshot = (account: string | null = A, start = 0, end = 40, node = "1") => ({ node_id: `0x${node.repeat(40)}`, owner_account: "acc_provider", payout_address: account, layers: [start, end] });
const request = (over: Partial<PaidRequest> = {}): PaidRequest => ({ req_id: "req_1", model: "Qwen/Qwen3-14B-FP8", status: "ok", x402_payer: PAYER, x402_tx: "HEqAxC3rbvSwWW6KQbzt69wp6MeWqL4JLsv1jY1gCDQy", x402_amount: "2000000", payout_snapshot: JSON.stringify([snapshot()]), ...over });

function seed(db: ReturnType<typeof openDb>, r = request(), ts = 610_000) {
  db.prepare(`INSERT INTO requests (req_id, model, status, pay_type, x402_payer, x402_tx, x402_amount, payout_snapshot, prompt_hash, ts)
    VALUES (?, ?, ?, 'x402', ?, ?, ?, ?, ?, ?)`).run(r.req_id, r.model, r.status, r.x402_payer, r.x402_tx, r.x402_amount, r.payout_snapshot, `0x${"0".repeat(64)}`, ts);
}
const ledgerFinal = (db: ReturnType<typeof openDb>) => db.prepare("UPDATE ledger_events SET ledger_seq = id WHERE ledger_seq IS NULL").run();

test("Merkle leaves, roots and proofs reproduce the contract's cross-language vector exactly", () => {
  const v = JSON.parse(readFileSync(new URL("../../contracts-near/payout/tests/merkle-vector.json", import.meta.url), "utf8")) as
    { cases: { root: string; leaves: { account: string; amount: string; leaf: string; proof: string[] }[] }[] };
  for (const c of v.cases) {
    const tree = payoutTree(1, c.leaves.map((l) => ({ payout_address: l.account, amount_units: l.amount })));
    assert.equal(tree.root, `0x${c.root}`);
    for (const l of c.leaves) {
      assert.equal(payoutLeaf(l.account, BigInt(l.amount)), `0x${l.leaf}`);
      const proof = l.proof.map((p) => `0x${p}` as Hash);
      assert.deepEqual(tree.proofs.find((p) => p.payout_address === l.account)!.proof, proof);
      assert.ok(verifyPayoutProof(l.account, BigInt(l.amount), proof, tree.root));
      const wrong = BigInt(l.amount) === (1n << 128n) - 1n ? 0n : BigInt(l.amount) + 1n;
      assert.equal(verifyPayoutProof(l.account, wrong, proof, tree.root), false);
    }
  }
  assert.equal(payoutTree(1, []).root, ZERO_ROOT);
});

test("provider amounts use 80% and per-request layer floors; aggregate accounts, exclude self/missing/failed/unknown shares", () => {
  const rows = [request({ payout_snapshot: JSON.stringify([snapshot(A, 0, 20), snapshot(PAYER, 20, 29, "2"), snapshot(B, 29, 40, "3")]) }), request({ req_id: "req_2", x402_amount: "1" }), request({ status: "failed" }), request({ payout_snapshot: null })];
  assert.deepEqual(providerPayouts(cfg, rows), [{ payout_address: A, amount_units: "800000" }, { payout_address: B, amount_units: "440000" }]);
  const huge = 10n ** 22n + 13n;
  assert.equal(providerPayouts(cfg, [request({ x402_amount: huge.toString() })])[0]!.amount_units, (huge * 8000n / 10_000n).toString());
  assert.deepEqual(providerPayouts(cfg, [request({ payout_snapshot: JSON.stringify([snapshot(null)]) })]), []);
  assert.throws(() => providerPayouts(cfg, [request({ x402_payer: null })]), /payer unknown/);
  assert.throws(() => providerPayouts(cfg, [request({ payout_snapshot: JSON.stringify([snapshot(A, 0, 20)]) })]), /layer map/);
});

test("duplicate payout accounts combine; zero amounts are left out", () => {
  const tree = payoutTree(1, [{ payout_address: A, amount_units: "2" }, { payout_address: A, amount_units: "3" }, { payout_address: B, amount_units: "0" }]);
  assert.deepEqual(tree.payouts, [{ payout_address: A, amount_units: "5" }]);
});

test("epoch closes atomically, waits for the ledger, funds and posts once, exposes only confirmed proofs", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db);
    await job.runOnce(NOW);
    assert.equal(chain.posts, 0, "the epoch_closed event is not final on the ledger yet");
    assert.deepEqual(payoutsFor(db, A).payouts, []);
    const ev = LedgerEvent.parse(JSON.parse((db.prepare("SELECT payload FROM ledger_events").get() as { payload: string }).payload));
    assert.equal(ev.type === "epoch_closed" && ev.total_units, "1600000");
    ledgerFinal(db);
    await job.runOnce(NOW);
    const locked = PayoutsResponse.parse(payoutsFor(db, A, NOW));
    assert.equal(locked.payouts[0]!.claimable, false);
    assert.equal(locked.payouts[0]!.claimable_at, 1_260_000);
    assert.equal(locked.payouts[0]!.post_tx, (db.prepare("SELECT post_tx FROM epochs").get() as { post_tx: string }).post_tx);
    assert.equal(payoutsFor(db, A, 1_260_000).payouts[0]!.claimable, true);
    await job.runOnce(NOW);
    assert.equal(chain.posts, 1);
    assert.equal(chain.funded, 1_600_000n);
    assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE type='epoch_closed'").get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test("pending requests defer their epoch; exact boundaries and duplicate payment IDs cannot double-pay", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db, request({ status: "pending" }));
    await job.closeDue(NOW);
    assert.equal((db.prepare("SELECT count(*) AS n FROM epochs").get() as { n: number }).n, 0);
    db.prepare("UPDATE requests SET status='ok'").run();
    seed(db, request({ req_id: "req_2" }), NOW); // same payment, next epoch
    await job.closeDue(NOW);
    assert.equal((db.prepare("SELECT count(*) AS n FROM epochs").get() as { n: number }).n, 1);
    await job.closeDue(NOW + 600_000);
    const second = db.prepare("SELECT total_units, status FROM epochs WHERE epoch=2").get() as { total_units: string; status: string };
    assert.equal(second.status, "empty"); assert.equal(second.total_units, "0");
  } finally { db.close(); }
});

test("zero-provider epochs never fund or post; invalid data fails before closing", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db, request({ payout_snapshot: null }));
    await job.runOnce(NOW); ledgerFinal(db); await job.runOnce(NOW);
    assert.equal(chain.posts, 0);
    assert.equal((db.prepare("SELECT status FROM epochs").get() as { status: string }).status, "empty");
    seed(db, request({ req_id: "req_bad", x402_tx: "A5pcs4M23EPyNEbAqVwbwgWooHjib4jMx4Rao7KxdyTz", payout_snapshot: "{}" }), NOW + 1);
    await assert.rejects(job.closeDue(NOW + 600_000));
    assert.equal((db.prepare("SELECT count(*) AS n FROM epochs").get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test("a post that landed but lost its response is recovered from the contract, never funded twice", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db); await job.closeDue(NOW); ledgerFinal(db);
    chain.loseNextResponse = true;
    await job.runOnce(NOW); // the post landed; the worker reads the contract state and continues
    assert.equal((db.prepare("SELECT status FROM epochs").get() as { status: string }).status, "posted");
    // A restarted worker sees the posted epoch and does not post again.
    await createSettlement(db, cfg, signer, chain).runOnce(NOW);
    assert.equal(chain.posts, 1);
    assert.equal(chain.funded, 1_600_000n);
  } finally { db.close(); }
});

test("a second post of the same epoch is refused by the contract (refunded) and reconciled", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db); await job.closeDue(NOW); ledgerFinal(db);
    const tree = db.prepare("SELECT merkle_root, total_units FROM epochs").get() as { merkle_root: Hash; total_units: string };
    // Another worker (or a crash before the status update) already posted the identical epoch.
    await chain.post(1, tree.merkle_root, BigInt(tree.total_units));
    let reads = 0;
    const epoch = chain.epoch;
    chain.epoch = async (e) => (reads++ === 0 ? null : epoch(e)); // the first read races the other post
    await job.runOnce(NOW);
    assert.equal(chain.posts, 1, "the refused post moved no USDC");
    assert.equal((db.prepare("SELECT status FROM epochs").get() as { status: string }).status, "posted");
  } finally { db.close(); }
});

test("a conflicting root on the contract stops the worker before any payout", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db); await job.closeDue(NOW); ledgerFinal(db);
    chain.states.set(1, { root: `0x${"ab".repeat(32)}`, total: 1n, claimed: 0n, opensAt: 0, swept: false });
    await assert.rejects(job.runOnce(NOW), /conflicts with the payout contract/);
    assert.equal(chain.posts, 0);
    assert.deepEqual(payoutsFor(db, A).payouts, []);
  } finally { db.close(); }
});

test("large payout lists commit their canonical hash and stay under the ledger contract's 4 KB event limit", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    for (let i = 1; i <= 120; i++) seed(db, request({ req_id: `req_${i}`, x402_tx: `Tx${String(i).padStart(42, "1").replaceAll("0", "z")}`, payout_snapshot: JSON.stringify([snapshot(`provider-${i}.testnet`)]) }));
    await job.closeDue(NOW);
    const payload = (db.prepare("SELECT payload FROM ledger_events").get() as { payload: string }).payload;
    const event = JSON.parse(payload);
    assert.equal(event.payouts, null);
    assert.ok(Buffer.byteLength(payload) <= 4096);
    const list = (db.prepare("SELECT payout_address, amount_units FROM epoch_payouts").all() as { payout_address: string; amount_units: string }[])
      .sort((a, b) => a.payout_address.localeCompare(b.payout_address));
    assert.equal(event.payouts_hash, `0x${createHash("sha256").update(canonicalJson(list)).digest("hex")}`);
  } finally { db.close(); }
});

test("provider API and claim index are idempotent; swept funds are not claimable", async () => {
  const db = openDb(":memory:"); const chain = new FakeChain(); const job = createSettlement(db, cfg, signer, chain);
  try {
    seed(db); await job.closeDue(NOW); ledgerFinal(db); await job.runOnce(NOW);
    const app = createApp({ cfg, db, signer, directory: { models: async () => [], pools: async () => [], nodes: async () => [], readyPools: async () => [] } });
    assert.equal((await app.request("/payouts/Not_A_Near.Account!")).status, 400);
    assert.equal((await app.request(`/payouts/${B}`)).status, 200);
    const proof = PayoutsResponse.parse(await (await app.request(`/payouts/${A}`)).json()).payouts[0]!;
    assert.ok(verifyPayoutProof(A, BigInt(proof.amount_units), proof.proof as Hash[], proof.merkle_root as Hash));
    chain.claim(1, A, 1_600_000n);
    await job.runOnce(NOW); await job.runOnce(NOW);
    const claimed = payoutsFor(db, A).payouts[0]!;
    assert.equal(claimed.claimed, true); assert.equal(claimed.claimable, false);
    assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE type='payout_claimed'").get() as { n: number }).n, 1);
    // Another epoch is swept without a provider claim.
    seed(db, request({ req_id: "req_later", x402_tx: "FfvwzAcUpCzWT6BGi6av7rNPyu3bKqrCWCN5A4FYGPSN" }), NOW + 1);
    await job.closeDue(NOW + 600_000); ledgerFinal(db); await job.runOnce(NOW + 600_000);
    chain.sweep(2);
    await job.runOnce(NOW + 600_000);
    const swept = payoutsFor(db, A).payouts.find((p) => p.epoch === 2)!;
    assert.equal(swept.swept, true); assert.equal(swept.claimable, false);
  } finally { db.close(); }
});
