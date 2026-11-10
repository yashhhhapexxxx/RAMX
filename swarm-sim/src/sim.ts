#!/usr/bin/env node
/**
 * Capacity-market simulation (swarm-sim/RULES.md): BUYERS buyer agents and SELLERS seller agents,
 * each a real NEAR testnet account signing its own commit and reveal (NEP-413) with its own key,
 * bid for priority inference slots for ROUNDS rounds. Random demand and prices; no LLM calls.
 *   pnpm --filter @ramx/swarm-sim start            (needs a running gateway; GATEWAY_URL)
 * Keys: ~/.near-credentials/testnet/<agent>.json (scripts/near-swarm-setup.sh). Nothing is spent:
 * bids are signed messages, not transactions.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { canonicalJson, SwarmRoundResponse, SwarmRoundsResponse, type SwarmBid, type SwarmRole } from "@ramx/shared";

const env = process.env;
const gateway = (env.GATEWAY_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const parent = env.SWARM_PARENT ?? "swarm.ramx.testnet";
const BUYERS = Number(env.BUYERS ?? 20);
const SELLERS = Number(env.SELLERS ?? 5);
const ROUNDS = Number(env.ROUNDS ?? 10);
const MODELS = (env.SWARM_MODELS ?? "Qwen/Qwen3-8B-FP8,Qwen/Qwen3-14B-FP8").split(",");
const RECIPIENT = "ramx-swarm";

// ---- protocol (client side; must match gateway/src/market.ts) ----
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest();
const commitOf = (bid: SwarmBid, salt: string, agent: string) => sha256(`${canonicalJson(bid)}:${salt}:${agent}`).toString("hex");
const nonceOf = (round: number, agent: string, phase: "commit" | "reveal", role: SwarmRole) => sha256(`${round}:${agent}:${phase}:${role}`);
const borshString = (s: string) => {
  const b = Buffer.from(s, "utf8");
  const n = Buffer.alloc(4);
  n.writeUInt32LE(b.length);
  return Buffer.concat([n, b]);
};
/** NEP-413: sha256(u32le(2^31 + 413) ‖ borsh{message, nonce[32], recipient, callbackUrl: None}). */
function nep413(message: string, nonce: Buffer): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  return sha256(Buffer.concat([tag, borshString(message), nonce, borshString(RECIPIENT), Buffer.from([0])]));
}

type Agent = { id: string; role: SwarmRole; kp: KeyPair };
function loadAgent(id: string, role: SwarmRole): Agent {
  const f = join(homedir(), ".near-credentials", "testnet", `${id}.json`);
  const j = JSON.parse(readFileSync(f, "utf8")) as { private_key: string };
  return { id, role, kp: KeyPair.fromString(j.private_key as KeyPairString) };
}
const agents: Agent[] = [
  ...Array.from({ length: BUYERS }, (_, i) => loadAgent(`buyer-${i + 1}.${parent}`, "buyer")),
  ...Array.from({ length: SELLERS }, (_, i) => loadAgent(`seller-${i + 1}.${parent}`, "seller")),
];
const sign = (a: Agent, message: string, nonce: Buffer) => Buffer.from(a.kp.sign(nep413(message, nonce)).signature).toString("base64");

/** Random strategy: buyers value a slot at 300–1500 mc, sellers' cost is 200–900 mc. */
function bidOf(a: Agent): SwarmBid {
  const model = MODELS[randomInt(MODELS.length)]!;
  return a.role === "buyer"
    ? { role: "buyer", model, units: randomInt(1, 6), price_mc: randomInt(300, 1501) }
    : { role: "seller", model, units: randomInt(3, 11), price_mc: randomInt(200, 901) };
}

/** POST, retried twice on a gateway/RPC hiccup (5xx or network); 4xx = refused, not retried. */
async function post(path: string, body: unknown): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${gateway}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) return;
      const text = await r.text();
      if (r.status < 500 || i === 2) throw Object.assign(new Error(`${path}: HTTP ${r.status} ${text}`), { final: true });
    } catch (e) {
      if ((e as { final?: boolean }).final || i === 2) throw e;
    }
    await new Promise((res) => setTimeout(res, 300));
  }
}
const sleepUntil = async (t: number) => { while (Date.now() < t) await new Promise((r) => setTimeout(r, Math.min(250, t - Date.now()))); };

const info = SwarmRoundsResponse.parse(await (await fetch(`${gateway}/swarm/rounds`)).json());
const ms = info.round_ms;
const commitMs = Math.floor((ms * 2) / 3);
console.log(`${agents.length} agents (${BUYERS} buyers, ${SELLERS} sellers), ${ROUNDS} rounds of ${ms / 1000} s, models ${MODELS.join(", ")}`);

const summary: { round: number; model: string; price: number; units: number; buyers: number; tx: string | null }[] = [];
let round = Math.floor(Date.now() / ms) + 1; // start at the next round boundary
for (let n = 0; n < ROUNDS; n++, round++) {
  await sleepUntil(round * ms + 200);
  const plays = agents.map((a) => ({ a, bid: bidOf(a), salt: randomBytes(16).toString("hex") }));
  // Commit phase: every agent signs and sends its sealed commit.
  const committed = await Promise.allSettled(plays.map(({ a, bid, salt }) => {
    const commit = commitOf(bid, salt, a.id);
    return post("/swarm/commit", { round_id: round, agent: a.id, role: a.role, commit, public_key: a.kp.getPublicKey().toString(),
      signature: sign(a, `ramx-swarm commit ${round} ${a.role} ${commit}`, nonceOf(round, a.id, "commit", a.role)) });
  }));
  const failedC = committed.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  // Reveal phase.
  await sleepUntil(round * ms + commitMs + 200);
  const revealed = await Promise.allSettled(plays.map(({ a, bid, salt }) => post("/swarm/reveal", { round_id: round, agent: a.id, bid, salt, public_key: a.kp.getPublicKey().toString(),
    signature: sign(a, `ramx-swarm reveal ${round} ${canonicalJson(bid)} ${salt}`, nonceOf(round, a.id, "reveal", a.role)) })));
  const failedR = revealed.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  // Wait for clearing (the gateway clears within a second after the round ends).
  await sleepUntil((round + 1) * ms + 1500);
  let view = SwarmRoundResponse.parse(await (await fetch(`${gateway}/swarm/rounds/${round}`)).json());
  for (let i = 0; i < 10 && view.phase !== "cleared"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    view = SwarmRoundResponse.parse(await (await fetch(`${gateway}/swarm/rounds/${round}`)).json());
  }
  const errs = [...failedC, ...failedR].map((r) => String(r.reason?.message ?? r.reason));
  console.log(`\nround ${round}: ${view.commits.length} commits, ${view.commits.filter((c) => c.revealed).length} reveals${errs.length ? `, ${errs.length} errors (${errs[0]})` : ""}`);
  if (view.orders.length === 0) console.log("  no trade (no buyer price met a seller price)");
  for (const o of view.orders) {
    const buyers = o.allocations.filter((x) => x.role === "buyer");
    console.log(`  ${o.model}: ${o.units} slots at ${o.price_mc} mc each; group order of ${buyers.length} buyers: ${buyers.map((b) => `${b.agent.split(".")[0]} ${b.units}×=${b.amount_mc}`).join(", ")}`);
    summary.push({ round, model: o.model, price: o.price_mc, units: o.units, buyers: buyers.length, tx: o.ledger_tx });
  }
}

// Ledger transactions land asynchronously; show them at the end.
await new Promise((r) => setTimeout(r, 8000));
console.log("\nresults on the NEAR ledger:");
for (const s of summary) {
  const v = SwarmRoundResponse.parse(await (await fetch(`${gateway}/swarm/rounds/${s.round}`)).json());
  const o = v.orders.find((x) => x.model === s.model);
  console.log(`  round ${s.round} ${s.model}: ${s.units} slots @ ${s.price} mc, ${s.buyers} buyers  ${o?.ledger_tx ? `https://testnet.nearblocks.io/txns/${o.ledger_tx}` : "(ledger write pending)"}`);
}
