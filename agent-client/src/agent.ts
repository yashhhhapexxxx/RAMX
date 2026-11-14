#!/usr/bin/env node
/**
 * AI agent client (SPEC §13). Asks questions to the gateway WITHOUT a session, so each request is
 * paid with x402 in USDC (NEP-141) on NEAR testnet. SPENDS TESTNET USDC (the gateway relayer pays gas).
 *   node --env-file=.env src/agent.ts [--questions N] [--model M] [--max-tokens T]
 *   node --env-file=.env src/agent.ts --goal "<what to find out>" [--steps N]
 * Goal mode (src/planner.ts): before each purchase the agent asks the model, in a paid request, what to
 * buy next or whether it is done; it sees what it already bought and its remaining budget.
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
import { parsePlan, plannerMessages, type Note } from "./planner.ts";

const QUESTIONS = [
  "In one sentence: what is pipeline parallelism in LLM inference?",
  "Name two benefits of splitting a model across several consumer GPUs.",
  "What does a KV cache store?",
  "Why does a distributed pool need a reliability score?",
  "Give a one-line definition of a Merkle proof.",
];

const { values } = parseArgs({ options: { questions: { type: "string", default: "5" }, model: { type: "string", default: "Qwen/Qwen3-14B-FP8" }, "max-tokens": { type: "string", default: "128" }, goal: { type: "string" }, steps: { type: "string", default: "4" } } });
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
type Msg = { role: "system" | "user"; content: string };

/** One paid request. Returns the answer text, or null when the agent should stop (budget, or unpaid error). */
async function paidChat(messages: Msg[], tokens: number): Promise<string | null> {
  const price = priceUnits(cfg, model, tokens);
  if (!canAfford(spent, price, budget)) {
    console.log(`budget: stop. spent ${unitsToUsdc(spent)} + next ${unitsToUsdc(price)} USDC > budget ${unitsToUsdc(budget)} USDC`);
    return null;
  }
  // USDC only, and never more than this request's tier price.
  const client = new x402Client()
    .register("near:*", new ExactNearScheme(signer))
    .setSpendControls({ allowedAssets: [{ network, asset, maxAmountPerPayment: price.toString() }] })
    .registerPolicy((_version, requirements) => requirements.filter((r) => r.asset === asset));
  const pay = wrapFetchWithPayment(fetch, client);
  const res = await pay(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: tokens }),
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
    return header ? "" : null; // paid but failed: carry on; not paid: stop rather than loop on an error
  }
  console.log(`receipt: ${gateway}/requests/${reqId}`);
  return String(body?.choices?.[0]?.message?.content ?? "");
}

if (values.goal) {
  // Goal mode: the model decides each purchase.
  const notes: Note[] = [];
  const steps = Number(values.steps);
  console.log(`goal: ${values.goal}\nbudget: ${unitsToUsdc(budget)} USDC, at most ${steps} steps`);
  for (let step = 1; step <= steps; step++) {
    const price = priceUnits(cfg, model, maxTokens);
    console.log(`\n[step ${step}] deciding what to buy next`);
    const reply = await paidChat(plannerMessages(values.goal, notes, unitsToUsdc(budget - spent), unitsToUsdc(price)), 200);
    if (reply === null) break;
    const plan = parsePlan(reply);
    if (!plan) { console.log(`no usable plan in the reply, stopping: ${reply.slice(0, 120)}`); break; }
    if (plan.action === "done") { console.log(`\nDONE: ${plan.summary}`); break; }
    console.log(`decided to buy: ${plan.question}${plan.why ? `  (why: ${plan.why})` : ""}`);
    const answer = await paidChat([{ role: "user", content: plan.question }], maxTokens);
    if (answer === null) break;
    console.log(`A: ${answer}`);
    notes.push({ question: plan.question, answer });
  }
} else {
  for (const question of QUESTIONS.slice(0, count)) {
    console.log(`\nQ: ${question}`);
    const answer = await paidChat([{ role: "user", content: question }], maxTokens);
    if (answer === null) break;
    console.log(`A: ${answer}`);
  }
}
console.log(`\nspent ${unitsToUsdc(spent)} USDC of budget ${unitsToUsdc(budget)} USDC`);
