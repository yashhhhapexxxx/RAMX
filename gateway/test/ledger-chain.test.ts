import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, LedgerEvent } from "@ramx/shared";
import { openDb } from "../src/db.ts";
import { recordEvent, signEvent, signerFromSeed, verifyEvent } from "../src/events.ts";
import { flushOnce, startLedgerWriter } from "../src/ledger-chain.ts";
import { fakeLedgerChain, fakeTxHash, signer, TEST_SEED } from "./helpers.ts";

test("signing: sig = ed25519 over canonical JSON without sig; verify helper accepts it and rejects tampering", () => {
  const ev = signEvent(signer, { type: "account_created", account_id: "acc_abc" }, 1793912345123);
  assert.equal(LedgerEvent.parse(ev).type, "account_created");
  assert.equal(ev.v, 1);
  assert.equal(ev.ts, 1793912345123);
  assert.match(ev.sig, /^0x[0-9a-f]{128}$/);
  assert.equal(verifyEvent(ev, signer.publicKeyHex), true);
  assert.equal(verifyEvent({ ...ev, account_id: "acc_evil" }, signer.publicKeyHex), false);
  // key order does not matter: verify uses canonical JSON
  const reordered = JSON.parse(JSON.stringify({ sig: ev.sig, type: ev.type, ts: ev.ts, v: ev.v, account_id: (ev as { account_id: string }).account_id }));
  assert.equal(verifyEvent(reordered, signer.publicKeyHex), true);
  const other = signerFromSeed("22".repeat(32));
  assert.equal(verifyEvent(ev, other.publicKeyHex), false);
});

test("signing is deterministic (ed25519) and the public key is stable for a seed", () => {
  const a = signEvent(signer, { type: "account_created", account_id: "acc_abc" }, 1);
  const b = signEvent(signerFromSeed(TEST_SEED), { type: "account_created", account_id: "acc_abc" }, 1);
  assert.equal(a.sig, b.sig);
  assert.match(signer.publicKeyHex, /^0x[0-9a-f]{64}$/);
  assert.throws(() => signerFromSeed("abc"), /32-byte/);
});

test("recordEvent stores the canonical JSON (with sig), ledger_seq NULL", () => {
  const db = openDb(":memory:");
  const ev = recordEvent(db, signer, { type: "account_created", account_id: "acc_abc" });
  const row = db.prepare("SELECT type, payload, gateway_sig, ledger_seq FROM ledger_events").get() as { type: string; payload: string; gateway_sig: string; ledger_seq: number | null };
  assert.equal(row.payload, canonicalJson(ev));
  assert.equal(row.gateway_sig, ev.sig);
  assert.equal(row.ledger_seq, null);
  db.close();
});

test("writer: appends in id order as one batch; ledger_seq = event id; requests get seq + tx", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO accounts (id, world_nullifier, created_at) VALUES ('acc_a', 'n', 1)").run();
  db.prepare("INSERT INTO requests (req_id, account_id, model, pay_type, route, status, prompt_hash, ts) VALUES ('req_1', 'acc_a', 'm', 'credits', NULL, 'ok', '0x00', 1)").run();
  recordEvent(db, signer, { type: "account_created", account_id: "acc_a" });
  recordEvent(db, signer, {
    type: "request_settled", req_id: "req_1", account_id: "acc_a", model: "m", in_tokens: 1, out_tokens: 1, cost_mc: 10,
    split: { nodes: {}, burn_mc: 0, reserve_mc: 10 }, pay: "credits", prompt_hash: `0x${"ab".repeat(32)}`, resp_hash: `0x${"cd".repeat(32)}`,
  });
  const sent: string[] = [];
  const chain = fakeLedgerChain((m) => { assert.ok(verifyEvent(JSON.parse(m), signer.publicKeyHex), "signed events go on chain unchanged"); sent.push(JSON.parse(m).type); });
  assert.equal(await flushOnce(db, chain), 2);
  assert.deepEqual(sent, ["account_created", "request_settled"]);
  const rows = db.prepare("SELECT id, ledger_seq, ledger_tx FROM ledger_events ORDER BY id").all() as { id: number; ledger_seq: number; ledger_tx: string }[];
  assert.deepEqual(rows.map((r) => r.ledger_seq), [1, 2]);
  assert.equal(rows[0]!.ledger_tx, fakeTxHash(1));
  assert.equal(rows[1]!.ledger_tx, fakeTxHash(1), "same batch, same tx");
  assert.deepEqual(db.prepare("SELECT ledger_seq, ledger_tx FROM requests WHERE req_id = 'req_1'").get(), { ledger_seq: 2, ledger_tx: fakeTxHash(1) });
  assert.equal(await flushOnce(db, { append: async () => { throw new Error("must not be called"); }, seq: async () => 0 }), 0);
  db.close();
});

test("writer: batches at most `max` events per transaction, in order", async () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 5; i++) recordEvent(db, signer, { type: "account_created", account_id: `acc_${i}` });
  const chain = fakeLedgerChain();
  assert.equal(await flushOnce(db, chain, 2), 2);
  assert.equal(await flushOnce(db, chain, 2), 2);
  assert.equal(await flushOnce(db, chain, 2), 1);
  assert.equal(chain.last, 5);
  const txs = (db.prepare("SELECT ledger_tx FROM ledger_events ORDER BY id").all() as { ledger_tx: string }[]).map((r) => r.ledger_tx);
  assert.deepEqual(txs, [fakeTxHash(1), fakeTxHash(1), fakeTxHash(2), fakeTxHash(2), fakeTxHash(3)]);
  db.close();
});

test("writer: a lost response is reconciled from the contract, never appended twice", async () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 3; i++) recordEvent(db, signer, { type: "account_created", account_id: `acc_${i}` });
  const chain = fakeLedgerChain();
  // The first attempt lands on the chain, but the gateway never hears back.
  const lost = { append: async (f: number, e: string[]) => { await chain.append(f, e); throw new Error("fetch failed: socket hang up"); }, seq: chain.seq.bind(chain) };
  await assert.rejects(flushOnce(db, lost), /socket hang up/);
  assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE ledger_seq IS NULL").get() as { n: number }).n, 3);
  // The retry is refused by the contract (expected first_seq 4) and the rows are marked final without a tx.
  assert.equal(await flushOnce(db, chain), 3);
  assert.equal(chain.last, 3, "nothing was appended twice");
  assert.deepEqual((db.prepare("SELECT ledger_seq, ledger_tx FROM ledger_events ORDER BY id").all() as object[]), [1, 2, 3].map((n) => ({ ledger_seq: n, ledger_tx: null })));
  db.close();
});

test("writer: a contract ahead of the database (fresh DB, old contract) stops with a clear error", async () => {
  const db = openDb(":memory:");
  recordEvent(db, signer, { type: "account_created", account_id: "acc_a" });
  const chain = fakeLedgerChain();
  await chain.append(1, ["{}", "{}", "{}", "{}"]);
  await assert.rejects(flushOnce(db, chain), /contract expects event 5, the gateway's next unsent event is 1: the database and the contract do not match/);
  assert.equal((db.prepare("SELECT ledger_seq FROM ledger_events").get() as { ledger_seq: number | null }).ledger_seq, null, "nothing is marked final");
  db.close();
});

test("writer loop: a failed append keeps rows unsent; the retry sends them in order", async () => {
  const db = openDb(":memory:");
  recordEvent(db, signer, { type: "account_created", account_id: "acc_a" });
  recordEvent(db, signer, { type: "account_created", account_id: "acc_b" });
  const order: string[] = [];
  const chain = fakeLedgerChain((m) => order.push(JSON.parse(m).account_id));
  let fail = true;
  const flaky = { append: async (f: number, e: string[]) => { if (fail) { fail = false; throw new Error("flaky"); } return chain.append(f, e); }, seq: chain.seq.bind(chain) };
  const stop = startLedgerWriter(db, flaky, 10);
  const end = Date.now() + 2000;
  while (order.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  stop();
  assert.deepEqual(order, ["acc_a", "acc_b"]);
  assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE ledger_seq IS NULL").get() as { n: number }).n, 0);
  db.close();
});
