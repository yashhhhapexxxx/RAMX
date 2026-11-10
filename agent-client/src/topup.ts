#!/usr/bin/env node
/**
 * Buy credits for one RAMX API key with testnet USDC on NEAR (x402). 1 USDC = 1000 credits (shared
 * config topup.credits_per_usdc). Only that key can spend them. SPENDS TESTNET USDC.
 *   pnpm topup --usdc 0.5        # pay 0.5 USDC, add 500 credits to RAMX_API_KEY
 *   pnpm topup --check           # only show the key's credits
 * Env (agent-client/.env, never committed): GATEWAY_URL, RAMX_API_KEY (gpa_…), and your NEAR
 * testnet account: AGENT_ACCOUNT_ID + AGENT_SECRET_KEY (ed25519:…). The key stays on this machine:
 * x402 signs a NEP-366 delegate here, the gateway only relays the signed transfer.
 */
import { parseArgs } from "node:util";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { createClientNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/client";
import { CreditTopupResponse, KeyCreditsResponse } from "@ramx/shared";
import { explorerTxUrl, loadNetConfig, nearSecretKey, unitsToUsdc, usdcToUnits } from "./budget.ts";

const { values } = parseArgs({ options: { usdc: { type: "string" }, check: { type: "boolean", default: false } } });
const env = process.env;
const need = ["GATEWAY_URL", "RAMX_API_KEY", ...(values.check ? [] : ["AGENT_ACCOUNT_ID", "AGENT_SECRET_KEY"])];
const missing = need.filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(", ")} (see agent-client/.env.example)`);
  process.exit(1);
}
const gateway = env.GATEWAY_URL!.replace(/\/+$/, "");
const auth = { authorization: `Bearer ${env.RAMX_API_KEY}` };
const cr = (mc: number) => `${(mc / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })} cr`;

async function show(): Promise<void> {
  const res = await fetch(`${gateway}/v1/credits`, { headers: auth });
  if (!res.ok) throw new Error(`GET /v1/credits: HTTP ${res.status} ${await res.text()}`);
  const c = KeyCreditsResponse.parse(await res.json());
  console.log(`key ${c.name} (${c.agent_id})
  bought credits (this key only): ${cr(c.key_credits_mc)}  (bought in total ${cr(c.bought_total_mc)})
  account credits:                ${cr(c.account_available_mc)}${c.cap_mc === null ? "  (no cap)" : `  (cap ${cr(c.cap_mc)}, ${cr(c.cap_left_mc!)} left)`}
  can spend now:                  ${cr(c.spendable_mc)}
  rate: 1 USDC = ${c.topup.credits_per_usdc} credits, ${c.topup.min_usdc}–${c.topup.max_usdc} USDC per top-up`);
}

if (values.check) {
  await show();
  process.exit(0);
}
if (!values.usdc) {
  console.error("usage: pnpm topup --usdc <amount>   (or --check)");
  process.exit(1);
}
const cfg = loadNetConfig();
const { network, asset, decimals } = cfg.x402_near;
const units = usdcToUnits(values.usdc, decimals);
const usdc = Number(units) / 10 ** decimals;
if (usdc < cfg.topup.min_usdc || usdc > cfg.topup.max_usdc) {
  console.error(`--usdc must be from ${cfg.topup.min_usdc} to ${cfg.topup.max_usdc}`);
  process.exit(1);
}

await show();
const signer = createClientNearSigner({ accountId: env.AGENT_ACCOUNT_ID!, secretKey: nearSecretKey(env.AGENT_SECRET_KEY!), ...(env.NEAR_RPC_URL ? { rpcUrls: { [network]: env.NEAR_RPC_URL } } : {}) });
// Pay USDC only, and never more than the amount asked for on the command line.
const client = new x402Client()
  .register("near:*", new ExactNearScheme(signer))
  .setSpendControls({ allowedAssets: [{ network, asset, maxAmountPerPayment: units.toString() }] })
  .registerPolicy((_version, requirements) => requirements.filter((r) => r.asset === asset && BigInt(r.amount) === units));
const pay = wrapFetchWithPayment(fetch, client);

console.log(`\npaying ${unitsToUsdc(units)} testnet USDC from ${env.AGENT_ACCOUNT_ID} for ${usdc * cfg.topup.credits_per_usdc} credits…`);
const res = await pay(`${gateway}/v1/credits/topup`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json", ...auth },
  body: JSON.stringify({ usdc }),
});
const header = res.headers.get("PAYMENT-RESPONSE");
if (header) console.log(`NearBlocks: ${explorerTxUrl(decodePaymentResponseHeader(header).transaction)}`);
if (!res.ok) {
  console.error(`top-up failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
const done = CreditTopupResponse.parse(await res.json());
console.log(`added ${cr(done.added_mc)} to ${done.agent_id} (tx ${done.tx_id})\n`);
await show();
