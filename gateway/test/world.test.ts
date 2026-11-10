import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeRpSignatureMessage } from "@worldcoin/idkit-core/signing";
import { ErrorResponse, MeResponse, RpSignatureResponse, WorldVerifyResponse } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import type { WorldFetch } from "../src/world.ts";
import { signer, TEST_JWT_SECRET } from "./helpers.ts";

const RP_KEY = `0x${"ab".repeat(32)}`; // test key, not real
const env = {
  POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET,
  WORLD_APP_ID: "app_0123abcd", WORLD_RP_ID: "rp_0123abcd", WORLD_RP_SIGNING_KEY: RP_KEY, WORLD_ACTION: "ramx-account",
  WORLD_ENVIRONMENT: "staging", STARTER_CREDITS: "10000", STARTER_EXPIRY_DAYS: "14", GATEWAY_SIGNING_KEY: "11".repeat(32),
};

/** Mocked World verify API. `reply` decides the answer per call; `calls` records what the gateway sent. */
function world(reply: (body: any) => { status: number; body: unknown }) {
  const calls: { url: string; body: any }[] = [];
  const f: WorldFetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const r = reply(body);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
  return { f, calls };
}

const idkitResult = (nullifier: string, identifier = "selfie") => ({
  protocol_version: "4.0", nonce: "0x01", action: "ramx-account", environment: "staging",
  responses: [{ identifier, issuer_schema_id: identifier === "selfie" ? 11 : 1, nullifier, proof: ["0x1"], signal_hash: "0x0" }],
});
const ok = (nullifier: string, identifier = "selfie", message = "Proof verified successfully") => ({
  status: 200,
  body: { success: true, action: "ramx-account", nullifier, environment: "staging", protocol_version: "4.0", results: [{ identifier, success: true, nullifier }], message },
});

function setup(reply: (body: any) => { status: number; body: unknown }) {
  const cfg = loadConfig(env);
  const db = openDb(":memory:");
  const w = world(reply);
  const app = createApp({ cfg, db, signer, worldFetch: w.f });
  const verify = (body: unknown) => app.request("/auth/world/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { db, app, verify, calls: w.calls };
}

test("rp-signature: IDKit v4 fields; the signature recovers to the RP signing key's address", async () => {
  const { app, db } = setup(() => ({ status: 500, body: {} }));
  const r = await app.request("/auth/world/rp-signature", { method: "POST" });
  assert.equal(r.status, 200);
  const s = RpSignatureResponse.parse(await r.json());
  assert.equal(s.rp_id, "rp_0123abcd");
  assert.equal(s.expires_at - s.created_at, 300);
  const msg = computeRpSignatureMessage(Buffer.from(s.nonce.slice(2), "hex"), s.created_at, s.expires_at, s.action);
  assert.equal(msg.length, 81);
  const addr = await recoverMessageAddress({ message: { raw: msg }, signature: s.sig as `0x${string}` });
  assert.equal(addr, privateKeyToAccount(RP_KEY as `0x${string}`).address);
  db.close();
});

test("success: new human → account + starter credits + session; result forwarded unchanged; /me works", async () => {
  const { verify, calls, db, app } = setup((b) => ok(b.responses[0].nullifier));
  const input = idkitResult("0xAA01");
  const r = await verify(input);
  assert.equal(r.status, 200);
  const body = WorldVerifyResponse.parse(await r.json());
  assert.equal(body.new_account, true);
  assert.equal(body.starter_granted_mc, 10_000_000);
  assert.equal(calls[0]!.url, "https://developer.world.org/api/v4/verify/rp_0123abcd");
  assert.deepEqual(calls[0]!.body, input);
  const types = (db.prepare("SELECT type FROM ledger_events ORDER BY id").all() as { type: string }[]).map((x) => x.type);
  assert.deepEqual(types, ["account_created", "starter_grant"]);
  const me = MeResponse.parse(await (await app.request("/me", { headers: { authorization: `Bearer ${body.token}` } })).json());
  assert.equal(me.account_id, body.account_id);
  assert.equal(me.balance.starter_mc, 10_000_000);
  assert.deepEqual(me.nodes, []);
  db.close();
});

test("duplicate: same human again (World says 'nullifier reuse') → same account, no second grant", async () => {
  const { verify, db } = setup((b) => ok(b.responses[0].nullifier, "proof_of_human", "Proof verified successfully (nullifier reuse)"));
  const a = WorldVerifyResponse.parse(await (await verify(idkitResult("0x00aa02", "proof_of_human"))).json());
  // Same nullifier written differently (case, leading zeros) maps to the same account.
  const b = WorldVerifyResponse.parse(await (await verify(idkitResult("0xAA02", "proof_of_human"))).json());
  assert.equal(a.new_account, true);
  assert.equal(b.new_account, false);
  assert.equal(b.starter_granted_mc, 0);
  assert.equal(b.account_id, a.account_id);
  assert.equal((db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events WHERE type = 'starter_grant'").get() as { n: number }).n, 1);
  db.close();
});

test("World rejects → 401, no account", async () => {
  const { verify, db } = setup(() => ({ status: 400, body: { success: false, code: "all_verifications_failed", detail: "All verifications failed", results: [] } }));
  const r = await verify(idkitResult("0xbb"));
  assert.equal(r.status, 401);
  const e = ErrorResponse.parse(await r.json());
  assert.equal(e.error.code, "unauthorized");
  assert.match(e.error.message, /all_verifications_failed/);
  assert.equal((db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n, 0);
  db.close();
});

test("credential not Orb/Passport/Selfie (device) → 401; wrong action/environment → 400 without calling World", async () => {
  const { verify, calls, db } = setup((b) => ok(b.responses[0].nullifier, "device"));
  assert.equal((await verify(idkitResult("0xcc", "device"))).status, 401);
  assert.equal((await verify({ ...idkitResult("0xcc"), action: "other" })).status, 400);
  assert.equal((await verify({ ...idkitResult("0xcc"), environment: "production" })).status, 400);
  assert.equal(calls.length, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n, 0);
  db.close();
});

test("cancel: the user closes the widget → the frontend sends nothing → nothing changes; bad tokens are 401", async () => {
  const { app, db } = setup(() => ({ status: 200, body: {} }));
  // Only an rp-signature was fetched; no verify call.
  await app.request("/auth/world/rp-signature", { method: "POST" });
  assert.equal((db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM ledger_events").get() as { n: number }).n, 0);
  assert.equal((await app.request("/me")).status, 401);
  assert.equal((await app.request("/me", { headers: { authorization: "Bearer nope" } })).status, 401);
  // An invalid token on chat is 401, never x402.
  const r = await app.request("/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: JSON.stringify({ model: "Qwen/Qwen3-14B-FP8", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(r.status, 401);
  db.close();
});

test("simulator device accounts (staging, temporary): same nullifier + different browsers → different accounts; header required", async () => {
  const cfg = loadConfig({ ...env, WORLD_SIMULATOR_DEVICE_ACCOUNTS: "true" });
  const db = openDb(":memory:");
  const w = world((b) => ok(b.responses[0].nullifier));
  const app = createApp({ cfg, db, signer, worldFetch: w.f });
  const verify = (device?: string) => app.request("/auth/world/verify", { method: "POST", headers: { "content-type": "application/json", ...(device ? { "x-ramx-device": device } : {}) }, body: JSON.stringify(idkitResult("0xAA05")) });
  const a = WorldVerifyResponse.parse(await (await verify("a".repeat(32))).json());
  const b = WorldVerifyResponse.parse(await (await verify("b".repeat(32))).json());
  const a2 = WorldVerifyResponse.parse(await (await verify("A".repeat(32))).json());
  assert.notEqual(a.account_id, b.account_id);
  assert.equal(a2.account_id, a.account_id);
  assert.equal(a2.new_account, false);
  const missing = await verify();
  assert.equal(missing.status, 400);
  ErrorResponse.parse(await missing.json());
  // The device header is never forwarded to World.
  assert.deepEqual(w.calls[0]!.body, idkitResult("0xAA05"));
  db.close();
});

test("simulator device accounts are refused in production; header ignored when the flag is off", async () => {
  const prod = setupWith({ WORLD_ENVIRONMENT: "production", WORLD_SIMULATOR_DEVICE_ACCOUNTS: "true" });
  assert.equal((await prod.app.request("/auth/world/rp-signature", { method: "POST" })).status, 500);
  prod.db.close();
  const off = setupWith({});
  const r = (d: string) => off.app.request("/auth/world/verify", { method: "POST", headers: { "content-type": "application/json", "x-ramx-device": d }, body: JSON.stringify(idkitResult("0xAA06")) });
  const a = WorldVerifyResponse.parse(await (await r("a".repeat(32))).json());
  const b = WorldVerifyResponse.parse(await (await r("b".repeat(32))).json());
  assert.equal(a.account_id, b.account_id);
  off.db.close();
});

function setupWith(extra: Record<string, string>) {
  const cfg = loadConfig({ ...env, ...extra });
  const db = openDb(":memory:");
  return { db, app: createApp({ cfg, db, signer, worldFetch: world((b) => ok(b.responses[0].nullifier)).f }) };
}
