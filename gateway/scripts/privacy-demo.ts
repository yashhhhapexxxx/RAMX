#!/usr/bin/env node
/**
 * Privacy demo (src/privacy.ts, SPEC §5.6). Runs the real gateway code against a fake pool, a
 * temporary SQLite file and a real HTTPS server; no network, no keys, no money.
 *   pnpm --filter @ramx/gateway demo:privacy
 * Shows, with real values:
 *   1. trusted-ends / trusted-all routing (who may hold which layers)
 *   2. privacy requests store no transcript
 *   3. normal transcripts are encrypted on disk (raw SQLite row vs decrypted)
 *   4. salted hashes on the public ledger: a dictionary guess fails, the requester's salt works
 *   5. HTTPS with a self-signed certificate (openssl)
 */
import { createServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson, NODE_SIGNATURE_HEADER, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { registerMessage } from "../src/nodes.ts";
import { urlHash } from "../src/formation.ts";
import { HASH_SALT_HEADER, promptHashOf, readTranscript, tlsOptions } from "../src/privacy.ts";
import type { Directory } from "../src/router.ts";
import { signer, testAccount, TEST_JWT_SECRET } from "../test/helpers.ts";

const MODEL = "Qwen/Qwen3-14B-FP8";
const PROMPT = [{ role: "user", content: "My bank PIN is 4821. Is that safe?" }];
const line = (s = "") => console.log(s);
const head = (s: string) => { line(); line(`=== ${s} ===`); };
const short = (s: string, n = 72) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Fake Parallax scheduler.
const pool = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "No. Never share your PIN." }, finish_reason: "stop" }], usage: { prompt_tokens: 14, completion_tokens: 7, total_tokens: 21 } }));
  });
});
await new Promise<void>((r) => pool.listen(0, "127.0.0.1", r));
const poolUrl = `http://127.0.0.1:${(pool.address() as AddressInfo).port}`;

const dir = mkdtempSync(join(tmpdir(), "ramx-privacy-demo-"));
const dbPath = join(dir, "gateway.sqlite");
const transcriptKey = "5e".repeat(32); // demo key only
const cfg = loadConfig({ POOL_COORDINATOR_URL: poolUrl, DATABASE_PATH: dbPath, JWT_SECRET: TEST_JWT_SECRET, TRANSCRIPT_KEY: transcriptKey });
const db = openDb(dbPath);
const listing = () => ({ type: "ramx.pool" as const, reliability: 0.8, pool_id: "pool-demo", models: [MODEL], status: "ready" as const, coordinator_url_hash: urlHash(poolUrl), layer_map: null,
  members: (db.prepare("SELECT node_id FROM nodes").all() as { node_id: string }[]).map((n) => n.node_id) });
const directory: Directory = { models: async () => [], pools: async () => [listing()], nodes: async () => [], readyPools: async () => [listing()] };
const app = createApp({ cfg, db, signer, directory, onComplete: () => {} });

const alice = await testAccount(db, cfg, "0x" + "a1".repeat(32));   // the requester
const bob = await testAccount(db, cfg, "0x" + "b0".repeat(32));     // a stranger who also runs a node
const keys = [11, 12, 13].map((i) => privateKeyToAccount(`0x${String(i).repeat(32)}` as `0x${string}`));
const layout: [string, typeof alice, [number, number]][] = [["Alice's RTX 4060", alice, [0, 14]], ["Bob's MacBook", bob, [14, 28]], ["Alice's MacBook", alice, [28, 40]]];
for (let i = 0; i < 3; i++) {
  const k = keys[i]!, nid = k.address.toLowerCase(), ts = Date.now();
  const [, owner, layers] = layout[i]!;
  await app.request("/nodes/register", { method: "POST", headers: { "content-type": "application/json", ...owner.auth },
    body: JSON.stringify({ node_id: nid, pool_id: "pool-demo", gpu: "demo", mem_gb: 16, ts, node_sig: await k.signMessage({ message: registerMessage(nid, "pool-demo", ts) }), payout_address: "provider.testnet" }) });
  const raw = JSON.stringify({ node_id: nid, pool_id: "pool-demo", ts: Date.now(), online: true, model: MODEL, layers, tok_s: null });
  await app.request("/nodes/heartbeat", { method: "POST", headers: { [NODE_SIGNATURE_HEADER]: await k.signMessage({ message: { raw: new TextEncoder().encode(raw) } }) }, body: raw });
}
const chat = (privacy?: string) => app.request("/v1/chat/completions", { method: "POST",
  headers: { "content-type": "application/json", ...alice.auth, ...(privacy ? { "x-ramx-privacy": privacy } : {}) },
  body: JSON.stringify({ model: MODEL, messages: PROMPT, max_tokens: 50 }) });

head("Pool");
for (const [name, owner, layers] of layout) line(`  layers [${layers[0]}, ${layers[1]})  ${name.padEnd(18)} owner ${owner === alice ? "Alice (requester)" : "Bob (stranger)"}`);
line(`  prompt: ${JSON.stringify(PROMPT[0]!.content)}`);

head("1. Privacy routing (header x-ramx-privacy)");
const ends = await chat("trusted-ends");
line(`  trusted-ends → HTTP ${ends.status}  (first + last layers on Alice's nodes; Bob only sees middle hidden states)`);
const all = await chat("trusted-all");
line(`  trusted-all  → HTTP ${all.status}  (refused: Bob holds layers 14–28)`);
cfg.env.TRUSTED_ACCOUNTS = bob.accountId;
const allTrusted = await chat("trusted-all");
line(`  trusted-all with TRUSTED_ACCOUNTS=${bob.accountId} → HTTP ${allTrusted.status}`);
cfg.env.TRUSTED_ACCOUNTS = "";

head("2. Privacy requests keep no transcript");
const endsId = ends.headers.get(REQUEST_ID_HEADER)!;
const n = (db.prepare("SELECT count(*) AS n FROM transcripts WHERE req_id = ?").get(endsId) as { n: number }).n;
const receipt = await (await app.request(`/requests/${endsId}`)).json() as Record<string, unknown>;
line(`  ${endsId}: receipt privacy=${receipt.privacy}, status=${receipt.status}, cost_mc=${receipt.cost_mc}, transcript rows=${n}`);

head("3. Normal request: transcript encrypted on disk (AES-256-GCM)");
const normal = await chat();
const nid = normal.headers.get(REQUEST_ID_HEADER)!;
const raw = db.prepare("SELECT prompt, response FROM transcripts WHERE req_id = ?").get(nid) as { prompt: string; response: string };
line(`  raw SQLite prompt   : ${short(raw.prompt)}`);
line(`  raw SQLite response : ${short(raw.response)}`);
const plain = readTranscript(db, cfg, nid)!;
line(`  decrypted with TRANSCRIPT_KEY: ${short(plain.prompt)}  →  ${plain.response}`);
line(`  file contains the PIN in clear? ${readFileSync(dbPath).includes("4821") || readFileSync(dbPath + "-wal", { flag: "a+" }).includes("4821") ? "YES" : "no"}`);

head("4. Salted hashes on the public ledger (ledger)");
const salt = normal.headers.get(HASH_SALT_HEADER)!;
const pub = (await (await app.request(`/requests/${nid}`)).json() as { prompt_hash: string }).prompt_hash;
const guess = `0x${createHash("sha256").update(canonicalJson(PROMPT)).digest("hex")}`;
line(`  public prompt_hash          : ${pub}`);
line(`  attacker guess sha256(prompt): ${guess}  → ${guess === pub ? "MATCH (leak!)" : "no match"}`);
line(`  requester salt (header ${HASH_SALT_HEADER}): ${salt}`);
line(`  requester check sha256(salt:prompt): ${promptHashOf(salt, PROMPT) === pub ? "matches the receipt" : "MISMATCH"}`);
const again = await chat();
line(`  same prompt again → new public hash: ${(await (await app.request(`/requests/${again.headers.get(REQUEST_ID_HEADER)}`)).json() as { prompt_hash: string }).prompt_hash}`);

head("5. HTTPS (TLS_CERT_FILE + TLS_KEY_FILE)");
try {
  const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const tcfg = loadConfig({ POOL_COORDINATOR_URL: poolUrl, DATABASE_PATH: ":memory:", TLS_CERT_FILE: cert, TLS_KEY_FILE: key });
  const tdb = openDb(":memory:");
  const tapp = createApp({ cfg: tcfg, db: tdb, signer, directory, onComplete: () => {} });
  const server = await new Promise<ReturnType<typeof serve>>((res) => { const s = serve({ fetch: tapp.fetch, port: 0, hostname: "127.0.0.1", createServer: createHttpsServer, serverOptions: tlsOptions(tcfg)! }, () => res(s)); });
  const port = (server.address() as AddressInfo).port;
  const out = await new Promise<{ body: string; proto: string }>((res, rej) => {
    httpsRequest({ host: "127.0.0.1", port, path: "/healthz", ca: readFileSync(cert) }, (r) => {
      const proto = (r.socket as unknown as { getProtocol(): string }).getProtocol();
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res({ body: d, proto }));
    }).on("error", rej).end();
  });
  line(`  https://127.0.0.1:${port}/healthz → ${out.body} over ${out.proto}`);
  server.close();
  tdb.close();
} catch (e) {
  line(`  skipped: ${(e as Error).message} (needs openssl)`);
}

head("6. Nodes never log prompts");
line("  pool/join-node.sh and pool/start-scheduler.sh refuse --verbose / --log-level debug (Parallax logs prompts at debug); ALLOW_DEBUG_LOGS=1 overrides.");
line();
db.close();
pool.close();
