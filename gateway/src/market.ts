import { createHash } from "node:crypto";
import type { Context } from "hono";
import { canonicalJson, SwarmCommitRequest, SwarmRevealRequest, SwarmRoundResponse, SwarmRoundsResponse, type SwarmBid, type SwarmRole } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errorResponse } from "./errors.ts";
import { recordEvent, type Signer } from "./events.ts";
import { verifyNep413, type NearKeyLookup } from "./near-auth.ts";

/**
 * Phase 7: capacity market for AI agents (rules: swarm-sim/RULES.md). Sealed-bid rounds:
 * commit (first 2/3 of a round) → reveal (last 1/3) → uniform-price clearing per model, one
 * `swarm_cleared` ledger event per model, priority slots for the winning buyers. Every commit and
 * reveal is a NEP-413 message signed by the agent's own full-access key.
 */

export const SWARM_RECIPIENT = "ramx-swarm";
export const SLOT_TTL_MS = 10 * 60_000;

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest();
const hex = (s: string) => sha256(s).toString("hex");

export const roundMs = (cfg: Config) => (cfg.env.SWARM_ROUND_S ?? 30) * 1000;
export const roundOf = (ms: number, now = Date.now()) => Math.floor(now / ms);
export function phaseOf(ms: number, round: number, now = Date.now()): "commit" | "reveal" | "closed" | "future" {
  const start = round * ms;
  if (now < start) return "future";
  if (now < start + Math.floor((ms * 2) / 3)) return "commit";
  if (now < start + ms) return "reveal";
  return "closed";
}

/** commit = sha256(canonical_json(bid) ‖ ":" ‖ salt ‖ ":" ‖ agent), hex. */
export const commitOf = (bid: SwarmBid, salt: string, agent: string): string => hex(`${canonicalJson(bid)}:${salt}:${agent}`);
/** NEP-413 message and nonce the agent signs for each phase (the sim and any wallet use the same). */
export const commitMessage = (round: number, role: SwarmRole, commit: string) => `ramx-swarm commit ${round} ${role} ${commit}`;
export const revealMessage = (round: number, bid: SwarmBid, salt: string) => `ramx-swarm reveal ${round} ${canonicalJson(bid)} ${salt}`;
export const swarmNonce = (round: number, agent: string, phase: "commit" | "reveal", role: SwarmRole): Buffer => sha256(`${round}:${agent}:${phase}:${role}`);

export type Unit = { agent: string; price: number };
export type Allocation = { agent: string; role: SwarmRole; units: number; price_mc: number; amount_mc: number; payment: "due" | "paid" };

/**
 * Uniform-price clearing for one model. Buyer units by price desc, seller units by price asc
 * (ties: sha256(round ‖ agent)). k = max units with buyer[k-1] ≥ seller[k-1];
 * price = floor((buyer[k-1] + seller[k-1]) / 2). null = no trade.
 */
export function clear(round: number, bids: (SwarmBid & { agent: string })[]): { price: number; units: number; allocations: Allocation[] } | null {
  const tie = (a: string) => hex(`${round}:${a}`);
  const expand = (role: SwarmRole) => bids.filter((b) => b.role === role).flatMap((b) => Array.from({ length: b.units }, () => ({ agent: b.agent, price: b.price_mc })));
  const order = (dir: 1 | -1) => (x: Unit, y: Unit) => (x.price - y.price) * dir || (tie(x.agent) < tie(y.agent) ? -1 : tie(x.agent) > tie(y.agent) ? 1 : 0);
  const buy = expand("buyer").sort(order(-1));
  const sell = expand("seller").sort(order(1));
  let k = 0;
  while (k < buy.length && k < sell.length && buy[k]!.price >= sell[k]!.price) k++;
  if (k === 0) return null;
  const price = Math.floor((buy[k - 1]!.price + sell[k - 1]!.price) / 2);
  const count = (units: Unit[], role: SwarmRole): Allocation[] => {
    const m = new Map<string, number>();
    for (const u of units.slice(0, k)) m.set(u.agent, (m.get(u.agent) ?? 0) + 1);
    return [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([agent, units]) => ({ agent, role, units, price_mc: price, amount_mc: units * price, payment: "due" as const }));
  };
  return { price, units: k, allocations: [...count(buy, "buyer"), ...count(sell, "seller")] };
}

type CommitRow = { agent: string; role: SwarmRole; commit_hex: string };
type RevealRow = { agent: string; role: SwarmRole; model: string; units: number; price_mc: number };

const commitsHash = (rows: CommitRow[]) => `0x${hex(canonicalJson(rows.map((r) => ({ agent: r.agent, role: r.role, commit: r.commit_hex }))))}`;

/** Clear every finished round that has commits and was not cleared yet. Returns the rounds cleared. */
export function clearDue(db: Db, cfg: Config, signer: Signer, now = Date.now()): number[] {
  const ms = roundMs(cfg);
  const due = (db.prepare("SELECT DISTINCT round_id FROM swarm_commits WHERE round_id < ? AND round_id NOT IN (SELECT round_id FROM swarm_rounds) ORDER BY round_id").all(roundOf(ms, now)) as { round_id: number }[]).map((r) => r.round_id);
  for (const round of due) {
    db.transaction(() => {
      const commits = db.prepare("SELECT agent, role, commit_hex FROM swarm_commits WHERE round_id = ? ORDER BY agent, role").all(round) as CommitRow[];
      const reveals = db.prepare("SELECT agent, role, model, units, price_mc FROM swarm_reveals WHERE round_id = ? ORDER BY agent, role").all(round) as RevealRow[];
      const cHash = commitsHash(commits);
      const orders: unknown[] = [];
      for (const model of [...new Set(reveals.map((r) => r.model))].sort()) {
        const res = clear(round, reveals.filter((r) => r.model === model).map((r) => ({ ...r, role: r.role })));
        if (!res) continue;
        const aHash = `0x${hex(canonicalJson(res.allocations))}`;
        recordEvent(db, signer, { type: "swarm_cleared", round_id: round, model, price_mc: res.price, units: res.units,
          buyers: res.allocations.filter((a) => a.role === "buyer").length, sellers: res.allocations.filter((a) => a.role === "seller").length,
          allocations_sha256: aHash as `0x${string}`, commits_sha256: cHash as `0x${string}` }, now);
        const ev = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
        for (const a of res.allocations.filter((x) => x.role === "buyer")) {
          db.prepare("INSERT INTO swarm_slots (agent, model, units_left, round_id, expires_at) VALUES (?, ?, ?, ?, ?)").run(a.agent, model, a.units, round, now + SLOT_TTL_MS);
        }
        orders.push({ model, price_mc: res.price, units: res.units, allocations: res.allocations, allocations_sha256: aHash, event_id: ev });
      }
      db.prepare("INSERT INTO swarm_rounds (round_id, cleared_at, commits_sha256, orders) VALUES (?, ?, ?, ?)").run(round, now, cHash, JSON.stringify(orders));
    })();
  }
  return due;
}

/** Use one priority slot of `nearAccount` for `model`, if it has one. */
export function takeSlot(db: Db, nearAccount: string | null, model: string, now = Date.now()): boolean {
  if (!nearAccount) return false;
  const s = db.prepare("SELECT id FROM swarm_slots WHERE agent = ? AND model = ? AND units_left > 0 AND expires_at > ? ORDER BY expires_at LIMIT 1").get(nearAccount, model, now) as { id: number } | undefined;
  if (!s) return false;
  db.prepare("UPDATE swarm_slots SET units_left = units_left - 1 WHERE id = ?").run(s.id);
  return true;
}

/** A key check on RPC failed (not a refusal): the client may retry. */
class RpcDown extends Error {}

/** Full-access key checks, cached 10 min per (agent, key): an agent signs 2 messages per round. */
function cachedKeys(keys: NearKeyLookup, ttlMs = 10 * 60_000): NearKeyLookup {
  const cache = new Map<string, { perm: Awaited<ReturnType<NearKeyLookup>>; at: number }>();
  return async (agent, pk) => {
    const k = `${agent} ${pk}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < ttlMs) return hit.perm;
    let perm: Awaited<ReturnType<NearKeyLookup>> | undefined;
    for (let i = 0; i < 3 && perm === undefined; i++) {
      try {
        perm = await keys(agent, pk);
      } catch (e) {
        if (i === 2) throw new RpcDown(`NEAR RPC: ${(e as Error).message}`);
      }
    }
    cache.set(k, { perm: perm!, at: Date.now() });
    return perm!;
  };
}

/** Check a signed message: NEP-413 signature by a full-access key of `agent`. Returns an error or null; throws RpcDown. */
async function checkSigned(keys: NearKeyLookup, agent: string, publicKey: string, signature: string, message: string, nonce: Buffer): Promise<string | null> {
  if (!verifyNep413(publicKey, signature, message, nonce, SWARM_RECIPIENT)) return "signature does not match the message, nonce and public key";
  const perm = await keys(agent, publicKey);
  if (perm !== "FullAccess") return `${publicKey} is not a full-access key of ${agent}`;
  return null;
}

/** 401 for a refused signature, 502 when NEAR RPC could not be reached (retry). */
async function signedOr(c: Context, check: Promise<string | null>): Promise<Response | null> {
  try {
    const err = await check;
    return err ? errorResponse(c, 401, "unauthorized", err) : null;
  } catch (e) {
    if (e instanceof RpcDown) return errorResponse(c, 502, "internal", `${e.message}; retry`);
    throw e;
  }
}

function roundView(db: Db, cfg: Config, round: number, now = Date.now()) {
  const ms = roundMs(cfg);
  const cleared = db.prepare("SELECT commits_sha256, orders FROM swarm_rounds WHERE round_id = ?").get(round) as { commits_sha256: string; orders: string } | undefined;
  const commits = db.prepare("SELECT agent, role, commit_hex FROM swarm_commits WHERE round_id = ? ORDER BY agent, role").all(round) as CommitRow[];
  const reveals = db.prepare("SELECT agent, role, model, units, price_mc FROM swarm_reveals WHERE round_id = ? ORDER BY agent, role").all(round) as RevealRow[];
  const revealed = new Set(reveals.map((r) => `${r.agent}/${r.role}`));
  const phase = phaseOf(ms, round, now);
  // Sealed: bids are shown only after the round ends.
  const open = phase === "closed";
  const event = db.prepare("SELECT ledger_seq, ledger_tx FROM ledger_events WHERE id = ?");
  const orders = cleared ? (JSON.parse(cleared.orders) as { event_id: number }[]).map(({ event_id, ...o }) => {
    const e = event.get(event_id) as { ledger_seq: number | null; ledger_tx: string | null } | undefined;
    return { ...o, ledger_seq: e?.ledger_seq ?? null, ledger_tx: e?.ledger_tx ?? null };
  }) : [];
  return SwarmRoundResponse.parse({
    round_id: round,
    phase: cleared ? "cleared" : phase === "closed" ? "open" : phase === "future" ? "commit" : phase,
    commit_ends_at: round * ms + Math.floor((ms * 2) / 3),
    reveal_ends_at: (round + 1) * ms,
    commits: commits.map((c) => ({ agent: c.agent, role: c.role, commit: c.commit_hex, revealed: revealed.has(`${c.agent}/${c.role}`) })),
    bids: open ? reveals.map((r) => ({ agent: r.agent, role: r.role, model: r.model, units: r.units, price_mc: r.price_mc })) : [],
    commits_sha256: cleared?.commits_sha256 ?? null,
    orders,
  });
}

export function marketRoutes(db: Db, cfg: Config, rawKeys: NearKeyLookup) {
  const ms = roundMs(cfg);
  const keys = cachedKeys(rawKeys);
  const bad = (c: Context, m: string) => errorResponse(c, 400, "bad_request", m);
  return {
    async commit(c: Context): Promise<Response> {
      const b = SwarmCommitRequest.safeParse(await c.req.json().catch(() => undefined));
      if (!b.success) return bad(c, b.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
      const r = b.data;
      if (phaseOf(ms, r.round_id) !== "commit") return bad(c, `round ${r.round_id} is not in its commit phase (now round ${roundOf(ms)}, ${phaseOf(ms, roundOf(ms))})`);
      const refused = await signedOr(c, checkSigned(keys, r.agent, r.public_key, r.signature, commitMessage(r.round_id, r.role, r.commit), swarmNonce(r.round_id, r.agent, "commit", r.role)));
      if (refused) return refused;
      const ins = db.prepare("INSERT OR IGNORE INTO swarm_commits (round_id, agent, role, commit_hex, ts) VALUES (?, ?, ?, ?, ?)").run(r.round_id, r.agent, r.role, r.commit, Date.now());
      if (ins.changes !== 1) return bad(c, `${r.agent} already committed as ${r.role} in round ${r.round_id}`);
      return c.json({ ok: true, round_id: r.round_id });
    },
    async reveal(c: Context): Promise<Response> {
      const b = SwarmRevealRequest.safeParse(await c.req.json().catch(() => undefined));
      if (!b.success) return bad(c, b.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
      const r = b.data;
      if (phaseOf(ms, r.round_id) !== "reveal") return bad(c, `round ${r.round_id} is not in its reveal phase`);
      if (!cfg.model(r.bid.model)) return bad(c, `unknown model ${r.bid.model}`);
      const row = db.prepare("SELECT commit_hex FROM swarm_commits WHERE round_id = ? AND agent = ? AND role = ?").get(r.round_id, r.agent, r.bid.role) as { commit_hex: string } | undefined;
      if (!row) return bad(c, `${r.agent} has no ${r.bid.role} commit in round ${r.round_id}`);
      if (commitOf(r.bid, r.salt, r.agent) !== row.commit_hex) return bad(c, "the bid and salt do not match the commit");
      const refused = await signedOr(c, checkSigned(keys, r.agent, r.public_key, r.signature, revealMessage(r.round_id, r.bid, r.salt), swarmNonce(r.round_id, r.agent, "reveal", r.bid.role)));
      if (refused) return refused;
      const ins = db.prepare("INSERT OR IGNORE INTO swarm_reveals (round_id, agent, role, model, units, price_mc, salt, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(r.round_id, r.agent, r.bid.role, r.bid.model, r.bid.units, r.bid.price_mc, r.salt, Date.now());
      if (ins.changes !== 1) return bad(c, "already revealed");
      return c.json({ ok: true, round_id: r.round_id });
    },
    rounds(c: Context): Response {
      const now = Date.now();
      const current = roundOf(ms, now);
      const ids = (db.prepare("SELECT DISTINCT round_id FROM swarm_commits ORDER BY round_id DESC LIMIT 20").all() as { round_id: number }[]).map((r) => r.round_id);
      return c.json(SwarmRoundsResponse.parse({ round_ms: ms, current, rounds: ids.map((id) => roundView(db, cfg, id, now)) }));
    },
    round(c: Context): Response {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id < 0) return bad(c, "bad round id");
      return c.json(roundView(db, cfg, id));
    },
  };
}

/** Clear finished rounds every second. Returns stop(). */
export function startMarket(db: Db, cfg: Config, signer: Signer): () => void {
  const t = setInterval(() => {
    try {
      const done = clearDue(db, cfg, signer);
      if (done.length) console.log(JSON.stringify({ msg: "swarm_cleared", rounds: done }));
    } catch (e) {
      console.error(`market: ${(e as Error).message}`);
    }
  }, 1000);
  return () => clearInterval(t);
}
