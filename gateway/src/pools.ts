import { closeSync, existsSync, openSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { LayerRange, ModelConfig, Route } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { validLayerMap } from "./route.ts";

/**
 * Post-MVP P5 pool checks (docs/POST_MVP_PLAN.md). All state is in SQLite or in files the
 * pool/hooks write on this machine (the gateway and the Parallax scheduler share a host, SPEC §2).
 */

// ---------- P5.5 clean restart ----------

type PoolRow = { restart_id: number; restart_at: number | null };
const poolRow = (db: Db, poolId: string): PoolRow =>
  (db.prepare("SELECT restart_id, restart_at FROM pools WHERE pool_id = ?").get(poolId) as PoolRow | undefined) ?? { restart_id: 0, restart_at: null };

export const restartId = (db: Db, poolId: string): number => poolRow(db, poolId).restart_id;

/**
 * Order a clean restart of the whole pool (every member stops its process group and joins again)
 * after a live re-placement. At most once per restart_cooldown_s. Returns the new restart ID or null.
 */
export function orderRestart(db: Db, cfg: Config, poolId: string, reason: string, now = Date.now()): number | null {
  const row = poolRow(db, poolId);
  if (row.restart_at !== null && now - row.restart_at < cfg.net.resilience.restart_cooldown_s * 1000) return null;
  const id = row.restart_id + 1;
  db.prepare(`INSERT INTO pools (pool_id, restart_id, restart_at) VALUES (?, ?, ?)
    ON CONFLICT(pool_id) DO UPDATE SET restart_id = excluded.restart_id, restart_at = excluded.restart_at`).run(poolId, id, now);
  console.warn(JSON.stringify({ msg: "pool_restart_ordered", pool_id: poolId, restart_id: id, reason }));
  return id;
}

/** A restart is running while a registered member has not acknowledged it (until restart_timeout_s). */
export function isRestarting(db: Db, cfg: Config, poolId: string, now = Date.now()): boolean {
  const row = poolRow(db, poolId);
  if (row.restart_id === 0 || row.restart_at === null) return false;
  if (now - row.restart_at > cfg.net.resilience.restart_timeout_s * 1000) return false;
  const pending = db.prepare("SELECT count(*) AS n FROM nodes WHERE pool_id = ? AND coalesce(hb_restart_ack, 0) < ?").get(poolId, row.restart_id) as { n: number };
  return pending.n > 0;
}

/** P5.7: a member that swaps while serving makes the pool unfit for routing. */
export function swappingMembers(db: Db, cfg: Config, poolId: string, now = Date.now()): string[] {
  const minTs = now - cfg.net.router.pool_heartbeat_max_age_s * 1000;
  return (db.prepare("SELECT node_id FROM nodes WHERE pool_id = ? AND hb_ts >= ? AND hb_mem_pressure = 'swap_growing'").all(poolId, minTs) as { node_id: string }[]).map((r) => r.node_id);
}

// ---------- P5.4 admission allow-list ----------

const lastAllowList = new Map<string, string>();

/**
 * Write the peer IDs of registered nodes with a fresh signed heartbeat. The scheduler hook admits a
 * node_join only for these peers. Atomic replace; written only when the list changes.
 */
export function writeAllowedPeers(db: Db, cfg: Config, now = Date.now()): void {
  const path = cfg.env.PARALLAX_ALLOWED_PEERS_FILE;
  if (!path) return;
  const minTs = now - cfg.net.router.pool_heartbeat_max_age_s * 1000;
  const peers = (db.prepare("SELECT DISTINCT hb_peer_id AS p FROM nodes WHERE hb_peer_id IS NOT NULL AND hb_ts >= ? ORDER BY hb_peer_id").all(minTs) as { p: string }[]).map((r) => r.p);
  const body = JSON.stringify({ peer_ids: peers });
  if (lastAllowList.get(path) === body && existsSync(path)) return;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ peer_ids: peers, ts: now }));
  renameSync(tmp, path);
  lastAllowList.set(path, body);
}

// ---------- P5.8 exact route / P5.9 cross-check: the hook route log ----------

export type RouteLine = { ramx_req_id: string; parallax_request_id: string; routing_table: string[]; ts: number };
const TAIL_BYTES = 4 * 1024 * 1024;

/** Lines from the end of the route log (newest last). Bad lines are skipped. */
export function readRouteLog(path: string | undefined, sinceMs = 0): RouteLine[] {
  if (!path || !existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // first line may be cut
  const out: RouteLine[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l) as RouteLine;
      if (typeof r.ramx_req_id === "string" && Array.isArray(r.routing_table) && typeof r.ts === "number" && r.ts >= sinceMs) out.push(r);
    } catch { /* skip */ }
  }
  return out;
}

/**
 * The route Parallax really used for this request (the last forward attempt in the route log),
 * mapped from peer IDs to registered nodes and their heartbeat layer ranges. null = unknown.
 */
export function exactRoute(db: Db, cfg: Config, reqId: string, model: ModelConfig): Route | null {
  const line = readRouteLog(cfg.env.PARALLAX_ROUTE_LOG).filter((l) => l.ramx_req_id === reqId).at(-1);
  if (!line) return null;
  const hops: { node_id: string; layers: LayerRange }[] = [];
  for (const peer of line.routing_table) {
    const n = db.prepare("SELECT node_id, hb_layers FROM nodes WHERE hb_peer_id = ?").get(peer) as { node_id: string; hb_layers: string | null } | undefined;
    if (!n?.hb_layers) return null;
    hops.push({ node_id: n.node_id, layers: JSON.parse(n.hb_layers) as LayerRange });
  }
  return validLayerMap(hops, model.num_layers);
}

/**
 * P5.9 coordinator cross-check for one pool. For each member: sessions the node reported (from
 * Parallax --notify-url, signed heartbeats) vs forwards the scheduler routed through its peer IDs
 * (route log), over route_check_window_s. Dispute = a member with ≥ route_check_min_requests routed
 * and |reported − routed| / routed > route_dispute_ratio. No route log → no check (false).
 */
export function routeDispute(db: Db, cfg: Config, poolId: string, now = Date.now()): boolean {
  const r = cfg.net.resilience;
  if (!cfg.env.PARALLAX_ROUTE_LOG) return false;
  const since = now - r.route_check_window_s * 1000;
  const lines = readRouteLog(cfg.env.PARALLAX_ROUTE_LOG, since);
  const members = db.prepare("SELECT node_id, hb_peer_id FROM nodes WHERE pool_id = ?").all(poolId) as { node_id: string; hb_peer_id: string | null }[];
  for (const m of members) {
    const peers = new Set((db.prepare("SELECT DISTINCT peer_id FROM node_served WHERE node_id = ? AND ts >= ? AND peer_id IS NOT NULL").all(m.node_id, since) as { peer_id: string }[]).map((x) => x.peer_id));
    if (m.hb_peer_id) peers.add(m.hb_peer_id);
    const routed = lines.filter((l) => l.routing_table.some((p) => peers.has(p))).length;
    if (routed < r.route_check_min_requests) continue;
    const reported = (db.prepare("SELECT coalesce(sum(sessions), 0) AS n FROM node_served WHERE node_id = ? AND ts >= ?").get(m.node_id, since) as { n: number }).n;
    if (Math.abs(reported - routed) / routed > r.route_dispute_ratio) {
      console.warn(JSON.stringify({ msg: "route_dispute", pool_id: poolId, node_id: m.node_id, routed, reported }));
      return true;
    }
  }
  return false;
}
