import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { E2EE_HEADERS, LedgerEvent, ModelsResponse, Receipt, REQUEST_ID_HEADER } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb, SCHEMA_VERSION } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { e2eeRequest, HASH_SALT_HEADER, promptHashOf, saltedHash } from "../src/privacy.ts";
import type { Directory } from "../src/router.ts";
import { signer, testAccount, TEST_JWT_SECRET } from "./helpers.ts";

/** End-to-end encryption to the enclave: RAMX relays ciphertext both ways and never decrypts. */
const MODEL = "Qwen/Qwen3-14B-FP8";
const CLIENT = "a".repeat(64), ENCLAVE = "b".repeat(64);
const CIPHER_IN = "c0ffee".repeat(30), CIPHER_OUT = "deadbeef".repeat(20);
const E2EE = { [E2EE_HEADERS.algo]: "ed25519", [E2EE_HEADERS.version]: "2", [E2EE_HEADERS.clientKey]: CLIENT, [E2EE_HEADERS.modelKey]: ENCLAVE };

let fake: Server;
const seen: { headers: IncomingHttpHeaders; body: Record<string, any> }[] = [];
before(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "chatcmpl-e2ee", object: "chat.completion", created: 1, model: "tee-model",
        choices: [{ index: 0, message: { role: "assistant", content: CIPHER_OUT }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
});
after(() => fake.close());

async function setup() {
  seen.length = 0;
  const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:9", DATABASE_PATH: ":memory:", JWT_SECRET: TEST_JWT_SECRET,
    NEARAI_API_KEY: "k-not-real", NEARAI_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`, NEARAI_MODEL_MAP: JSON.stringify({ [MODEL]: "tee/mapped-model" }) });
  const db = openDb(":memory:");
  const directory: Directory = { models: async () => cfg.net.models.map((m) => ({ ...m, type: "ramx.model" as const })), pools: async () => [], nodes: async () => [], readyPools: async () => [] };
  const app = createApp({ cfg, db, signer, directory, onComplete: () => {} });
  const me = await testAccount(db, cfg);
  const messages = [{ role: "user", content: CIPHER_IN }];
  const chat = (headers: Record<string, string>) => app.request("/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", ...me.auth, ...headers }, body: JSON.stringify({ model: MODEL, messages, max_tokens: 20 }) });
  const receipt = async (r: Response) => Receipt.parse(await (await app.request(`/requests/${r.headers.get(REQUEST_ID_HEADER)}`)).json());
  return { db, app, chat, receipt, messages };
}

test("schema version unchanged (no database reset)", () => assert.equal(SCHEMA_VERSION, 23));

test("e2ee headers: absent → null; all four well formed → forwarded; anything else refused", () => {
  const get = (h: Record<string, string>) => (n: string) => h[n];
  assert.equal(e2eeRequest(get({})), null);
  assert.deepEqual(e2eeRequest(get(E2EE)), { headers: E2EE });
  assert.ok("error" in e2eeRequest(get({ ...E2EE, [E2EE_HEADERS.version]: "1" }))!);
  assert.ok("error" in e2eeRequest(get({ ...E2EE, [E2EE_HEADERS.algo]: "ecdsa" }))!);
  assert.ok("error" in e2eeRequest(get({ ...E2EE, [E2EE_HEADERS.modelKey]: "zz" }))!);
  assert.ok("error" in e2eeRequest(get({ [E2EE_HEADERS.clientKey]: CLIENT }))!, "partial headers are refused, never silently ignored");
});

test("e2ee is refused without x-ramx-privacy: tee, so ciphertext can never be sent to a laptop", async () => {
  const s = await setup();
  for (const privacy of [undefined, "trusted-all", "trusted-ends"]) {
    const r = await s.chat({ ...E2EE, ...(privacy ? { "x-ramx-privacy": privacy } : {}) });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(await r.json()), /needs x-ramx-privacy: tee/);
  }
  assert.equal(seen.length, 0, "nothing was sent anywhere");
});

test("e2ee + tee: ciphertext relayed untouched both ways, headers pinned, hashes over ciphertext, signed e2ee flag", async () => {
  const s = await setup();
  const r = await s.chat({ ...E2EE, "x-ramx-privacy": "tee" });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.choices[0].message.content, CIPHER_OUT, "the answer is passed back still encrypted");
  assert.equal(seen.length, 1);
  const up = seen[0]!;
  assert.equal(up.body.messages[0].content, CIPHER_IN, "the gateway did not touch the encrypted message");
  assert.equal(up.headers[E2EE_HEADERS.clientKey], CLIENT);
  assert.equal(up.headers[E2EE_HEADERS.modelKey], ENCLAVE);
  assert.equal(up.headers[E2EE_HEADERS.version], "2");
  assert.equal(up.headers["x-no-aliasing"], "true");
  assert.equal(up.headers[REQUEST_ID_HEADER], undefined, "internal header is not forwarded");
  const salt = r.headers.get(HASH_SALT_HEADER)!;
  const rc = await s.receipt(r);
  assert.equal(rc.e2ee, true);
  assert.equal(rc.privacy, "tee");
  assert.equal(rc.prompt_hash, promptHashOf(salt, s.messages));
  assert.equal(rc.resp_hash, saltedHash(salt, CIPHER_OUT));
  const ev = JSON.parse((s.db.prepare("SELECT payload FROM ledger_events WHERE type = 'request_settled'").get() as { payload: string }).payload);
  assert.equal(ev.e2ee, true);
  assert.equal(ev.privacy, "tee");
  assert.ok(LedgerEvent.safeParse(ev).success);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM transcripts").get() as { n: number }).n, 0, "no transcript of an encrypted request");
});

test("plain tee requests are unchanged: no e2ee flag, no e2ee headers upstream", async () => {
  const s = await setup();
  const r = await s.chat({ "x-ramx-privacy": "tee" });
  assert.equal(r.status, 200);
  assert.equal(seen[0]!.headers[E2EE_HEADERS.clientKey], undefined);
  assert.equal(seen[0]!.headers["x-no-aliasing"], undefined);
  assert.equal((await s.receipt(r)).e2ee, false);
});

test("/v1/models names the enclave model to attest for each id", async () => {
  const s = await setup();
  const m = ModelsResponse.parse(await (await s.app.request("/v1/models")).json());
  assert.equal(m.data.find((d) => d.id === MODEL)?.tee_model, "tee/mapped-model");
});
