#!/usr/bin/env node
/**
 * Send a private request and verify its privacy yourself, without trusting the gateway.
 *   node --env-file=.env src/private.ts [--mode tee|trusted-all|trusted-ends] [--e2ee] [--prompt "..."] [--model M]
 * --e2ee: end-to-end encrypt to the enclave (implies --mode tee). This client fetches the enclave's
 * attestation itself, encrypts every message to the attested key, and decrypts the answer locally;
 * the gateway, the network and the chain only ever carry ciphertext.
 * Pays with RAMX credits when RAMX_API_KEY is set, otherwise with x402 in USDC (AGENT_ACCOUNT_ID and
 * AGENT_SECRET_KEY; SPENDS TESTNET USDC). Env: GATEWAY_URL, LEDGER_CONTRACT_ID (default
 * ledger-v3.ramx.testnet), NEAR_RPC_URL, NEARAI_API_KEY (optional: your own attestation check).
 *
 * Checks, all on this machine:
 *   1. the public receipt holds no prompt text and no salt;
 *   2. sha256(salt:prompt) and sha256(salt:answer), recomputed here, match the receipt;
 *   3. the NEAR ledger transaction carries an event with those same hashes, signed by the key the
 *      ledger contract publishes, and none of the prompt's words;
 *   4. tee / fallback: the receipt names an attested TEE model; with NEARAI_API_KEY, we ask NEAR AI
 *      Cloud ourselves, with our own fresh nonce, for that model's attestation.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { createClientNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/client";
import { REQUEST_ID_HEADER } from "@ramx/shared";
import { explorerTxUrl, loadNetConfig, nearSecretKey, priceUnits, unitsToUsdc } from "./budget.ts";
import { checkAttestationReport, eventSignatureOk, leakedWords, ledgerEvents, nearRpc, promptHash, saltedHash } from "./privacy-check.ts";
import { attestEnclave, decryptWith, e2eeHeaders, encryptMessages, newClientKey, type EnclaveKey } from "./e2ee.ts";

const { values } = parseArgs({ options: {
  mode: { type: "string", default: "tee" },
  prompt: { type: "string", default: "My private note: meet Priya at 7pm about the loan. Reply only: noted." },
  model: { type: "string", default: "Qwen/Qwen3-8B-FP8" },
  e2ee: { type: "boolean", default: false },
} });
if (values.e2ee) values.mode = "tee";
const env = process.env;
if (!env.GATEWAY_URL) { console.error("missing env: GATEWAY_URL"); process.exit(1); }
const gateway = env.GATEWAY_URL.replace(/\/+$/, "");
const ledger = env.LEDGER_CONTRACT_ID ?? "ledger-v3.ramx.testnet";
const rpc = nearRpc(env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com");
const model = values.model!;
const maxTokens = 64;
let messages = [{ role: "user", content: values.prompt! }];

let results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ check: name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`); };

// ---- send the request ----
let send: typeof fetch = fetch;
const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", "x-ramx-privacy": values.mode! };
if (env.RAMX_API_KEY) headers.authorization = `Bearer ${env.RAMX_API_KEY}`;
else {
  if (!env.AGENT_ACCOUNT_ID || !env.AGENT_SECRET_KEY) { console.error("set RAMX_API_KEY, or AGENT_ACCOUNT_ID + AGENT_SECRET_KEY to pay with x402"); process.exit(1); }
  const cfg = loadNetConfig();
  const { network, asset } = cfg.x402_near;
  const price = priceUnits(cfg, model, maxTokens);
  const signer = createClientNearSigner({ accountId: env.AGENT_ACCOUNT_ID, secretKey: nearSecretKey(env.AGENT_SECRET_KEY), ...(env.NEAR_RPC_URL ? { rpcUrls: { [network]: env.NEAR_RPC_URL } } : {}) });
  const client = new x402Client()
    .register("near:*", new ExactNearScheme(signer))
    .setSpendControls({ allowedAssets: [{ network, asset, maxAmountPerPayment: price.toString() }] })
    .registerPolicy((_v, reqs) => reqs.filter((r) => r.asset === asset));
  send = wrapFetchWithPayment(fetch, client);
  console.log(`paying up to ${unitsToUsdc(price)} USDC with x402 from ${env.AGENT_ACCOUNT_ID}`);
}
console.log(`gateway ${gateway} · mode ${values.mode}${values.e2ee ? " · end-to-end encrypted" : ""} · model ${model}\n`);
// ---- end-to-end encryption: attest the enclave ourselves, encrypt to its key ----
let e2ee: { secret: Uint8Array; enclave: EnclaveKey } | null = null;
if (values.e2ee) {
  const list = (await (await fetch(`${gateway}/v1/models`)).json()) as { data?: { id: string; tee_model?: string }[] };
  const teeModel = list.data?.find((m) => m.id === model)?.tee_model;
  if (!teeModel) { console.error(`the gateway names no enclave model for ${model} (tee_model in /v1/models)`); process.exit(1); }
  const enclave = await attestEnclave(teeModel);
  check("enclave attested by this machine (our nonce, Intel TDX quote)", enclave.hasTdxQuote, `${teeModel} · key ${enclave.publicKeyHex.slice(0, 16)}…`);
  const me = newClientKey();
  Object.assign(headers, e2eeHeaders(me.publicHex, enclave));
  messages = encryptMessages(messages, enclave);
  e2ee = { secret: me.secret, enclave };
  console.log(`sent to RAMX: ${messages[0]!.content.slice(0, 48)}… (ciphertext)\n`);
}
const res = await send(`${gateway}/v1/chat/completions`, {
  method: "POST", headers,
  body: JSON.stringify({ model, messages, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false } }),
});
const reqId = res.headers.get(REQUEST_ID_HEADER);
const salt = res.headers.get("x-ramx-hash-salt");
const paid = res.headers.get("PAYMENT-RESPONSE");
if (paid) console.log(`payment: ${explorerTxUrl(decodePaymentResponseHeader(paid).transaction)}`);
const raw = await res.text();
const body = (() => { try { return JSON.parse(raw); } catch { return null; } })() as any;
if (!res.ok || !reqId || !salt) { console.error(`HTTP ${res.status}: ${raw.slice(0, 300)}`); process.exit(1); }
const answer: string = body?.choices?.[0]?.message?.content ?? "";
let shown = answer;
if (e2ee) {
  check("answer arrived as ciphertext: no prompt word in what RAMX returned", leakedWords(values.prompt!, [raw]).length === 0);
  try { shown = decryptWith(answer, e2ee.secret); check("answer decrypted on this machine only", true, shown); }
  catch (err) { check("answer decrypted on this machine only", false, (err as Error).message); }
}
console.log(`request ${reqId}\nanswer: ${shown}\nyour salt (only you get it): ${salt}\n`);

// ---- 1-2. receipt ----
let receipt: any = null;
for (let i = 0; i < 24; i++) {
  receipt = await (await fetch(`${gateway}/requests/${reqId}`)).json();
  if (receipt?.ledger_tx) break;
  await new Promise((ok) => setTimeout(ok, 5000));
}
const receiptText = JSON.stringify(receipt);
check("receipt has no prompt text", leakedWords(values.prompt!, [receiptText]).length === 0);
check("receipt has no salt", !receiptText.includes(salt));
check(`privacy mode recorded as ${values.mode}`, receipt.privacy === values.mode, `receipt says ${receipt.privacy}`);
if (e2ee) check("receipt says end-to-end encrypted", receipt.e2ee === true);
const myPrompt = promptHash(salt, messages);
const myAnswer = saltedHash(salt, answer);
check("prompt hash recomputed here matches the receipt", receipt.prompt_hash === myPrompt);
check("answer hash recomputed here matches the receipt", receipt.resp_hash === myAnswer);

// ---- 3. NEAR ledger ----
if (!receipt.ledger_tx) check("ledger event written", false, "no ledger transaction yet; run again later");
else {
  const [writer, pubkey] = await Promise.all([rpc.view(ledger, "writer"), rpc.view(ledger, "pubkey")]);
  const logs = await rpc.txLogs(receipt.ledger_tx, writer);
  const ev = ledgerEvents(logs).find((e) => e.event.prompt_hash === myPrompt);
  check("ledger event on NEAR carries our prompt hash", !!ev, `${ledger} seq ${ev?.seq ?? "?"} · ${explorerTxUrl(receipt.ledger_tx)}`);
  if (ev) {
    check("ledger event's answer hash matches", ev.event.resp_hash === myAnswer);
    check("ledger event signed by the key the contract publishes", eventSignatureOk(ev.event, pubkey), pubkey);
    if (e2ee) check("signed ledger event says end-to-end encrypted", ev.event.e2ee === true);
  }
  const leaked = leakedWords(values.prompt!, logs);
  check("no prompt words anywhere in the NEAR transaction", leaked.length === 0, leaked.length ? `found: ${leaked.join(", ")}` : "");
}

// ---- 4. TEE ----
if (receipt.backend === "near-ai-cloud") {
  const a = receipt.tee_attestation;
  check("served in NEAR AI Cloud secure hardware, attestation on the receipt", !!a?.signing_address, a ? `${a.model} · signer ${a.signing_address}` : "missing");
  if (env.NEARAI_API_KEY && a) {
    const nonce = randomBytes(32).toString("hex");
    const r = await fetch(`https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(a.model)}&nonce=${nonce}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${env.NEARAI_API_KEY}` } });
    try {
      const mine = checkAttestationReport(await r.json(), nonce);
      check("our own attestation (fresh nonce) from NEAR AI Cloud", mine.hasTdxQuote, `Intel TDX quote present · signer ${mine.signingAddress}${mine.signingAddress === a.signing_address.toLowerCase() ? " (same as receipt)" : " (another attested instance of the model)"}`);
    } catch (e) {
      check("our own attestation (fresh nonce) from NEAR AI Cloud", false, (e as Error).message);
    }
  } else console.log("info  set NEARAI_API_KEY to fetch the model's attestation yourself with your own nonce");
} else console.log(`info  served by pool ${receipt.pool_id ?? "?"} (route ${JSON.stringify(receipt.route)})`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? `${failed} check(s) FAILED` : `all ${results.length} checks passed`}: verified on this machine, not by the gateway.`);
process.exit(failed ? 1 : 0);
