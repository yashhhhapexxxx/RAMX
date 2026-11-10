#!/usr/bin/env node
/**
 * Live end-to-end check on NEAR testnet against a RUNNING gateway. SPENDS TESTNET USDC.
 *   pnpm --filter @ramx/gateway e2e:testnet [--questions 2] [--wait-minutes 15] [--no-claim]
 *
 * 1. agent-1 pays for questions with x402 (USDC on NEAR)       → payment tx
 * 2. the gateway writes signed events to the ledger contract   → ledger seq goes up, append tx
 * 3. verify-event checks every event's schema + signature      → anyone can rerun it
 * 4. an epoch closes (run the gateway with EPOCH_SECONDS=120)  → payout root posted, post tx
 * 5. the provider claims its share with a Merkle proof         → claim tx, USDC balance delta
 * Prints every NearBlocks link as a Markdown list at the end (for the README).
 *
 * Env: GATEWAY_URL (default http://127.0.0.1:8080), LEDGER_CONTRACT_ID, NEAR_RPC_URL (optional),
 * AGENT_ENV (default ../agent-client/.env: AGENT_ACCOUNT_ID, AGENT_SECRET_KEY, AGENT_BUDGET_USDC),
 * PROVIDER_ENV (default provider.env: PROVIDER_ACCOUNT_ID, PROVIDER_SECRET_KEY, PAYOUT_CONTRACT_ID).
 * Step 5 needs answers served by the provider's laptop pool: NEAR AI Cloud answers have no
 * provider route, so their share stays with the treasury and nothing is claimable.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { PayoutsResponse, Receipt } from "@ramx/shared";
import { nearProvider } from "../src/near.ts";

const { values } = parseArgs({ options: {
  questions: { type: "string", default: "2" },
  "wait-minutes": { type: "string", default: "15" },
  "no-claim": { type: "boolean", default: false },
} });
const gatewayDir = resolve(import.meta.dirname, "..");
const e = process.env;
const gateway = (e.GATEWAY_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const rpc = e.NEAR_RPC_URL;
if (rpc && /mainnet/i.test(rpc)) throw new Error("testnet only");
const ledger = e.LEDGER_CONTRACT_ID ?? "ledger.ramx.testnet";
const agentEnv = resolve(gatewayDir, e.AGENT_ENV ?? "../agent-client/.env");
const providerEnv = resolve(gatewayDir, e.PROVIDER_ENV ?? "provider.env");
const provider = nearProvider(rpc);
const waitMs = Number(values["wait-minutes"]) * 60_000;
const nearblocks = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;
const links: { step: string; tx: string }[] = [];

function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Run a node script, echo its output, return stdout. Rejects on a non-zero exit. */
function run(script: string, args: string[], cwd: string, envFile?: string): Promise<string> {
  const argv = [...(envFile ? [`--env-file=${envFile}`] : []), script, ...args];
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, argv, { cwd, env: { ...e, GATEWAY_URL: gateway }, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += b; process.stdout.write(b); });
    child.on("close", (code) => code === 0 ? ok(out) : fail(new Error(`${script} exited ${code}`)));
  });
}

async function json<T>(path: string): Promise<T> {
  const r = await fetch(`${gateway}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

const step = (n: number, s: string) => console.log(`\n=== ${n}. ${s} ===`);

// 0. gateway is up
await json("/healthz");
const seqBefore = Number(await provider.callFunction(ledger, "seq", {}));
console.log(`gateway ${gateway}, ledger ${ledger} seq ${seqBefore}`);

// 1. x402 payments by the agent
step(1, "agent pays with x402");
if (!existsSync(agentEnv)) throw new Error(`no agent env file at ${agentEnv} (set AGENT_ENV)`);
const agentOut = await run("src/agent.ts", ["--questions", values.questions!], resolve(gatewayDir, "../agent-client"), agentEnv);
const payTxs = [...agentOut.matchAll(/paid [0-9.]+ USDC, tx (\S+)/g)].map((m) => m[1]!);
const reqIds = [...agentOut.matchAll(/\/requests\/(req_[0-9a-z]+)/g)].map((m) => m[1]!);
if (payTxs.length === 0 || reqIds.length === 0) throw new Error("the agent made no paid request");
for (const tx of payTxs) links.push({ step: "x402 payment (agent → treasury, USDC)", tx });

// 2. events reach the ledger contract
step(2, "ledger events on NEAR");
const receipts: Receipt[] = [];
for (const id of reqIds) {
  const until = Date.now() + 120_000;
  let r = Receipt.parse(await json(`/requests/${id}`));
  while (r.ledger_tx === null && Date.now() < until) { await delay(2000); r = Receipt.parse(await json(`/requests/${id}`)); }
  if (r.ledger_tx === null) throw new Error(`${id}: no ledger tx within 2 minutes (is the ledger writer configured?)`);
  console.log(`${id}: backend ${r.backend ?? "pool"}, ${r.cost_mc} mc, ledger #${r.ledger_seq}, tx ${r.ledger_tx}`);
  receipts.push(r);
}
const seqAfter = Number(await provider.callFunction(ledger, "seq", {}));
if (seqAfter <= seqBefore) throw new Error(`ledger seq did not move (${seqBefore} → ${seqAfter})`);
console.log(`ledger seq ${seqBefore} → ${seqAfter}`);
const ledgerTxs = [...new Set(receipts.map((r) => r.ledger_tx!))];
for (const tx of ledgerTxs) links.push({ step: "ledger append_batch (signed events)", tx });

// 3. anyone can verify the events
step(3, "verify-event");
for (const tx of ledgerTxs) await run("src/verify-event.ts", [tx], gatewayDir);

// 4 + 5. payout epoch and claim
if (values["no-claim"]) {
  console.log("\n--no-claim: skipping epoch + claim");
} else if (!existsSync(providerEnv)) {
  console.log(`\nno provider env at ${providerEnv} (set PROVIDER_ENV): skipping epoch + claim`);
} else {
  const p = readEnv(providerEnv);
  const account = p.PROVIDER_ACCOUNT_ID;
  if (!account) throw new Error(`PROVIDER_ACCOUNT_ID missing in ${providerEnv}`);
  if (!receipts.some((r) => (r.route ?? []).length > 0)) console.log("warning: no answer had a provider route (NEAR AI Cloud served them); the provider may earn nothing this epoch");
  step(4, `epoch posted for ${account} (waiting up to ${values["wait-minutes"]} min)`);
  const start = Date.now();
  const before = PayoutsResponse.parse(await json(`/payouts/${account}`));
  const known = new Set(before.payouts.map((x) => x.epoch));
  let ready: PayoutsResponse["payouts"][number] | undefined;
  while (Date.now() - start < waitMs) {
    const now = PayoutsResponse.parse(await json(`/payouts/${account}`));
    const fresh = now.payouts.filter((x) => !known.has(x.epoch) || (!x.claimed && !x.swept));
    const posted = fresh.find((x) => x.post_tx);
    if (posted && !links.some((l) => l.tx === posted.post_tx)) { console.log(`epoch ${posted.epoch} posted: ${posted.amount_units} units, root ${posted.merkle_root}`); links.push({ step: `payout epoch ${posted.epoch} posted (root + USDC)`, tx: posted.post_tx! }); }
    ready = fresh.find((x) => x.claimable && !x.claimed);
    if (ready) break;
    await delay(10_000);
  }
  if (!ready) throw new Error(`no claimable payout for ${account} within ${values["wait-minutes"]} min (EPOCH_SECONDS=120 on the gateway?)`);
  step(5, `claim epoch ${ready.epoch}`);
  const usdc = String((await provider.callFunction(p.PAYOUT_CONTRACT_ID ?? "payout.ramx.testnet", "config", {}) as { token: string }).token);
  const bal = async () => BigInt(String(await provider.callFunction(usdc, "ft_balance_of", { account_id: account })));
  const b0 = await bal();
  const out = await run("scripts/claim-payout.ts", ["--epoch", String(ready.epoch), "--broadcast"], gatewayDir, providerEnv);
  const claim = /nearblocks\.io\/txns\/(\S+)/.exec(out)?.[1];
  if (claim) links.push({ step: `claim epoch ${ready.epoch} (Merkle proof → USDC)`, tx: claim });
  console.log(`${account} USDC balance +${await bal() - b0} units`);
}

console.log("\n=== NearBlocks links ===");
for (const l of links) console.log(`- ${l.step}: [${l.tx.slice(0, 10)}…](${nearblocks(l.tx)})`);
