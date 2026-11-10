import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { keccak256, toBytes } from "viem";
import type { PoolPlanResponse } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";

/**
 * SPEC §16.1 items on the MVP model (one Parallax scheduler per pool on the gateway host, Parallax
 * API on 127.0.0.1, signed node heartbeats).
 */

// ---------- many pools: the private coordinator URL of each pool ----------

/** pool_id → coordinator URL: POOL_COORDINATORS (env JSON) + POOL_COORDINATORS_FILE (read each call). */
export function coordinatorMap(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (raw: string, from: string) => {
    try {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    } catch {
      console.warn(`coordinator map: bad JSON in ${from}`);
    }
  };
  if (cfg.env.POOL_COORDINATORS) add(cfg.env.POOL_COORDINATORS, "POOL_COORDINATORS");
  const f = cfg.env.POOL_COORDINATORS_FILE;
  if (f && existsSync(f)) add(readFileSync(f, "utf8"), f);
  return out;
}

export const coordinatorFor = (cfg: Config, poolId: string, map = coordinatorMap(cfg)): string => map[poolId] ?? cfg.env.POOL_COORDINATOR_URL;
export const urlHash = (url: string): `0x${string}` => keccak256(toBytes(url));

// ---------- automatic pool formation ----------

/** Private DHT name of a pool (keyed by a gateway secret, so other people cannot guess it). */
export function dhtPrefix(cfg: Config, poolId: string): string {
  const secret = cfg.env.JWT_SECRET ?? cfg.env.GATEWAY_SIGNING_KEY ?? "";
  if (!secret) console.warn("dht prefix: no JWT_SECRET / GATEWAY_SIGNING_KEY; the prefix is guessable");
  return `gp-${createHmac("sha256", secret).update(poolId).digest("hex").slice(0, 12)}`;
}

type Cand = { node_id: string; mem: number };
const RTT_MAX_AGE_MS = 10 * 60_000;

/** Delay between two nodes: the larger of the two recent measurements (one direction is enough). */
function rtt(db: Db, a: string, b: string, now: number): number | null {
  const rows = db.prepare("SELECT ms FROM node_rtt WHERE ((a = ? AND b = ?) OR (a = ? AND b = ?)) AND ts >= ?").all(a, b, b, a, now - RTT_MAX_AGE_MS) as { ms: number }[];
  return rows.length ? Math.max(...rows.map((r) => r.ms)) : null;
}

/**
 * Group unassigned "auto" nodes (fresh heartbeat, known usable memory) into pools: every pair in a
 * group has a measured delay ≤ max_rtt_ms. Largest memory first; a group grows until it can hold the
 * largest catalog model (size × 1.2 for KV cache), else the largest model it can hold. Groups with
 * fewer than min_nodes nodes or no model wait. Assignments are kept (no re-planning of formed pools).
 */
export function formPools(db: Db, cfg: Config, now = Date.now()): string[] {
  const f = cfg.net.pool_formation;
  const minTs = now - cfg.net.router.pool_heartbeat_max_age_s * 1000;
  let cands = (db.prepare(`SELECT node_id, hb_usable_mem_gb AS mem FROM nodes WHERE auto_pool = 1 AND pool_id = 'auto'
    AND hb_ts >= ? AND hb_usable_mem_gb IS NOT NULL ORDER BY hb_usable_mem_gb DESC, node_id`).all(minTs) as Cand[]);
  const models = [...cfg.net.models].sort((a, b) => b.size_gb - a.size_gb);
  const fits = (mem: number) => models.find((m) => mem >= m.size_gb * 1.2);
  const formed: string[] = [];
  while (cands.length) {
    const group: Cand[] = [cands[0]!];
    for (const c of cands.slice(1)) {
      if (fits(group.reduce((s, g) => s + g.mem, 0)) === models[0]) break;
      if (group.every((g) => { const ms = rtt(db, g.node_id, c.node_id, now); return ms !== null && ms <= f.max_rtt_ms; })) group.push(c);
    }
    const model = fits(group.reduce((s, g) => s + g.mem, 0));
    const ids = new Set(group.map((g) => g.node_id));
    cands = cands.filter((c) => !ids.has(c.node_id));
    if (!model || group.length < f.min_nodes) continue;
    const members = [...ids].sort();
    const poolId = `auto-${createHash("sha256").update(members.join(",")).digest("hex").slice(0, 8)}`;
    db.transaction(() => {
      const upd = db.prepare("UPDATE nodes SET pool_id = ? WHERE node_id = ?");
      for (const m of members) upd.run(poolId, m);
      db.prepare(`INSERT INTO pools (pool_id, model, formed_at) VALUES (?, ?, ?) ON CONFLICT(pool_id) DO UPDATE SET model = excluded.model, formed_at = excluded.formed_at`).run(poolId, model.model_id, now);
    })();
    console.log(JSON.stringify({ msg: "pool_formed", pool_id: poolId, model: model.model_id, members }));
    formed.push(poolId);
  }
  return formed;
}

export function poolPlan(db: Db, cfg: Config): PoolPlanResponse {
  const rows = db.prepare(`SELECT n.node_id, n.pool_id, p.model FROM nodes n LEFT JOIN pools p ON p.pool_id = n.pool_id
    WHERE n.auto_pool = 1 ORDER BY n.pool_id, n.node_id`).all() as { node_id: `0x${string}`; pool_id: string; model: string | null }[];
  const pools = new Map<string, PoolPlanResponse["pools"][number]>();
  const waiting: `0x${string}`[] = [];
  for (const r of rows) {
    if (r.pool_id === "auto" || !r.model) { waiting.push(r.node_id); continue; }
    const p = pools.get(r.pool_id) ?? { pool_id: r.pool_id, model: r.model, members: [], dht_prefix: dhtPrefix(cfg, r.pool_id) };
    p.members.push(r.node_id);
    pools.set(r.pool_id, p);
  }
  return { pools: [...pools.values()], waiting };
}

const lastProbe = new Map<string, number>();

/** Peers an unassigned "auto" node should measure now (at most every probe_every_s). */
export function probeList(db: Db, cfg: Config, nodeId: string, now = Date.now()): { node_id: `0x${string}`; lan_ip: string; port: number }[] {
  if ((lastProbe.get(nodeId) ?? 0) > now - cfg.net.pool_formation.probe_every_s * 1000) return [];
  lastProbe.set(nodeId, now);
  const minTs = now - cfg.net.router.pool_heartbeat_max_age_s * 1000;
  return db.prepare(`SELECT node_id, hb_lan_ip AS lan_ip, hb_p2p_port AS port FROM nodes WHERE auto_pool = 1 AND pool_id = 'auto'
    AND node_id != ? AND hb_ts >= ? AND hb_lan_ip IS NOT NULL AND hb_p2p_port IS NOT NULL`).all(nodeId, minTs) as { node_id: `0x${string}`; lan_ip: string; port: number }[];
}
