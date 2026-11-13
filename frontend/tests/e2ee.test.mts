// End-to-end encryption in the browser (src/lib/e2ee.ts) and the encrypted chat path (src/data/live).
// No network: every request goes to a fake fetch. Run: npm test
(globalThis as any).window = globalThis;
import assert from "node:assert/strict";
const e = await import("../src/lib/e2ee.ts");
const node = await import("../../agent-client/src/e2ee.ts");
const { liveApi } = await import("../src/data/live/index.ts");
let pass = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); pass++; console.log("  ✓", m); };
const throws = (f: () => unknown, m: string) => { assert.throws(f); pass++; console.log("  ✓", m); };
async function rejects(p: Promise<unknown>, re: RegExp, m: string) { await assert.rejects(p, re); pass++; console.log("  ✓", m); }

console.log("encryption");
const enclaveKp = e.newClientKey();
const c1 = e.encryptTo("meet Priya at 7pm", enclaveKp.publicHex);
ok(e.decryptWith(c1, enclaveKp.secret) === "meet Priya at 7pm", "encrypt to a key, decrypt with its secret");
ok(c1 !== e.encryptTo("meet Priya at 7pm", enclaveKp.publicHex), "fresh ephemeral key and nonce every time");
ok(!new TextDecoder().decode(e.fromHex(c1)).includes("Priya"), "ciphertext carries no plain text");
throws(() => e.decryptWith(c1, e.newClientKey().secret), "another key cannot decrypt it");
throws(() => e.decryptWith(c1.slice(0, -2) + (c1.endsWith("00") ? "01" : "00"), enclaveKp.secret), "a changed byte is detected");

console.log("same scheme as the terminal client (agent-client)");
const nodeKp = node.newClientKey();
ok(node.decryptWith(e.encryptTo("from the browser", nodeKp.publicHex), nodeKp.secret) === "from the browser", "browser encrypts → terminal client decrypts");
ok(e.decryptWith(node.encryptTo("from the terminal", enclaveKp.publicHex), enclaveKp.secret) === "from the terminal", "terminal client encrypts → browser decrypts");

console.log("attestation");
const key = "ab".repeat(32);
const report = (nonce: string, extra: Record<string, unknown> = {}) => ({ model_attestations: [{ request_nonce: "other", signing_public_key: "cd".repeat(32), intel_quote: "q" }, { request_nonce: nonce, signing_public_key: key, intel_quote: "q", ...extra }] });
ok(e.enclaveKeyFrom(report("n1"), "m", "n1").publicKeyHex === key, "the candidate with our nonce and a TDX quote is chosen");
throws(() => e.enclaveKeyFrom(report("n1"), "m", "n2"), "a report without our nonce is refused");
throws(() => e.enclaveKeyFrom(report("n1", { intel_quote: "" }), "m", "n1"), "a candidate without a TDX quote is refused");
let asked = "";
let askedHeaders: Record<string, string> = {};
const attested = await e.attestEnclave("Qwen/Qwen3.8-27B", (async (url: string, init?: RequestInit) => {
  asked = url; askedHeaders = (init?.headers ?? {}) as Record<string, string>;
  const nonce = new URL(url).searchParams.get("nonce")!;
  return new Response(JSON.stringify(report(nonce)));
}) as typeof fetch);
const sentNonce = new URL(asked).searchParams.get("nonce")!;
ok(/^[0-9a-f]{64}$/.test(sentNonce) && attested.nonce === sentNonce, "attestation asked with a fresh 32-byte nonce of our own");
ok(asked.startsWith("https://cloud-api.near.ai/v1/attestation/report") && askedHeaders["x-no-aliasing"] === "true", "fetched straight from NEAR AI Cloud, pinned (no aliasing)");
await rejects(e.attestEnclave("m", (async () => new Response("no", { status: 503 })) as typeof fetch), /HTTP 503/, "a failed attestation fetch is an error");

console.log("encrypted chat (fake gateway)");
const me = e.newClientKey();
const enclave = { model: "Qwen/Qwen3.8-27B", publicKeyHex: enclaveKp.publicHex, nonce: "n", attestedAt: Date.now() };
const sse = (parts: string[]) => parts.map((p) => `data: ${JSON.stringify({ id: "req_x", choices: [{ delta: { content: p } }] })}\n\n`).join("") + "data: [DONE]\n\n";
let sent: { headers: Record<string, string>; body: any } | null = null;
const original = globalThis.fetch;
const fakeGateway = (reply: (body: any) => string) => {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    return new Response(reply(sent.body), { headers: { "content-type": "text/event-stream", "x-ramx-request-id": "req_x" } });
  }) as typeof fetch;
};
const collect = async (it: AsyncIterable<{ delta: string }>) => { let t = ""; for await (const c of it) t += c.delta; return t; };
const history = [{ role: "user" as const, content: "my card is 4111 1111 1111 1111, meet Priya" }];

// The fake enclave decrypts the request with its key and answers encrypted to the client, chunk by chunk.
fakeGateway((body) => {
  const q = e.decryptWith(body.messages[0].content, enclaveKp.secret);
  return sse(["Noted: ", q.slice(0, 10), "…"].map((p) => e.encryptTo(p, sent!.headers["x-client-pub-key"])));
});
const answer = await collect(liveApi.chat({ model: "Qwen/Qwen3-8B-FP8", messages: history, max_tokens: 64, privacy: "tee", e2ee: { client: me, enclave } }, "tok", new AbortController().signal));
ok(sent!.headers["x-ramx-privacy"] === "tee", "the privacy mode is sent (x-ramx-privacy: tee)");
ok(sent!.headers["x-client-pub-key"] === me.publicHex && sent!.headers["x-model-pub-key"] === enclave.publicKeyHex && sent!.headers["x-encryption-version"] === "2" && sent!.headers["x-signing-algo"] === "ed25519", "both keys and the scheme are pinned in the headers");
ok(!JSON.stringify(sent!.body).includes("Priya") && !JSON.stringify(sent!.body).includes("4111"), "the request body carries only ciphertext");
ok(answer === `Noted: ${history[0].content.slice(0, 10)}…`, "each streamed chunk is decrypted in the browser");
ok(!("x-ramx-pool" in sent!.headers), "no pool pin in a privacy mode");

fakeGateway(() => sse(["plain text the enclave never encrypted"]));
await rejects(collect(liveApi.chat({ model: "m", messages: history, max_tokens: 8, privacy: "tee", e2ee: { client: me, enclave } }, "tok", new AbortController().signal)), /Could not decrypt/, "an answer that does not decrypt is an error, never shown");
await rejects(collect(liveApi.chat({ model: "m", messages: history, max_tokens: 8, privacy: "trusted-all", e2ee: { client: me, enclave } }, "tok", new AbortController().signal)), /needs the secure hardware/, "encryption is refused outside the enclave mode");

fakeGateway(() => sse(["hello"]));
const plain = await collect(liveApi.chat({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }, "tok", new AbortController().signal));
ok(plain === "hello" && !("x-ramx-privacy" in sent!.headers) && sent!.body.messages[0].content === "hi", "normal mode is unchanged: no privacy header, plain request");
fakeGateway(() => sse(["ok"]));
await collect(liveApi.chat({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 8, privacy: "trusted-all" }, "tok", new AbortController().signal));
ok(sent!.headers["x-ramx-privacy"] === "trusted-all" && sent!.body.messages[0].content === "hi", "trusted laptops mode: header sent, no encryption");
globalThis.fetch = original;

console.log(`\n${pass} checks passed`);
process.exit(0);
