import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { balance, signer, testAccount, testDirectory, TEST_JWT_SECRET } from "./helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";
const waitFor = async (check: () => boolean) => {
  const until = Date.now() + 3000;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "condition did not become true");
};
const answer = () => Response.json({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });

test("gateway queues by real account ratio, x402=1; cancelled/queued requests do not hold or pay", async () => {
  const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET });
  cfg.net.router.max_concurrent_per_pool = 1; // one slot, so the later requests queue by ratio
  const db = openDb(":memory:");
  const originalFetch = globalThis.fetch;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  try {
    const baseDirectory = testDirectory(cfg, db);
    let lookups = 0;
    const directory = { ...baseDirectory, readyPools: async (model: string) => {
      lookups++;
      return baseDirectory.readyPools(model);
    } };
    const first = await testAccount(db, cfg);
    const low = await testAccount(db, cfg);
    const high = await testAccount(db, cfg);
    db.prepare("UPDATE balances SET earned_total_mc = 5000, spent_total_mc = 1000 WHERE account_id = ?").run(high.accountId);
    const started: string[] = [];
    let charges = 0;
    globalThis.fetch = async (_url, init) => {
      const prompt = JSON.parse(init!.body as string).messages[0].content;
      started.push(prompt);
      if (prompt === "first") await blocked;
      return answer();
    };
    const app = createApp({ cfg, db, signer, directory, onComplete: () => {}, x402: { charge: async () => {
      charges++;
      return { payer: "acct-1234.testnet", tx: "1AhdQxxjtvZvqsV8vWeVYZi6jGiK2wjJY1SF96qwezGY", amountUnits: "4000", asset: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", headers: {} };
    }, topup: async () => { throw new Error("unused"); } } });
    const send = (label: string, auth: Record<string, string>, signal?: AbortSignal) => app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", ...auth }, signal,
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: label }] }),
    });
    const running = send("first", first.auth);
    await waitFor(() => started.length === 1);
    assert.deepEqual(started, ["first"]);
    const cancel = new AbortController();
    const cancelled = send("cancelled", high.auth, cancel.signal);
    const waitingLow = send("low", low.auth);
    const waitingPaid = send("paid", {});
    const waitingHigh = send("high", high.auth);
    await waitFor(() => lookups >= 6);
    await setImmediate();
    assert.equal(charges, 0);
    assert.equal(balance(db, low.accountId).held_mc, 0);
    assert.equal(balance(db, high.accountId).held_mc, 0);
    cancel.abort();
    assert.equal((await cancelled).status, 408);
    unblock();
    const responses = await Promise.all([running, waitingLow, waitingPaid, waitingHigh]);
    assert.ok(responses.every((r) => r.status === 200));
    assert.deepEqual(started, ["first", "high", "paid", "low"]);
    assert.equal(charges, 1);
    assert.equal(balance(db, low.accountId).held_mc, 0);
    assert.equal(balance(db, high.accountId).held_mc, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM requests").get() as { n: number }).n, 4);
  } finally { unblock(); globalThis.fetch = originalFetch; db.close(); }
});

test("pool becoming stale during queue wait is rejected before taking a hold; later requests still run", async () => {
  const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET });
  cfg.net.router.max_concurrent_per_pool = 1; // the second request must wait in the queue
  const db = openDb(":memory:");
  const originalFetch = globalThis.fetch;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  try {
    const baseDirectory = testDirectory(cfg, db);
    let lookups = 0;
    const directory = { ...baseDirectory, readyPools: async (model: string) => {
      lookups++;
      return baseDirectory.readyPools(model);
    } };
    const account = await testAccount(db, cfg);
    let forwarded = 0;
    globalThis.fetch = async () => { forwarded++; if (forwarded === 1) await blocked; return answer(); };
    const app = createApp({ cfg, db, signer, directory, onComplete: () => {} });
    const send = () => app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...account.auth },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }) });
    const running = send();
    await waitFor(() => forwarded === 1);
    const waiting = send();
    await waitFor(() => lookups >= 3);
    await setImmediate();
    db.prepare("UPDATE nodes SET hb_online = 0").run();
    unblock();
    assert.equal((await running).status, 200);
    assert.equal((await waiting).status, 503);
    assert.equal(forwarded, 1);
    assert.equal(balance(db, account.accountId).held_mc, 0);
    db.prepare("UPDATE nodes SET hb_online = 1, hb_ts = ?").run(Date.now());
    assert.equal((await send()).status, 200);
    assert.equal(forwarded, 2);
  } finally { unblock(); globalThis.fetch = originalFetch; db.close(); }
});

test("credit completion rolls back balances and ledger event if reliability persistence fails; slot is released", async () => {
  const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET });
  const db = openDb(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    const directory = testDirectory(cfg, db);
    const account = await testAccount(db, cfg);
    const before = balance(db, account.accountId);
    const providerBefore = balance(db, "acc_router");
    db.exec(`CREATE TRIGGER fail_reliability BEFORE INSERT ON node_request_outcomes
      BEGIN SELECT RAISE(ABORT, 'simulated reliability storage failure'); END`);
    globalThis.fetch = async () => answer();
    const app = createApp({ cfg, db, signer, directory, onComplete: () => {} });
    const send = () => app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...account.auth },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }) });
    const response = await send();
    const receipt = await (await app.request(`/requests/${response.headers.get("x-ramx-request-id")}`)).json();
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.cost_mc, null);
    assert.deepEqual(balance(db, account.accountId), before);
    assert.deepEqual(balance(db, "acc_router"), providerBefore);
    assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE type = 'request_settled'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT response FROM transcripts WHERE req_id = ?").get(receipt.req_id) as { response: string | null }).response, null);
    db.exec("DROP TRIGGER fail_reliability");
    const next = await send();
    const nextReceipt = await (await app.request(`/requests/${next.headers.get("x-ramx-request-id")}`)).json();
    assert.equal(nextReceipt.status, "ok");
    assert.ok(nextReceipt.cost_mc > 0);
    assert.equal(balance(db, account.accountId).held_mc, 0);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
