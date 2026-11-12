import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "@near-js/crypto";
import type { FinalExecutionOutcome } from "@near-js/types";
import { CreditTopupResponse, LedgerEvent, MeResponse, NearNonceResponse, NearTopupResponse, NearVerifyResponse } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { availableMc } from "../src/ledger.ts";
import { createAgentKey } from "../src/incentives.ts";
import { nearLoginOrCreate, nep413Hash, verifyNep413, type NearKeyLookup } from "../src/near-auth.ts";
import type { NearTxLookup } from "../src/chain-credits.ts";
import { signer, testAccount, TEST_JWT_SECRET } from "./helpers.ts";

const ESCROW = "escrow.ramx.testnet";
const TREASURY = "treasury.ramx.testnet";
const AGENT = "agent-2.ramx.testnet";
const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET, ESCROW_CONTRACT_ID: ESCROW, X402_PAY_TO: TREASURY });
const USDC = cfg.net.x402_near.asset;
const TX = (n: number) => `9xQe${String(n).repeat(40)}`.slice(0, 44).replaceAll("0", "z");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const json = (o: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

/** A NEAR final outcome: one FunctionCall, optional logs on the contract's receipt, optional failure. */
function outcome(o: { signer: string; receiver: string; method: string; args: object; logs?: string[]; failed?: boolean }): FinalExecutionOutcome {
  const ok = { SuccessValue: "" };
  return {
    status: o.failed ? { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: refused" } } } } } : ok,
    transaction: { signer_id: o.signer, receiver_id: o.receiver, hash: "h", actions: [{ FunctionCall: { method_name: o.method, args: b64(o.args), gas: 1, deposit: "0" } }] },
    transaction_outcome: { id: "t", outcome: { logs: [], status: { SuccessReceiptId: "r" }, executor_id: o.signer } },
    receipts_outcome: [{ id: "r", outcome: { logs: o.logs ?? [], status: o.failed ? { Failure: {} } : ok, executor_id: o.receiver } }],
  } as unknown as FinalExecutionOutcome;
}
const paidLog = (d: object) => `EVENT_JSON:${JSON.stringify({ standard: "ramx-escrow", version: "1.0.0", event: "paid", data: [d] })}`;

function setup(txs: Record<string, FinalExecutionOutcome> = {}, keys: Record<string, "FullAccess" | "FunctionCall"> = {}) {
  const db = openDb(":memory:");
  const nearTx: NearTxLookup = async (hash) => { const t = txs[hash]; if (!t) throw new Error("UNKNOWN_TRANSACTION"); return t; };
  const nearKeys: NearKeyLookup = async (account, pk) => keys[`${account} ${pk}`] ?? null;
  return { db, app: createApp({ cfg, db, signer, nearTx, nearKeys }) };
}
const events = (db: Db, type: string) => (db.prepare("SELECT payload FROM ledger_events WHERE type = ?").all(type) as { payload: string }[]).map((r) => LedgerEvent.parse(JSON.parse(r.payload)));

test("NEP-413: a wallet signature over the gateway nonce verifies; any other message, recipient or key does not", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const nonce = new Uint8Array(32).fill(7);
  const sig = Buffer.from(kp.sign(nep413Hash("Log in to RAMX", nonce, "ramx")).signature).toString("base64");
  const pk = kp.getPublicKey().toString();
  assert.equal(verifyNep413(pk, sig, "Log in to RAMX", nonce, "ramx"), true);
  assert.equal(verifyNep413(pk, sig, "Log in to RAMX", nonce, "evil.app"), false);
  assert.equal(verifyNep413(pk, sig, "Send me your USDC", nonce, "ramx"), false);
  assert.equal(verifyNep413(KeyPair.fromRandom("ed25519").getPublicKey().toString(), sig, "Log in to RAMX", nonce, "ramx"), false);
  // Redirect wallets sign with a callbackUrl; it is part of the payload.
  const cb = "https://ramx.example/chat";
  const sigCb = Buffer.from(kp.sign(nep413Hash("Log in to RAMX", nonce, "ramx", cb)).signature).toString("base64");
  assert.equal(verifyNep413(pk, sigCb, "Log in to RAMX", nonce, "ramx", cb), true);
  assert.equal(verifyNep413(pk, sigCb, "Log in to RAMX", nonce, "ramx"), false);
});

test("NEAR login: nonce → signed → session; starter credits; payout = the NEAR account; nonce single use; FC keys refused", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const fc = KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey().toString();
  const { db, app } = setup({}, { [`alice.testnet ${pk}`]: "FullAccess", [`alice.testnet ${fc.getPublicKey().toString()}`]: "FunctionCall" });
  try {
    const signed = async (k: KeyPair) => {
      const n = NearNonceResponse.parse(await (await app.request("/auth/near/nonce", { method: "POST" })).json());
      const signature = Buffer.from(k.sign(nep413Hash(n.message, Buffer.from(n.nonce, "base64"), n.recipient)).signature).toString("base64");
      return { account_id: "alice.testnet", public_key: k.getPublicKey().toString(), signature, nonce: n.nonce };
    };
    const body = await signed(kp);
    const r = await app.request("/auth/near/verify", json(body));
    assert.equal(r.status, 200, await r.clone().text());
    const v = NearVerifyResponse.parse(await r.json());
    assert.deepEqual([v.new_account, v.starter_granted_mc, v.near_account], [true, 10_000_000, "alice.testnet"]);
    const me = MeResponse.parse(await (await app.request("/me", { headers: { authorization: `Bearer ${v.token}` } })).json());
    assert.equal(me.payout_address, "alice.testnet");
    assert.equal(me.balance.starter_mc, 10_000_000, "a new NEAR account gets starter credits");
    assert.equal(events(db, "starter_grant").length, 1);

    assert.equal((await app.request("/auth/near/verify", json(body))).status, 401, "replayed nonce");
    const again = NearVerifyResponse.parse(await (await app.request("/auth/near/verify", json(await signed(kp)))).json());
    assert.deepEqual([again.account_id, again.new_account, again.starter_granted_mc], [v.account_id, false, 0], "same wallet, same account, no second grant");
    const fcr = await app.request("/auth/near/verify", json(await signed(fc)));
    assert.equal(fcr.status, 401);
    assert.match(await fcr.text(), /function-call key/);
    const other = await signed(kp);
    assert.equal((await app.request("/auth/near/verify", json({ ...other, account_id: "bob.testnet" }))).status, 401, "key of another account");
  } finally { db.close(); }
});

test("NEAR login: STARTER_DAILY_GRANTS caps starter grants per rolling 24 h", () => {
  const capped = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET, STARTER_DAILY_GRANTS: "2" });
  const db = openDb(":memory:");
  try {
    const t0 = Date.now();
    const got = ["a", "b", "c"].map((n) => nearLoginOrCreate(db, capped, signer, `${n}.testnet`, t0).starterGrantedMc);
    assert.deepEqual(got, [10_000_000, 10_000_000, 0], "third new account today gets nothing");
    assert.equal(events(db, "starter_grant").length, 2);
    assert.equal(events(db, "account_created").length, 3);
    const late = nearLoginOrCreate(db, capped, signer, "d.testnet", t0 + 86_400_001);
    assert.equal(late.starterGrantedMc, 10_000_000, "the window rolls over after 24 h");
  } finally { db.close(); }
});

test("escrow credit: a guarded agent's `paid` event to the treasury with the key id as memo credits that key once", async () => {
  const { db } = setup();
  const owner = await testAccount(db, cfg);
  const key = createAgentKey(db, signer, owner.accountId, "guarded", null);
  const pay = (memo: string, payee = TREASURY, extra: { failed?: boolean; signer?: string } = {}) =>
    outcome({ signer: extra.signer ?? AGENT, receiver: ESCROW, method: "pay", args: { payee, amount: "500000", memo }, failed: extra.failed,
      logs: extra.failed ? [] : [paidLog({ agent: extra.signer ?? AGENT, payee, amount: "500000", memo })] });
  const txs = { [TX(1)]: pay(key.agent_id), [TX(2)]: pay("agt_someoneelse"), [TX(3)]: pay(key.agent_id, "rogue.testnet"), [TX(4)]: pay(key.agent_id, TREASURY, { failed: true }) };
  const { app } = { app: createApp({ cfg, db, signer, nearTx: async (h) => { const t = txs[h]; if (!t) throw new Error("UNKNOWN_TRANSACTION"); return t; } }) };
  try {
    const auth = { authorization: `Bearer ${key.token}` };
    const post = (tx: string) => app.request("/v1/credits/escrow", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ tx_hash: tx, agent_account: AGENT }) });
    const r = await post(TX(1));
    assert.equal(r.status, 200, await r.clone().text());
    const body = CreditTopupResponse.parse(await r.json());
    assert.deepEqual([body.amount_units, body.added_mc], ["500000", 500_000], "0.5 USDC = 500 credits");
    const replay = await post(TX(1));
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /already credited/);
    assert.match(await (await post(TX(2))).text(), /expected the API key id/);
    assert.match(await (await post(TX(3))).text(), /not the treasury/);
    assert.match(await (await post(TX(4))).text(), /failed/);
    assert.match(await (await post(TX(5))).text(), /not found on NEAR/);
    const ev = events(db, "credits_purchased");
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0]!.type === "credits_purchased" && [ev[0]!.via, ev[0]!.agent_id, ev[0]!.payer], ["escrow", key.agent_id, AGENT]);
    assert.equal((await app.request("/v1/credits/escrow", { method: "POST", headers: { "content-type": "application/json", ...owner.auth }, body: JSON.stringify({ tx_hash: TX(1), agent_account: AGENT }) })).status, 403, "sessions cannot use the key route");
  } finally { db.close(); }
});

test("wallet top-up: USDC ft_transfer to the treasury with the account id as memo → bought credits, spendable, once", async () => {
  const { db } = setup();
  const user = await testAccount(db, cfg);
  const transfer = (memo: string, receiver_id = TREASURY, method = "ft_transfer") => outcome({ signer: "alice.testnet", receiver: USDC, method, args: { receiver_id, amount: "1000000", memo } });
  const txs = { [TX(1)]: transfer(user.accountId), [TX(2)]: transfer("acc_other"), [TX(3)]: transfer(user.accountId, "rogue.testnet"), [TX(4)]: transfer(user.accountId, TREASURY, "ft_transfer_call") };
  const app = createApp({ cfg, db, signer, nearTx: async (h) => { const t = txs[h]; if (!t) throw new Error("UNKNOWN_TRANSACTION"); return t; } });
  try {
    const before = availableMc(db, user.accountId);
    const post = (tx: string) => app.request("/v1/credits/near-topup", { method: "POST", headers: { "content-type": "application/json", ...user.auth }, body: JSON.stringify({ tx_hash: tx, sender: "alice.testnet" }) });
    const r = await post(TX(1));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(NearTopupResponse.parse(await r.json()).added_mc, 1_000_000, "1 USDC = 1000 credits");
    assert.equal(availableMc(db, user.accountId), before + 1_000_000);
    const me = MeResponse.parse(await (await app.request("/me", { headers: user.auth })).json());
    assert.equal(me.balance.bought_mc, 1_000_000);
    assert.match(await (await post(TX(1))).text(), /already credited/);
    assert.match(await (await post(TX(2))).text(), /expected your account id/);
    assert.match(await (await post(TX(3))).text(), /not the treasury/);
    assert.match(await (await post(TX(4))).text(), /expected ft_transfer/);
    assert.equal((await app.request("/v1/credits/near-topup", json({ tx_hash: TX(1), sender: "alice.testnet" }))).status, 401, "needs a session");
  } finally { db.close(); }
});
