import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "@ramx/shared";
import { checkAttestationReport, eventSignatureOk, leakedWords, ledgerEvents, promptHash, saltedHash } from "../src/privacy-check.ts";

test("salted hashes match the gateway formula; another salt gives another hash", () => {
  const msgs = [{ role: "user", content: "hi" }];
  assert.equal(promptHash("aa", msgs), `0x${createHash("sha256").update(`aa:${canonicalJson(msgs)}`).digest("hex")}`);
  assert.notEqual(saltedHash("aa", "yes"), saltedHash("bb", "yes"));
});

test("event signature: valid for the signer, invalid after tampering or with another key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const rest = { type: "x402_payment", prompt_hash: "0x01", seq: 1 };
  const sig = `0x${sign(null, Buffer.from(canonicalJson(rest)), privateKey).toString("hex")}`;
  assert.equal(eventSignatureOk({ ...rest, sig }, pub), true);
  assert.equal(eventSignatureOk({ ...rest, prompt_hash: "0x02", sig }, pub), false);
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  assert.equal(eventSignatureOk({ ...rest, sig }, other), false);
});

test("ledger events are read from NEP-297 logs, other logs ignored", () => {
  const logs = ["hello", `EVENT_JSON:${JSON.stringify({ standard: "ramx", version: "1.0.0", event: "ledger", data: [{ seq: 4, event: { type: "x" } }] })}`, `EVENT_JSON:${JSON.stringify({ standard: "nep141", event: "ft_transfer", data: [] })}`];
  assert.deepEqual(ledgerEvents(logs), [{ seq: 4, event: { type: "x" } }]);
});

test("leaked words: none for hashes only, found when text is present", () => {
  assert.deepEqual(leakedWords("meet Priya about the loan", ['{"prompt_hash":"0xabc"}']), []);
  assert.deepEqual(leakedWords("meet Priya about the loan", ["... priya ..."]), ["priya"]);
});

test("attestation: our nonce required", () => {
  const ok = { gateway_attestation: { request_nonce: "n1" }, model_attestations: [{ request_nonce: "n1", signing_address: `0x${"a".repeat(40)}`, intel_quote: "q" }] };
  assert.deepEqual(checkAttestationReport(ok, "n1"), { signingAddress: `0x${"a".repeat(40)}`, hasTdxQuote: true });
  assert.throws(() => checkAttestationReport(ok, "n2"));
});
