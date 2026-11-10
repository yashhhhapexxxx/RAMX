import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { KeyPair } from "@near-js/crypto";
import { LedgerEvent, SwarmRoundResponse, type SwarmBid } from "@ramx/shared";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { nep413Hash, type NearKeyLookup } from "../src/near-auth.ts";
import { clear, clearDue, commitMessage, commitOf, revealMessage, roundMs, roundOf, SWARM_RECIPIENT, swarmNonce, takeSlot } from "../src/market.ts";
import { signer, TEST_JWT_SECRET } from "./helpers.ts";

const M = "Qwen/Qwen3-8B-FP8";
const b = (agent: string, role: "buyer" | "seller", units: number, price_mc: number) => ({ agent, role, model: M, units, price_mc });

test("uniform price: k = units where bid ≥ ask; price = midpoint of the k-th pair; pro-rata shares", () => {
  const r = clear(1, [b("b1", "buyer", 3, 100), b("b2", "buyer", 2, 60), b("b3", "buyer", 2, 20), b("s1", "seller", 2, 30), b("s2", "seller", 4, 50)])!;
  // buyer units: 100,100,100,60,60,20,20; seller units: 30,30,50,50,50,50 → k = 5 (60 ≥ 50), 6th: 20 < 50.
  assert.equal(r.units, 5);
  assert.equal(r.price, 55, "floor((60 + 50) / 2)");
  const by = Object.fromEntries(r.allocations.map((a) => [`${a.role}:${a.agent}`, a.units]));
  assert.deepEqual(by, { "buyer:b1": 3, "buyer:b2": 2, "seller:s1": 2, "seller:s2": 3 });
  assert.ok(r.allocations.every((a) => a.amount_mc === a.units * 55 && a.payment === "due"));
  assert.equal(clear(1, [b("b1", "buyer", 1, 10), b("s1", "seller", 1, 11)]), null, "no overlap, no trade");
  assert.equal(clear(1, [b("b1", "buyer", 5, 10)]), null, "no sellers");
});

test("a round: signed commits, sealed until the end, reveal must match, cleared with a ledger event and slots", async () => {
  const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001", JWT_SECRET: TEST_JWT_SECRET, SWARM_ROUND_S: "3" });
  const db = openDb(":memory:");
  const agents = ["buyer-1.swarm.ramx.testnet", "buyer-2.swarm.ramx.testnet", "seller-1.swarm.ramx.testnet"].map((id) => ({ id, kp: KeyPair.fromRandom("ed25519") }));
  const keys: NearKeyLookup = async (account, pk) => (agents.find((a) => a.id === account && a.kp.getPublicKey().toString() === pk) ? "FullAccess" : null);
  const app = createApp({ cfg, db, signer, nearKeys: keys });
  const post = (path: string, body: object) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const sign = (kp: KeyPair, message: string, nonce: Buffer) => Buffer.from(kp.sign(nep413Hash(message, nonce, SWARM_RECIPIENT)).signature).toString("base64");
  try {
    const ms = roundMs(cfg);
    // Start at the beginning of a commit phase.
    while (Date.now() % ms > 300) await new Promise((r) => setTimeout(r, 50));
    const round = roundOf(ms);
    const bids: Record<string, SwarmBid> = {
      "buyer-1.swarm.ramx.testnet": { role: "buyer", model: M, units: 2, price_mc: 900 },
      "buyer-2.swarm.ramx.testnet": { role: "buyer", model: M, units: 1, price_mc: 500 },
      "seller-1.swarm.ramx.testnet": { role: "seller", model: M, units: 2, price_mc: 400 },
    };
    const salts: Record<string, string> = {};
    for (const a of agents) {
      salts[a.id] = randomBytes(16).toString("hex");
      const commit = commitOf(bids[a.id]!, salts[a.id]!, a.id);
      const r = await post("/swarm/commit", { round_id: round, agent: a.id, role: bids[a.id]!.role, commit, public_key: a.kp.getPublicKey().toString(), signature: sign(a.kp, commitMessage(round, bids[a.id]!.role, commit), swarmNonce(round, a.id, "commit", bids[a.id]!.role)) });
      assert.equal(r.status, 200, await r.clone().text());
    }
    // A forged commit (signed by another key) is refused.
    const forged = await post("/swarm/commit", { round_id: round, agent: agents[0]!.id, role: "seller", commit: "a".repeat(64), public_key: agents[1]!.kp.getPublicKey().toString(), signature: sign(agents[1]!.kp, commitMessage(round, "seller", "a".repeat(64)), swarmNonce(round, agents[0]!.id, "commit", "seller")) });
    assert.equal(forged.status, 401);
    const sealed = SwarmRoundResponse.parse(await (await app.request(`/swarm/rounds/${round}`)).json());
    assert.deepEqual([sealed.phase, sealed.commits.length, sealed.bids.length], ["commit", 3, 0], "bids are sealed");

    while (Date.now() < round * ms + (ms * 2) / 3 + 50) await new Promise((r) => setTimeout(r, 50));
    const cheat = { ...bids["buyer-2.swarm.ramx.testnet"]!, price_mc: 5000 };
    const a2 = agents[1]!;
    const lie = await post("/swarm/reveal", { round_id: round, agent: a2.id, bid: cheat, salt: salts[a2.id], public_key: a2.kp.getPublicKey().toString(), signature: sign(a2.kp, revealMessage(round, cheat, salts[a2.id]!), swarmNonce(round, a2.id, "reveal", "buyer")) });
    assert.match(await lie.text(), /do not match the commit/, "a changed bid is refused");
    for (const a of agents) {
      const r = await post("/swarm/reveal", { round_id: round, agent: a.id, bid: bids[a.id], salt: salts[a.id], public_key: a.kp.getPublicKey().toString(), signature: sign(a.kp, revealMessage(round, bids[a.id]!, salts[a.id]!), swarmNonce(round, a.id, "reveal", bids[a.id]!.role)) });
      assert.equal(r.status, 200, await r.clone().text());
    }
    while (roundOf(ms) === round) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(clearDue(db, cfg, signer), [round]);
    const done = SwarmRoundResponse.parse(await (await app.request(`/swarm/rounds/${round}`)).json());
    assert.equal(done.phase, "cleared");
    assert.equal(done.bids.length, 3, "bids are public after the round");
    const o = done.orders[0]!;
    // buyer units 900, 900, 500; seller 400, 400 → k = 2, price floor((900 + 400) / 2) = 650; buyer-2 gets nothing.
    assert.deepEqual([o.units, o.price_mc, o.allocations.map((x) => `${x.agent}:${x.units}`)], [2, 650, ["buyer-1.swarm.ramx.testnet:2", "seller-1.swarm.ramx.testnet:2"]]);
    const ev = (db.prepare("SELECT payload FROM ledger_events WHERE type = 'swarm_cleared'").all() as { payload: string }[]).map((r) => LedgerEvent.parse(JSON.parse(r.payload)));
    assert.equal(ev.length, 1);
    assert.equal(takeSlot(db, "buyer-1.swarm.ramx.testnet", M), true);
    assert.equal(takeSlot(db, "buyer-1.swarm.ramx.testnet", M), true);
    assert.equal(takeSlot(db, "buyer-1.swarm.ramx.testnet", M), false, "two units won, two slots");
    assert.equal(takeSlot(db, "buyer-2.swarm.ramx.testnet", M), false);
    assert.deepEqual(clearDue(db, cfg, signer), [], "cleared once");
  } finally { db.close(); }
});
