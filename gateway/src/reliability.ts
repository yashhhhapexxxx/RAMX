import type { Route } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";

/** Rebuild rolling counters from persisted observations, including missed heartbeat slots. */
export function refreshReliability(db: Db, cfg: Config, nodeId?: string, now = Date.now()): void {
  const since = now - cfg.net.reliability.window_days * 86_400_000;
  const interval = cfg.env.HEARTBEAT_SECONDS * 1000;
  const nodes = (nodeId
    ? db.prepare("SELECT node_id, registered_at FROM nodes WHERE node_id = ?").all(nodeId)
    : db.prepare("SELECT node_id, registered_at FROM nodes").all()) as { node_id: string; registered_at: number }[];
  db.transaction(() => {
    for (const node of nodes) {
      const start = Math.max(0, Math.ceil((since - node.registered_at) / interval));
      const current = Math.max(0, Math.floor((now - node.registered_at) / interval));
      const currentTs = node.registered_at + current * interval;
      const hb = db.prepare(`SELECT count(*) AS received, coalesce(max(slot_ts), -1) AS latest FROM node_heartbeats
        WHERE node_id = ? AND slot_ts >= ? AND slot_ts <= ?`).get(node.node_id, node.registered_at + start * interval, currentTs) as { received: number; latest: number };
      // A current slot counts early only when its heartbeat has arrived; otherwise wait for its deadline.
      const expected = Math.max(0, current - start) + (hb.latest === currentTs ? 1 : 0);
      const requests = db.prepare(`SELECT count(*) AS routed, coalesce(sum(ok), 0) AS ok FROM node_request_outcomes
        WHERE node_id = ? AND ts > ? AND ts <= ?`).get(node.node_id, since, now) as { routed: number; ok: number };
      const initial = cfg.net.reliability.initial_score;
      const successRate = requests.routed ? requests.ok / requests.routed : initial;
      const uptimeRate = expected ? Math.min(1, hb.received / expected) : initial;
      const score = Math.round((cfg.net.reliability.success_weight * successRate + cfg.net.reliability.uptime_weight * uptimeRate) * 1e12) / 1e12;
      db.prepare(`UPDATE node_reliability SET requests_routed = ?, requests_ok = ?, heartbeats_expected = ?,
        heartbeats_received = ?, score = ?, updated_at = ? WHERE node_id = ?`).run(requests.routed, requests.ok, expected, hb.received, score, now, node.node_id);
    }
    if (!nodeId) {
      db.prepare("DELETE FROM node_request_outcomes WHERE ts <= ?").run(since);
      db.prepare("DELETE FROM node_heartbeats WHERE slot_ts < ?").run(since - interval);
    }
  })();
}

/** Online heartbeats count once per registration-aligned interval, using gateway receive time. */
export function recordHeartbeat(db: Db, cfg: Config, nodeId: string, online: boolean, now = Date.now()): void {
  db.transaction(() => {
    if (online) {
      const node = db.prepare("SELECT registered_at FROM nodes WHERE node_id = ?").get(nodeId) as { registered_at: number };
      const interval = cfg.env.HEARTBEAT_SECONDS * 1000;
      const slot = node.registered_at + Math.max(0, Math.floor((now - node.registered_at) / interval)) * interval;
      db.prepare("INSERT OR IGNORE INTO node_heartbeats (node_id, slot_ts) VALUES (?, ?)").run(nodeId, slot);
    }
    refreshReliability(db, cfg, nodeId, now);
  })();
}

/** Client aborts and unknown routes are excluded by billing before this function is called. */
export function countRouted(db: Db, cfg: Config, route: Route | null, ok: boolean, now = Date.now()): void {
  db.transaction(() => {
    for (const nodeId of new Set((route ?? []).map((hop) => hop.node_id))) {
      db.prepare("INSERT INTO node_request_outcomes (node_id, ok, ts) VALUES (?, ?, ?)").run(nodeId, ok ? 1 : 0, now);
      refreshReliability(db, cfg, nodeId, now);
    }
  })();
}

// ---------- SPEC §9.2 pool reliability (the pool is the identity the router scores) ----------

const poolSeen = (db: Db, poolId: string, now: number): void => {
  db.prepare("INSERT OR IGNORE INTO pool_reliability (pool_id, first_seen) VALUES (?, ?)").run(poolId, now);
};

/** Rebuild one pool's score: 0.7 × success rate of requests routed to it + 0.3 × share of slots it was complete. */
export function refreshPoolReliability(db: Db, cfg: Config, poolId: string, now = Date.now()): number {
  const r = cfg.net.reliability;
  const since = now - r.window_days * 86_400_000;
  const interval = cfg.env.HEARTBEAT_SECONDS * 1000;
  poolSeen(db, poolId, now);
  const row = db.prepare("SELECT first_seen FROM pool_reliability WHERE pool_id = ?").get(poolId) as { first_seen: number };
  const from = Math.max(since, row.first_seen);
  // Completed slots up to now; the current slot counts only once it was observed complete.
  const firstSlot = Math.ceil(from / interval) * interval;
  const currentSlot = Math.floor(now / interval) * interval;
  const up = (db.prepare("SELECT count(*) AS n, coalesce(max(slot_ts), -1) AS latest FROM pool_up_slots WHERE pool_id = ? AND slot_ts >= ? AND slot_ts <= ?")
    .get(poolId, firstSlot, currentSlot) as { n: number; latest: number });
  const expected = Math.max(0, (currentSlot - firstSlot) / interval) + (up.latest === currentSlot ? 1 : 0);
  const req = db.prepare("SELECT count(*) AS routed, coalesce(sum(ok), 0) AS ok FROM pool_request_outcomes WHERE pool_id = ? AND ts > ? AND ts <= ?")
    .get(poolId, since, now) as { routed: number; ok: number };
  const success = req.routed ? req.ok / req.routed : r.initial_score;
  const uptime = expected ? Math.min(1, up.n / expected) : r.initial_score;
  const score = Math.round((r.success_weight * success + r.uptime_weight * uptime) * 1e12) / 1e12;
  db.prepare(`UPDATE pool_reliability SET requests_routed = ?, requests_ok = ?, slots_expected = ?, slots_up = ?, score = ?, updated_at = ?
    WHERE pool_id = ?`).run(req.routed, req.ok, expected, up.n, score, now, poolId);
  return score;
}

/** Record whether a request routed to `poolId` was served. Client aborts must not be counted. */
export function countPool(db: Db, cfg: Config, poolId: string, ok: boolean, now = Date.now()): void {
  db.transaction(() => {
    poolSeen(db, poolId, now);
    db.prepare("INSERT INTO pool_request_outcomes (pool_id, ok, ts) VALUES (?, ?, ?)").run(poolId, ok ? 1 : 0, now);
    db.prepare("DELETE FROM pool_request_outcomes WHERE pool_id = ? AND ts <= ?").run(poolId, now - cfg.net.reliability.window_days * 86_400_000);
    refreshPoolReliability(db, cfg, poolId, now);
  })();
}

/** Mark the current heartbeat slot as "pool complete" (every member fresh, layers cover the model once). */
export function recordPoolUp(db: Db, cfg: Config, poolId: string, now = Date.now()): void {
  const interval = cfg.env.HEARTBEAT_SECONDS * 1000;
  db.transaction(() => {
    poolSeen(db, poolId, now);
    db.prepare("INSERT OR IGNORE INTO pool_up_slots (pool_id, slot_ts) VALUES (?, ?)").run(poolId, Math.floor(now / interval) * interval);
    db.prepare("DELETE FROM pool_up_slots WHERE pool_id = ? AND slot_ts < ?").run(poolId, now - cfg.net.reliability.window_days * 86_400_000 - interval);
  })();
}

/** The pool's current score (refreshed on read so missed slots count); a never-seen pool starts at initial_score. */
export function poolReliability(db: Db, cfg: Config, poolId: string, now = Date.now()): number {
  const seen = db.prepare("SELECT 1 FROM pool_reliability WHERE pool_id = ?").get(poolId);
  if (!seen) return cfg.net.reliability.initial_score;
  return refreshPoolReliability(db, cfg, poolId, now);
}
