import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { openDb } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";
import { ProviderRelay } from "../src/provider-relay.ts";
import { providerUrl } from "../src/provider-state.ts";
import { providerBundle } from "../src/provider-assets.ts";
import { registerMessage } from "../src/nodes.ts";
import { urlHash } from "../src/formation.ts";
import { signer, testAccount, TEST_JWT_SECRET } from "./helpers.ts";
import type { Directory } from "../src/router.ts";

const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:3001", DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET, PUBLIC_URL: "https://marketplace.test" });
const payout = "provider-owner.testnet";
const post = (body: unknown, token?: string) => ({ method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

async function setup() {
  const db = openDb(":memory:");
  const relay = new ProviderRelay();
  const directory: Directory = {
    models: async () => cfg.net.models.map(m => ({ type: "ramx.model", ...m })), nodes: async () => [], pools: async () => [],
    readyPools: async model => (db.prepare("SELECT pool_id FROM provider_pools").all() as { pool_id: string }[]).map(p => ({ type: "ramx.pool", pool_id: p.pool_id, models: [model],
      members: (db.prepare("SELECT node_id FROM nodes WHERE pool_id=?").all(p.pool_id) as { node_id: string }[]).map(n => n.node_id),
      status: "ready", reliability: 0.8, coordinator_url_hash: urlHash(providerUrl(p.pool_id)), layer_map: null })),
  };
  const app = createApp({ db, cfg, signer, providerRelay: relay, directory, onComplete: () => {} });
  const owner = await testAccount(db, cfg);
  const response = await app.request("/provider/pools", post({ name: "Ethernet crew", model: cfg.net.models[1]!.model_id, expected_members: 2, payout_address: payout }, owner.token));
  assert.equal(response.status, 201, await response.clone().text());
  const pool = await response.json();
  return { db, relay, app, owner, pool };
}

async function pair(s: Awaited<ReturnType<typeof setup>>, owner = s.owner, pool = s.pool, override: Record<string, unknown> = {}) {
  const enrollResponse = await s.app.request(`/provider/pools/${pool.pool_id}/enroll`, post({}, owner.token));
  assert.equal(enrollResponse.status, 200, await enrollResponse.clone().text());
  const enrollment = await enrollResponse.json();
  const code = /--code '([a-f0-9]+)'/.exec(enrollment.command)![1]!;
  const key = privateKeyToAccount(generatePrivateKey()), ts = Date.now();
  const body = { code, node_id: key.address.toLowerCase(), pool_id: pool.pool_id, ts, gpu: "Test GPU", mem_gb: 16,
    node_sig: await key.signMessage({ message: registerMessage(key.address.toLowerCase(), pool.pool_id, ts) }), ...override };
  const response = await s.app.request("/provider/enroll/claim", post(body));
  return { response, body, key, code, credential: response.ok ? await response.clone().json() : null };
}

test("provider create/join is World-session gated; membership requires coordinator approval", async () => {
  const s = await setup();
  try {
    assert.equal((await s.app.request("/provider/pools")).status, 401);
    const overview = await (await s.app.request("/provider/pools", { headers: s.owner.auth })).json();
    assert.equal(overview.pools.length, 1);
    const other = await testAccount(s.db, cfg);
    const joined = await s.app.request("/provider/pools/join", post({ pool_id: s.pool.pool_id, payout_address: payout }, other.token));
    assert.equal(joined.status, 201);
    assert.equal((await s.app.request(`/provider/pools/${s.pool.pool_id}/enroll`, post({}, other.token))).status, 403);
    const membership = (await joined.json()).members.find((m: { account_id: string }) => m.account_id === other.accountId);
    assert.equal((await s.app.request(`/provider/pools/${s.pool.pool_id}/members/${membership.id}/approve`, post({}, other.token))).status, 403);
    assert.equal((await s.app.request(`/provider/pools/${s.pool.pool_id}/members/${membership.id}/approve`, post({}, s.owner.token))).status, 200);
    const paired = await pair(s, other);
    assert.equal(paired.response.status, 200, await paired.response.clone().text());
  } finally { s.db.close(); }
});

test("single-use enrollment binds a signed node; helper cannot choose a payout or access marketplace credentials", async () => {
  const s = await setup();
  try {
    const paired = await pair(s, s.owner, s.pool, { payout_address: "someone-else.testnet" });
    assert.equal(paired.response.status, 200, await paired.response.clone().text());
    assert.equal((s.db.prepare("SELECT payout_address FROM accounts WHERE id=?").get(s.owner.accountId) as { payout_address: string }).payout_address, payout);
    assert.equal((await s.app.request("/provider/enroll/claim", post(paired.body))).status, 401);
    assert.equal((await s.app.request("/provider/pools", { headers: { authorization: `Bearer ${paired.credential.token}` } })).status, 401);
    const response = await s.app.request("/provider/helper/config", { headers: { authorization: `Bearer ${paired.credential.token}` } });
    assert.equal(response.status, 200);
    const config = await response.json();
    assert.equal(config.role, "coordinator");
    assert.equal(config.coordinator_ip, null);
    for (const key of ["JWT_SECRET", "GATEWAY_SIGNING_KEY", "WORLD_RP_SIGNING_KEY", "SETTLER_KEY", "NEAR_GATEWAY_KEY", "X402_RELAYER_KEY"]) assert.equal(JSON.stringify(config).includes(key), false);
    const stored = s.db.prepare("SELECT token_hash FROM provider_members WHERE id=?").get(paired.credential.member_id) as { token_hash: string };
    assert.notEqual(stored.token_hash, paired.credential.token);
    assert.equal(stored.token_hash, createHash("sha256").update(paired.credential.token).digest("hex"));
  } finally { s.db.close(); }
});

test("expired enrollment and unapproved direct registrations cannot bypass pool admission", async () => {
  const s = await setup();
  try {
    const other = await testAccount(s.db, cfg), key = privateKeyToAccount(generatePrivateKey()), ts = Date.now();
    const body = { node_id: key.address.toLowerCase(), pool_id: s.pool.pool_id, ts, gpu: "GPU", mem_gb: 16, payout_address: payout,
      node_sig: await key.signMessage({ message: registerMessage(key.address.toLowerCase(), s.pool.pool_id, ts) }) };
    assert.equal((await s.app.request("/nodes/register", post(body, other.token))).status, 403);
    await s.app.request(`/provider/pools/${s.pool.pool_id}/enroll`, post({}, s.owner.token));
    s.db.prepare("UPDATE provider_enrollments SET expires_at=0").run();
    assert.equal((await s.app.request("/provider/enroll/info", post({ code: "a".repeat(48) }))).status, 401);
  } finally { s.db.close(); }
});

test("revoking a member immediately invalidates its helper credential", async () => {
  const s = await setup();
  try {
    const other = await testAccount(s.db, cfg);
    const joined = await (await s.app.request("/provider/pools/join", post({ pool_id: s.pool.pool_id, payout_address: payout }, other.token))).json();
    const member = joined.members.find((m: { account_id: string }) => m.account_id === other.accountId);
    await s.app.request(`/provider/pools/${s.pool.pool_id}/members/${member.id}/approve`, post({}, s.owner.token));
    const paired = await pair(s, other);
    await s.app.request(`/provider/pools/${s.pool.pool_id}/members/${member.id}/revoke`, post({}, s.owner.token));
    assert.equal((await s.app.request("/provider/helper/config", { headers: { authorization: `Bearer ${paired.credential.token}` } })).status, 401);
  } finally { s.db.close(); }
});

test("outbound relay streams ordered parts as they arrive, rejects foreign or out-of-order parts and expires cancelled work", async () => {
  const relay = new ProviderRelay();
  const result = relay.forward("pool-a", "/v1/chat/completions", { stream: true });
  const job = await relay.poll("pool-a");
  assert.ok(job);
  const enc = (t: string) => new TextEncoder().encode(t);
  assert.throws(() => relay.part("pool-b", job.id, 0, 200, "text/event-stream", enc("x"), false), /unknown/);
  assert.throws(() => relay.part("pool-a", job.id, 1, 200, "text/event-stream", enc("x"), false), /unknown/); // must start at 0
  relay.part("pool-a", job.id, 0, 200, "text/event-stream", enc("data: token\n\n"), false);
  const response = await result; // the client's response starts with the first part, before the answer ends
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: token\n\n");
  relay.part("pool-a", job.id, 1, 200, "text/event-stream", enc("data: [DONE]\n\n"), true);
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: [DONE]\n\n");
  assert.equal((await reader.read()).done, true);
  assert.throws(() => relay.part("pool-a", job.id, 2, 200, "text/event-stream", enc("late"), false), /unknown/);
  const abort = new AbortController();
  const cancelled = relay.forward("pool-a", "/v1/chat/completions", {}, abort.signal);
  const check = assert.rejects(cancelled, /cancelled/);
  abort.abort(); await check;
});

test("helper bundle is a valid source-only ZIP with no marketplace credentials or gateway implementation", () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-bundle-"));
  try {
    const path = join(directory, "bundle.zip"); writeFileSync(path, providerBundle());
    const output = execFileSync("python3", ["-c", "import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(z.namelist()))", path], { encoding: "utf8" });
    const names: string[] = JSON.parse(output);
    assert.ok(names.includes("pool/bootstrap/host.py"));
    assert.ok(names.includes("node-agent/uv.lock"));
    assert.ok(names.every(n => !n.startsWith("gateway/") && !n.endsWith(".env") && !n.endsWith(".key")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("start waits for every approved helper, then real signed heartbeats gate readiness and relayed inference uses normal credit settlement", async () => {
  const s = await setup();
  try {
    const coordinator = await pair(s);
    const secondOwner = await testAccount(s.db, cfg);
    const joined = await (await s.app.request("/provider/pools/join", post({ pool_id: s.pool.pool_id, payout_address: payout }, secondOwner.token))).json();
    const member = joined.members.find((m: { account_id: string }) => m.account_id === secondOwner.accountId);
    await s.app.request(`/provider/pools/${s.pool.pool_id}/members/${member.id}/approve`, post({}, s.owner.token));
    const second = await pair(s, secondOwner);
    const model = cfg.net.models[1]!.model_id;
    const snapshot = { revision: "a".repeat(40), files: { "config.json": { size: 2, sha256: "b".repeat(64) }, "model.safetensors": { size: 3, sha256: "c".repeat(64) } } };
    // No snapshot at all is refused; an MLX-only coordinator (all-Mac pool, no GPU copy) is accepted.
    assert.equal((await s.app.request("/provider/helper/snapshots", post({}, coordinator.credential.token))).status, 400);
    assert.equal((await s.app.request("/provider/helper/snapshots", post({ [cfg.net.models[1]!.mlx_variant!]: snapshot }, coordinator.credential.token))).status, 200);
    const snapshots = await s.app.request("/provider/helper/snapshots", post({ [model]: snapshot, [cfg.net.models[1]!.mlx_variant!]: snapshot }, coordinator.credential.token));
    assert.equal(snapshots.status, 200);
    await s.app.request("/provider/helper/progress", post({ stage: "prepared", ip: "10.0.0.1" }, coordinator.credential.token));
    assert.equal((s.db.prepare("SELECT state FROM provider_pools").get() as { state: string }).state, "preparing");
    await s.app.request("/provider/helper/progress", post({ stage: "prepared", ip: "10.0.0.2" }, second.credential.token));
    assert.equal((s.db.prepare("SELECT state FROM provider_pools").get() as { state: string }).state, "starting");
    assert.equal((await s.app.request("/provider/helper/ready", post({}, coordinator.credential.token))).status, 409);
    assert.equal((await s.app.request("/provider/helper/scheduler", post({ address: "/ip4/10.0.0.1/tcp/5100/p2p/12D3KooWtest" }, second.credential.token))).status, 403);
    assert.equal((await s.app.request("/provider/helper/scheduler", post({ address: "/ip4/10.0.0.1/tcp/5100/p2p/12D3KooWtest" }, coordinator.credential.token))).status, 200);
    for (const [actor, layers] of [[coordinator, [0, 20]], [second, [20, 40]]] as const) {
      const body = JSON.stringify({ node_id: actor.key.address.toLowerCase(), pool_id: s.pool.pool_id, ts: Date.now(), online: true, model, layers, tok_s: null });
      const signature = await actor.key.signMessage({ message: body });
      const heartbeat = await s.app.request("/nodes/heartbeat", { method: "POST", headers: { "content-type": "application/json", "x-ramx-node-signature": signature }, body });
      assert.equal(heartbeat.status, 200, await heartbeat.clone().text());
    }
    assert.equal((await s.app.request("/provider/helper/ready", post({}, coordinator.credential.token))).status, 200);
    const payer = await testAccount(s.db, cfg);
    const before = (s.db.prepare("SELECT starter_mc FROM balances WHERE account_id=?").get(payer.accountId) as { starter_mc: number }).starter_mc;
    const inference = s.app.request("/v1/chat/completions", post({ model, messages: [{ role: "user", content: "Hello" }], max_tokens: 16 }, payer.token));
    const job = (await (await s.app.request("/provider/helper/jobs", { headers: { authorization: `Bearer ${coordinator.credential.token}` } })).json()).job;
    assert.ok(job);
    assert.equal(job.path, "/v1/chat/completions");
    const uploaded = s.app.request(`/provider/helper/jobs/${job.id}/parts`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${coordinator.credential.token}`, "x-part-seq": "0", "x-part-final": "1", "x-upstream-status": "200" },
      body: JSON.stringify({ choices: [{ message: { content: "Hello" } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }) });
    const result = await inference;
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).choices[0].message.content, "Hello");
    assert.equal((await uploaded).status, 200);
    const after = s.db.prepare("SELECT starter_mc,held_mc FROM balances WHERE account_id=?").get(payer.accountId) as { starter_mc: number; held_mc: number };
    assert.equal(before - after.starter_mc, 5950);
    assert.equal(after.held_mc, 0);
    assert.equal((s.db.prepare("SELECT count(*) AS n FROM ledger_events WHERE type='request_settled'").get() as { n: number }).n, 1);
  } finally { s.db.close(); }
});

test("Python helper relays token SSE over a real chunked HTTP upload and central billing settles once", async () => {
  const s = await setup();
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    setTimeout(() => res.end('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n'), 20);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const gateway = serve({ fetch: s.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!gateway.listening) await new Promise<void>(resolve => gateway.once("listening", resolve));
  try {
    const coordinator = await pair(s);
    s.db.prepare("UPDATE provider_pools SET state='ready'").run();
    s.db.prepare("UPDATE nodes SET hb_online=1,hb_ts=?,hb_model=?,hb_layers='[0,40]'").run(Date.now(), cfg.net.models[1]!.model_id);
    const payer = await testAccount(s.db, cfg), base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    const response = fetch(base + "/v1/chat/completions", post({ model: cfg.net.models[1]!.model_id, messages: [{ role: "user", content: "Hello" }], max_tokens: 16, stream: true }, payer.token));
    const job = (await (await fetch(base + "/provider/helper/jobs", { headers: { authorization: `Bearer ${coordinator.credential.token}` } })).json()).job;
    const script = `import importlib.util,json,sys; p=json.load(sys.stdin); s=importlib.util.spec_from_file_location('helper',p['file']); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.forward_job(p['base'],p['token'],p['job'],p['port'])`;
    const child = spawn("python3", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    const finished = new Promise<void>((resolve, reject) => child.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr))));
    child.stdin.end(JSON.stringify({ file: new URL("../../pool/provider/helper.py", import.meta.url).pathname, base, token: coordinator.credential.token, job, port: (upstream.address() as AddressInfo).port }));
    const output = await response;
    assert.equal(output.status, 200);
    const text = await output.text();
    assert.match(text, /Hello/); assert.equal(text.split("[DONE]").length, 2);
    await finished;
    assert.equal((s.db.prepare("SELECT count(*) AS n FROM ledger_events WHERE type='request_settled'").get() as { n: number }).n, 1);
  } finally { if ("closeAllConnections" in gateway) gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); s.db.close(); }
});
