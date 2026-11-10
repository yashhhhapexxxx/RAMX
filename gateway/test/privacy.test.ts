import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { request as httpsRequest, createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson, LedgerEvent, NODE_SIGNATURE_HEADER, Receipt, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { registerMessage } from "../src/nodes.ts";
import { urlHash } from "../src/formation.ts";
import { HASH_SALT_HEADER, open, promptHashOf, readTranscript, saltedHash, seal, tlsOptions } from "../src/privacy.ts";
import type { Directory } from "../src/router.ts";
import { signer, testAccount, TEST_JWT_SECRET } from "./helpers.ts";

/** Privacy (src/privacy.ts, SPEC §5.6). */
const MODEL = "Qwen/Qwen3-14B-FP8";
const KEY = "a1".repeat(32); // test key, not real
const K = [1, 2, 3].map((i) => privateKeyToAccount(`0x${String(i + 6).repeat(64)}` as `0x${string}`));
const id = (i: number) => K[i]!.address.toLowerCase();
const PROMPT = [{ role: "user", content: "hi" }];

let pool: Server;
before(async () => {
  pool = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "x", choices: [{ index: 0, message: { role: "assistant", content: "secret answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => pool.listen(0, "127.0.0.1", r));
});
after(() => pool.close());

/** Pool of 3 nodes [0,14) [14,28) [28,40); `owners[i]` = "me" (requester) or "stranger". */
async function setup(owners: ("me" | "stranger")[], env: Record<string, string> = {}) {
  const url = `http://127.0.0.1:${(pool.address() as AddressInfo).port}`;
  const cfg = loadConfig({ POOL_COORDINATOR_URL: url, DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET, TRANSCRIPT_KEY: KEY, ...env });
  const db = openDb(":memory:");
  const listing = () => ({ type: "ramx.pool" as const, reliability: 0.8, pool_id: "pool-x", models: [MODEL], status: "ready" as const, coordinator_url_hash: urlHash(url), layer_map: null,
    members: (db.prepare("SELECT node_id FROM nodes").all() as { node_id: string }[]).map((n) => n.node_id) });
  const directory: Directory = { models: async () => [], pools: async () => [listing()], nodes: async () => [], readyPools: async () => [listing()] };
  const app = createApp({ cfg, db, signer, directory, onComplete: () => {} });
  const me = await testAccount(db, cfg);
  const stranger = await testAccount(db, cfg);
  const ranges: [number, number][] = [[0, 14], [14, 28], [28, 40]];
  for (let i = 0; i < owners.length; i++) {
    const ts = Date.now();
    const auth = owners[i] === "me" ? me.auth : stranger.auth;
    const node_sig = await K[i]!.signMessage({ message: registerMessage(id(i), "pool-x", ts) });
    await app.request("/nodes/register", { method: "POST", headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ node_id: id(i), pool_id: "pool-x", gpu: "M4", mem_gb: 16, ts, node_sig, payout_address: "provider.testnet" }) });
    const raw = JSON.stringify({ node_id: id(i), pool_id: "pool-x", ts: Date.now(), online: true, model: MODEL, layers: ranges[i], tok_s: null });
    const sig = await K[i]!.signMessage({ message: { raw: new TextEncoder().encode(raw) } });
    assert.equal((await app.request("/nodes/heartbeat", { method: "POST", headers: { [NODE_SIGNATURE_HEADER]: sig }, body: raw })).status, 200);
  }
  const chat = (privacy?: string) => app.request("/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", ...me.auth, ...(privacy ? { "x-ramx-privacy": privacy } : {}) },
    body: JSON.stringify({ model: MODEL, messages: PROMPT, max_tokens: 20 }) });
  const receipt = async (r: Response) => (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json();
  return { cfg, db, app, me, stranger, chat, receipt };
}

test("transcripts at rest: AES-256-GCM, tamper-proof, plain text passes through", async () => {
  const s = await setup([]);
  const sealed = seal(s.cfg, "my private prompt")!;
  assert.match(sealed, /^enc:v1:/);
  assert.ok(!sealed.includes("private"));
  assert.notEqual(seal(s.cfg, "same"), seal(s.cfg, "same"), "random IV each time");
  assert.equal(open(s.cfg, sealed), "my private prompt");
  assert.equal(open(s.cfg, "legacy plain"), "legacy plain");
  assert.equal(seal(s.cfg, null), null);
  const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => open(s.cfg, tampered));
  const other = loadConfig({ POOL_COORDINATOR_URL: "http://x", DATABASE_PATH: ":memory:", TRANSCRIPT_KEY: "b2".repeat(32) });
  assert.throws(() => open(other, sealed), "wrong key cannot read it");
  s.db.close();
});

test("normal request: transcript stored encrypted; receipt + ledger have salted hashes; requester can check them", async () => {
  const s = await setup(["me", "stranger", "me"]);
  const r = await s.chat();
  assert.equal(r.status, 200);
  const salt = r.headers.get(HASH_SALT_HEADER)!;
  assert.match(salt, /^[0-9a-f]{32}$/);
  const rc = Receipt.parse(await s.receipt(r));
  assert.equal(rc.privacy, null);
  // Encrypted at rest; only the key holder reads it.
  const row = s.db.prepare("SELECT prompt, response FROM transcripts WHERE req_id = ?").get(rc.req_id) as { prompt: string; response: string };
  assert.match(row.prompt, /^enc:v1:/);
  assert.match(row.response, /^enc:v1:/);
  assert.deepEqual(readTranscript(s.db, s.cfg, rc.req_id), { prompt: canonicalJson(PROMPT), response: "secret answer" });
  // A dictionary guess of "hi" does not match the public hash; the requester's salt does.
  const naive = `0x${createHash("sha256").update(canonicalJson(PROMPT)).digest("hex")}`;
  assert.notEqual(rc.prompt_hash, naive);
  assert.equal(rc.prompt_hash, promptHashOf(salt, PROMPT));
  assert.equal(rc.resp_hash, saltedHash(salt, "secret answer"));
  const ev = LedgerEvent.parse(JSON.parse((s.db.prepare("SELECT payload FROM ledger_events WHERE type = 'request_settled'").get() as { payload: string }).payload));
  assert.equal(ev.type === "request_settled" && ev.prompt_hash, rc.prompt_hash);
  // The salt never leaves through the public receipt.
  assert.ok(!JSON.stringify(await s.receipt(r)).includes(salt));
  // Same prompt again → a different public hash.
  const r2 = await s.chat();
  assert.notEqual(Receipt.parse(await s.receipt(r2)).prompt_hash, rc.prompt_hash);
  s.db.close();
});

test("trusted-ends: first/last layers on my nodes is enough; trusted-all: needs every layer", async () => {
  const s = await setup(["me", "stranger", "me"]);
  const ends = await s.chat("trusted-ends");
  assert.equal(ends.status, 200);
  assert.equal(Receipt.parse(await s.receipt(ends)).privacy, "trusted-ends");
  const all = await s.chat("trusted-all");
  assert.equal(all.status, 503, "a stranger holds the middle layers");
  assert.equal((await s.chat("everything")).status, 400);
  // The operator trusts the stranger's account → allowed.
  s.cfg.env.TRUSTED_ACCOUNTS = s.stranger.accountId;
  assert.equal((await s.chat("trusted-all")).status, 200);
  s.db.close();
});

test("trusted-all on my own pool: served, privacy recorded, NO transcript stored", async () => {
  const s = await setup(["me", "me", "me"]);
  const r = await s.chat("trusted-all");
  assert.equal(r.status, 200);
  const rc = Receipt.parse(await s.receipt(r));
  assert.equal(rc.privacy, "trusted-all");
  assert.equal(rc.status, "ok");
  assert.ok(rc.cost_mc! > 0, "billed normally");
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM transcripts WHERE req_id = ?").get(rc.req_id) as { n: number }).n, 0);
  assert.equal(readTranscript(s.db, s.cfg, rc.req_id), undefined);
  s.db.close();
});

test("HTTPS: TLS_CERT_FILE + TLS_KEY_FILE serve the gateway over TLS; one without the other is an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ramx-tls-"));
  const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:", TLS_CERT_FILE: cert, TLS_KEY_FILE: key });
  const tls = tlsOptions(cfg)!;
  const db = openDb(":memory:");
  const app = createApp({ cfg, db, signer, onComplete: () => {} });
  const server = await new Promise<ReturnType<typeof serve>>((res) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", createServer: createHttpsServer, serverOptions: tls }, () => res(s));
  });
  const port = (server.address() as AddressInfo).port;
  const body = await new Promise<string>((res, rej) => {
    httpsRequest({ host: "127.0.0.1", port, path: "/healthz", ca: readFileSync(cert) }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej).end();
  });
  assert.deepEqual(JSON.parse(body), { ok: true });
  server.close();
  db.close();
  assert.equal(tlsOptions(loadConfig({ POOL_COORDINATOR_URL: "http://x", DATABASE_PATH: ":memory:" })), null);
  assert.throws(() => tlsOptions(loadConfig({ POOL_COORDINATOR_URL: "http://x", DATABASE_PATH: ":memory:", TLS_CERT_FILE: cert })), /both/);
});
