#!/usr/bin/env node
/**
 * AI agent client (SPEC §13). Asks questions to the gateway WITHOUT a session, so each request is
 * paid with x402 in USDC (NEP-141) on NEAR testnet. SPENDS TESTNET USDC (the gateway relayer pays gas).
 *   node --env-file=.env src/agent.ts [--questions N] [--model M] [--max-tokens T]
 * Env: GATEWAY_URL, AGENT_ACCOUNT_ID (e.g. agent-1.ramx.testnet), AGENT_SECRET_KEY (ed25519:…),
 * AGENT_BUDGET_USDC, NEAR_RPC_URL (optional).
 * Budget: before each question the price comes from the shared config tier; the agent stops
 * before a payment would take the total above AGENT_BUDGET_USDC. The x402 client is also capped
 * per payment at that price and USDC only, so a gateway that asks more (or another token) is refused.
 */
import { parseArgs } from "node:util";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { createClientNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/client";
import { REQUEST_ID_HEADER } from "@ramx/shared";
import { canAfford, explorerTxUrl, loadNetConfig, nearSecretKey, priceUnits, unitsToUsdc, usdcToUnits } from "./budget.ts";

const QUESTIONS = [
  "In one sentence: what is pipeline parallelism in LLM inference?",
  "Name two benefits of splitting a model across several consumer GPUs.",
  "What does a KV cache store?",
  "Why does a distributed pool need a reliability score?",
  "Give a one-line definition of a Merkle proof.",
];

const { values } = parseArgs({ options: { questions: { type: "string", default: "5" }, model: { type: "string", default: "Qwen/Qwen3-14B-FP8" }, "max-tokens": { type: "string", default: "128" } } });
const env = process.env;
const missing = ["GATEWAY_URL", "AGENT_ACCOUNT_ID", "AGENT_SECRET_KEY"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(", ")} (see agent-client/.env.example)`);
  process.exit(1);
}
const cfg = loadNetConfig();
const { network, asset, decimals } = cfg.x402_near;
if (network !== "near:testnet") {
  console.error("this agent pays on near:testnet only");
  process.exit(1);
}
const model = values.model!;
const maxTokens = Number(values["max-tokens"]);
const count = Math.min(Number(values.questions), QUESTIONS.length);
const budget = usdcToUnits(env.AGENT_BUDGET_USDC ?? "0.05", decimals);
const signer = createClientNearSigner({
  accountId: env.AGENT_ACCOUNT_ID!,
  secretKey: nearSecretKey(env.AGENT_SECRET_KEY!),
  ...(env.NEAR_RPC_URL ? { rpcUrls: { [network]: env.NEAR_RPC_URL } } : {}),
});
const gateway = env.GATEWAY_URL!.replace(/\/+$/, "");

let spent = 0n;
for (const question of QUESTIONS.slice(0, count)) {
  const price = priceUnits(cfg, model, maxTokens);
  if (!canAfford(spent, price, budget)) {
    console.log(`budget: stop. spent ${unitsToUsdc(spent)} + next ${unitsToUsdc(price)} USDC > budget ${unitsToUsdc(budget)} USDC`);
    break;
  }
  // USDC only, and never more than this question's tier price.
  const client = new x402Client()
    .register("near:*", new ExactNearScheme(signer))
    .setSpendControls({ allowedAssets: [{ network, asset, maxAmountPerPayment: price.toString() }] })
    .registerPolicy((_version, requirements) => requirements.filter((r) => r.asset === asset));
  const pay = wrapFetchWithPayment(fetch, client);
  console.log(`\nQ: ${question}`);
  const res = await pay(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: question }], max_tokens: maxTokens }),
  });
  const reqId = res.headers.get(REQUEST_ID_HEADER);
  const header = res.headers.get("PAYMENT-RESPONSE");
  if (header) {
    const settle = decodePaymentResponseHeader(header);
    spent += price;
    console.log(`paid ${unitsToUsdc(price)} USDC, tx ${settle.transaction}\nNearBlocks: ${explorerTxUrl(settle.transaction)}`);
  }
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${JSON.stringify(body)} (request ${reqId})`);
    if (!header) break; // not paid: stop rather than loop on an error
    continue;
  }
  console.log(`A: ${body?.choices?.[0]?.message?.content ?? ""}`);
  console.log(`receipt: ${gateway}/requests/${reqId}`);
}
console.log(`\nspent ${unitsToUsdc(spent)} USDC of budget ${unitsToUsdc(budget)} USDC`);
