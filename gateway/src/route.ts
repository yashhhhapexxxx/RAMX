import type { RamxConfig, LayerRange, ModelConfig, PoolStateResponse, Route } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { poolReliability } from "./reliability.ts";
import { isRestarting } from "./pools.ts";

/**
 * Route source (SPEC §5.5). Parallax /cluster/status_json has no layer ranges, so each node agent
 * reports its own range in its signed heartbeat. The pool's layer map = the latest FRESH heartbeats
 * (≤ router.pool_heartbeat_max_age_s) of the pool's registered nodes. The map is valid only if the
 * ranges cover [0, num_layers) of the model exactly once (no gaps, no overlaps). Otherwise the route
 * is unknown (null) and the node shares of a request go to the reserve.
 */

export type NodeHb = { node_id: string; pool_id: string; hb_ts: number | null; hb_online: number | null; hb_model: string | null; hb_layers: string | null };

/** The config model a Parallax model name belongs to (GPU nodes report model_id, Macs the MLX variant). */
export function configModelFor(cfg: RamxConfig, name: string | null): ModelConfig | undefined {
  if (!name) return undefined;
  return cfg.models.find((m) => m.model_id === name || m.mlx_variant === name);
}

/** Order the hops by start layer and check exact cover of [0, total). null = invalid. */
export function validLayerMap(hops: { node_id: string; layers: LayerRange }[], total: number): Route | null {
  if (hops.length === 0) return null;
  const sorted = [...hops].sort((a, b) => a.layers[0] - b.layers[0]);
  let next = 0;
  for (const h of sorted) {
    if (h.layers[0] !== next || h.layers[1] <= h.layers[0]) return null;
    next = h.layers[1];
  }
  return next === total ? sorted.map((h) => ({ node_id: h.node_id, layers: [h.layers[0], h.layers[1]] as LayerRange })) : null;
}

const freshNodes = (db: Db, cfg: RamxConfig, poolId: string | null, now: number): NodeHb[] => {
  const minTs = now - cfg.router.pool_heartbeat_max_age_s * 1000;
  const sql = `SELECT node_id, pool_id, hb_ts, hb_online, hb_model, hb_layers FROM nodes WHERE hb_ts >= ? AND hb_online = 1${poolId ? " AND pool_id = ?" : ""}`;
  return (poolId ? db.prepare(sql).all(minTs, poolId) : db.prepare(sql).all(minTs)) as NodeHb[];
};

/** Layer map of one pool for one model, from fresh heartbeats. */
export function poolLayerMap(db: Db, cfg: RamxConfig, poolId: string, model: ModelConfig, now = Date.now()): Route | null {
  const hops = freshNodes(db, cfg, poolId, now)
    .filter((n) => n.hb_layers && configModelFor(cfg, n.hb_model)?.model_id === model.model_id)
    .map((n) => ({ node_id: n.node_id, layers: JSON.parse(n.hb_layers!) as LayerRange }));
  return validLayerMap(hops, model.num_layers);
}

/** Unknown members keep the contract optional; stale/offline nodes never constrain the minimum. */
export function poolContextLength(db: Db, cfg: RamxConfig, poolId: string, model?: ModelConfig, now = Date.now()): number | undefined {
  const rows = db.prepare(`SELECT hb_max_seq, hb_model FROM nodes WHERE pool_id = ? AND hb_online = 1
    AND hb_ts >= ? AND hb_ts <= ?`).all(poolId, now - cfg.router.pool_heartbeat_max_age_s * 1000, now + 60_000) as { hb_max_seq: number | null; hb_model: string | null }[];
  const members = rows.filter((n) => !model || configModelFor(cfg, n.hb_model)?.model_id === model.model_id);
  if (!members.length || members.some((n) => !n.hb_max_seq)) return undefined;
  return Math.min(...members.map((n) => n.hb_max_seq!));
}

/** GET /pools/:pool_id. The coordinator's node agent writes ramx.pool from this. */
export function poolState(db: Db, cfg: Config, poolId: string, now = Date.now()): PoolStateResponse {
  const net = cfg.net;
  const fresh = freshNodes(db, net, poolId, now);
  const members = fresh.map((n) => n.node_id).sort();
  // P5.5: while a clean restart runs, the listing says "loading" (the router skips the pool too).
  const restarting = isRestarting(db, cfg, poolId, now);
  for (const m of net.models) {
    const map = poolLayerMap(db, net, poolId, m, now);
    if (map) return { pool_id: poolId, models: [m.model_id], members, status: restarting ? "loading" : "ready", layer_map: map, restarting, reliability: poolReliability(db, cfg, poolId, now), context_length: poolContextLength(db, net, poolId, m, now) };
  }
  // No valid map: list the config models the fresh nodes report (so the listing still says what it loads).
  const models = [...new Set(fresh.map((n) => configModelFor(net, n.hb_model)?.model_id).filter((x): x is string => !!x))];
  return { pool_id: poolId, models, members, status: members.length > 0 ? "loading" : "offline", layer_map: null, restarting, reliability: poolReliability(db, cfg, poolId, now) };
}
