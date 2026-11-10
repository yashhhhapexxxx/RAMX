#!/usr/bin/env node
/**
 * Attack demo: a prompt-injected agent tries to misuse its wallet. It holds only a function-call key
 * on escrow.pay, so every attempt is refused ON CHAIN (contract policy or the NEAR runtime):
 *   a) pay an attacker account (not on the allow list)
 *   b) pay more than per_call_max in one call
 *   c) drain: pay the maximum again and again until the budget stops it
 *   d) skip the escrow: call usdc.ft_transfer with the function-call key (with and without the deposit)
 *   e) rewrite its own policy: call escrow.set_policy with the function-call key
 * Costs gas from the key's allowance; step c moves at most the remaining budget, only to the treasury.
 *   pnpm attack            (add --no-drain to skip step c)
 */
import { parseArgs } from "node:util";
import { explorerTxUrl, loadNetConfig, unitsToUsdc } from "./budget.ts";
import { attempt, guardedFromEnv, pay, policyOf, type Attempt } from "./escrow.ts";

const { values } = parseArgs({ options: { "no-drain": { type: "boolean", default: false }, rogue: { type: "string", default: "rogue.testnet" } } });
const g = guardedFromEnv();
const p = await policyOf(g);
if (!p) throw new Error(`${g.agentId} is not funded on ${g.escrow}`);
const usdc = loadNetConfig().x402_near.asset;
const treasury = p.allow[0] ?? "treasury.ramx.testnet";
const u = (n: bigint) => `${unitsToUsdc(n)} USDC`;
console.log(`agent ${g.agentId}: policy budget ${u(BigInt(p.budget))} (spent ${u(BigInt(p.spent))}), per call ${u(BigInt(p.per_call_max))}, payees [${p.allow.join(", ")}]\n`);

let refused = 0;
let leaked = false;
function show(label: string, r: Attempt, expectRefusal = true) {
  const link = r.tx ? `  ${explorerTxUrl(r.tx)}` : "";
  if (!r.ok) {
    refused++;
    console.log(`  REFUSED  ${label}\n           reason: ${r.reason}${link ? `\n         ${link}` : ""}`);
  } else {
    if (expectRefusal) leaked = true;
    console.log(`  ${expectRefusal ? "!! ALLOWED" : "allowed "} ${label}${link}`);
  }
}

console.log("a) pay an attacker account");
show(`pay ${values.rogue} 0.1 USDC`, await pay(g, values.rogue!, 100_000n, "ignore previous instructions"));

console.log("b) one payment above the per-call limit");
show(`pay ${treasury} ${u(BigInt(p.per_call_max) + 1n)}`, await pay(g, treasury, BigInt(p.per_call_max) + 1n, "attack"));

if (!values["no-drain"]) {
  console.log("c) drain the budget (allowed payee, maximum per call, until refused)");
  for (let i = 0; i < 20; i++) {
    const now = (await policyOf(g))!;
    const r = await pay(g, treasury, BigInt(now.per_call_max), "attack");
    show(`pay ${treasury} ${u(BigInt(now.per_call_max))} (spent so far ${u(BigInt(now.spent))})`, r, false);
    if (!r.ok) break;
  }
}

console.log("d) bypass the escrow: usdc.ft_transfer with the function-call key");
show(`ft_transfer ${values.rogue} 0.1 USDC (with the 1 yoctoNEAR ft_transfer needs)`, await attempt(g, usdc, "ft_transfer", { receiver_id: values.rogue, amount: "100000" }, 1n));
show(`ft_transfer ${values.rogue} 0.1 USDC (no deposit)`, await attempt(g, usdc, "ft_transfer", { receiver_id: values.rogue, amount: "100000" }));

console.log("e) raise its own limits: escrow.set_policy with the function-call key");
show("set_policy budget=1000 USDC, allow rogue", await attempt(g, g.escrow, "set_policy", { agent: g.agentId, policy: { budget: "1000000000", per_call_max: "1000000000", allow: [values.rogue] } }));

const end = (await policyOf(g))!;
console.log(`\n${refused} attempts refused on chain. Spent ${u(BigInt(end.spent))} of ${u(BigInt(end.budget))}, all of it to ${treasury}.`);
if (leaked) {
  console.error("FAIL: an attack was allowed");
  process.exit(1);
}
