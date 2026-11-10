#!/usr/bin/env node
/**
 * Guarded agent, legit path: pay the treasury through the escrow (within the owner's policy), get
 * the payment credited to this agent's RAMX API key, then spend it on one inference request.
 * SPENDS TESTNET USDC (from the escrow balance the owner funded).
 *   pnpm guarded --usdc 0.5            # pay, credit, then one chat request
 *   pnpm guarded --policy              # only show the on-chain policy
 * Env (agent-client/.env): GATEWAY_URL, GUARDED_API_KEY (gpa_… of this agent), GUARDED_AGENT_ID,
 * GUARDED_AGENT_FC_KEY (function-call key on escrow.pay only), ESCROW_CONTRACT_ID, TREASURY_ACCOUNT_ID.
 */
import { parseArgs } from "node:util";
import { ChatCompletionResponse, CreditTopupResponse, KeyCreditsResponse } from "@ramx/shared";
import { explorerTxUrl, loadNetConfig, unitsToUsdc, usdcToUnits } from "./budget.ts";
import { guardedFromEnv, pay, policyOf } from "./escrow.ts";

const { values } = parseArgs({ options: { usdc: { type: "string", default: "0.5" }, policy: { type: "boolean", default: false }, model: { type: "string" } } });
const g = guardedFromEnv();
const p = await policyOf(g);
if (!p) throw new Error(`${g.agentId} is not funded on ${g.escrow}`);
const u = (s: string) => `${unitsToUsdc(BigInt(s))} USDC`;
console.log(`escrow policy for ${g.agentId} (owner ${p.owner}): balance ${u(p.balance)}, spent ${u(p.spent)} of budget ${u(p.budget)}, max ${u(p.per_call_max)} per call, payees [${p.allow.join(", ")}]${p.paused ? ", PAUSED" : ""}`);
if (values.policy) process.exit(0);

const env = process.env;
const missing = ["GATEWAY_URL", "GUARDED_API_KEY"].filter((k) => !env[k]);
if (missing.length) throw new Error(`missing env: ${missing.join(", ")}`);
const gateway = env.GATEWAY_URL!.replace(/\/+$/, "");
const auth = { authorization: `Bearer ${env.GUARDED_API_KEY}` };
const treasury = env.TREASURY_ACCOUNT_ID || "treasury.ramx.testnet";

const credits = KeyCreditsResponse.parse(await (await fetch(`${gateway}/v1/credits`, { headers: auth })).json());
const amount = usdcToUnits(values.usdc!);
console.log(`1. pay ${values.usdc} USDC to ${treasury} via ${g.escrow}.pay (memo = key ${credits.agent_id})`);
const r = await pay(g, treasury, amount, credits.agent_id);
if (!r.ok) {
  console.error(`   refused on chain: ${r.reason}${r.tx ? `\n   ${explorerTxUrl(r.tx)}` : ""}`);
  process.exit(1);
}
console.log(`   paid: ${explorerTxUrl(r.tx)}`);

console.log("2. credit it to the key: POST /v1/credits/escrow");
const cr = await fetch(`${gateway}/v1/credits/escrow`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ tx_hash: r.tx, agent_account: g.agentId }) });
if (!cr.ok) throw new Error(`POST /v1/credits/escrow: HTTP ${cr.status} ${await cr.text()}`);
const c = CreditTopupResponse.parse(await cr.json());
console.log(`   +${c.added_mc / 1000} credits; the key can spend ${c.credits.spendable_mc / 1000} credits`);

const model = values.model ?? loadNetConfig().models[0]!.model_id;
console.log(`3. one inference request on ${model}, paid from those credits`);
const chat = await fetch(`${gateway}/v1/chat/completions`, { method: "POST", headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "In one sentence: why should an AI agent's wallet have spending limits?" }], max_tokens: 80 }) });
if (!chat.ok) {
  console.error(`   HTTP ${chat.status} ${await chat.text()} (is a pool or the fallback backend up?)`);
  process.exit(1);
}
const body = ChatCompletionResponse.parse(await chat.json());
console.log(`   ${body.choices[0]?.message.content ?? ""}`.trim());
console.log(`   request ${chat.headers.get("x-request-id") ?? body.id}`);
