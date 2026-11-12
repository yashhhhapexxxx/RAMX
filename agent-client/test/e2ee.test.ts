import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptWith, e2eeHeaders, encryptMessages, encryptTo, enclaveKeyFrom, newClientKey } from "../src/e2ee.ts";

test("encrypt to a key, decrypt only with its secret; fresh ephemeral key and nonce every time", () => {
  const enclave = newClientKey();
  const a = encryptTo("meet Priya at 7pm", enclave.publicHex);
  assert.equal(decryptWith(a, enclave.secret), "meet Priya at 7pm");
  assert.notEqual(a, encryptTo("meet Priya at 7pm", enclave.publicHex));
  assert.ok(!Buffer.from(a, "hex").toString("utf8").includes("Priya"));
  assert.throws(() => decryptWith(a, newClientKey().secret), "another key cannot read it");
});

test("tampering is detected", () => {
  const k = newClientKey();
  const c = encryptTo("hello", k.publicHex);
  const flipped = c.slice(0, -2) + (c.endsWith("00") ? "01" : "00");
  assert.throws(() => decryptWith(flipped, k.secret));
});

test("enclave key: only a candidate with OUR nonce and a TDX quote is accepted", () => {
  const key = "ab".repeat(32);
  const report = { model_attestations: [{ request_nonce: "other", signing_public_key: "cd".repeat(32), intel_quote: "q" }, { request_nonce: "n1", signing_public_key: key, intel_quote: "q" }] };
  assert.equal(enclaveKeyFrom(report, "m", "n1").publicKeyHex, key);
  assert.throws(() => enclaveKeyFrom(report, "m", "n2"));
  assert.throws(() => enclaveKeyFrom({ model_attestations: [{ request_nonce: "n1", signing_public_key: key }] }, "m", "n1"), "no quote");
});

test("messages are encrypted per message, and the headers pin both keys", () => {
  const enclave = newClientKey(), me = newClientKey();
  const ek = { model: "m", publicKeyHex: enclave.publicHex, nonce: "n", hasTdxQuote: true };
  const out = encryptMessages([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], ek);
  assert.deepEqual(out.map((m) => decryptWith(m.content, enclave.secret)), ["be brief", "hi"]);
  assert.deepEqual(e2eeHeaders(me.publicHex, ek), { "x-signing-algo": "ed25519", "x-encryption-version": "2", "x-client-pub-key": me.publicHex, "x-model-pub-key": enclave.publicHex });
});
