import { DIRECTORY_ENTITY, type DirectoryModel, type DirectoryNode, type DirectoryPool } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { accountStatsSnapshot } from "./account-stats.ts";
import { coordinatorFor, urlHash } from "./formation.ts";
import { providerCoordinator, providerPool } from "./provider-state.ts";
import { poolState } from "./route.ts";
import type { Directory } from "./router.ts";

/**
 * The directory, served by the gateway itself (Phase 4). Every node record comes from the node's
 * latest **signed** heartbeat (POST /nodes/heartbeat), every pool record from those heartbeats
 * (members, layer map, status) plus the gateway's own reliability score. Nothing is self-published,
 * so a laptop needs no chain key and no write fee to be listed. A listing expires LISTING_TTL_MS
 * after the node's last heartbeat.
 */
export const LISTING_TTL_MS = 120_000;

type NodeRow = {
  node_id: string; account_id: string; pool_id: string; gpu: string; mem_gb: number;
  hb_ts: number; hb_online: number | null; hb_layers: string | null; hb_tok_s: number | null; score: number | null;
};

export function gatewayDirectory(cfg: Config, db: Db): Directory {
  const listedNodes = (now: number) => db.prepare(`SELECT n.node_id, n.account_id, n.pool_id, n.gpu, n.mem_gb, n.hb_ts, n.hb_online, n.hb_layers, n.hb_tok_s, r.score
    FROM nodes n LEFT JOIN node_reliability r ON r.node_id = n.node_id
    WHERE n.hb_ts IS NOT NULL AND n.hb_ts >= ? AND n.banned = 0 ORDER BY n.pool_id, n.node_id`).all(now - LISTING_TTL_MS) as NodeRow[];

  const pools = (now = Date.now()): DirectoryPool[] => {
    const ids = [...new Set(listedNodes(now).map((n) => n.pool_id).filter((id) => id !== "auto"))];
    const out: DirectoryPool[] = [];
    for (const id of ids) {
      const s = poolState(db, cfg, id, now);
      if (s.models.length === 0) continue; // no fresh member reports a known model yet
      out.push({
        type: DIRECTORY_ENTITY.pool, pool_id: id, models: s.models, members: s.members, status: s.status, layer_map: s.layer_map,
        // The router re-checks this against the coordinator it would use; provider pools go through the relay.
        coordinator_url_hash: urlHash(providerPool(db, id) ? providerCoordinator(db, id)! : coordinatorFor(cfg, id)),
        reliability: s.reliability,
        ...(s.context_length ? { context_length: s.context_length } : {}),
      });
    }
    return out;
  };

  return {
    models: async (): Promise<DirectoryModel[]> => cfg.net.models.map((m) => ({
      type: DIRECTORY_ENTITY.model, model_id: m.model_id, mlx_variant: m.mlx_variant, size_gb: m.size_gb, model_factor: m.model_factor, license: m.license,
    })),
    nodes: async (): Promise<DirectoryNode[]> => listedNodes(Date.now()).map((n) => {
      const online = n.hb_online === 1;
      return {
        type: DIRECTORY_ENTITY.node, owner_account: n.account_id as DirectoryNode["owner_account"], node_id: n.node_id as DirectoryNode["node_id"],
        pool_id: n.pool_id, gpu: n.gpu, mem_gb: n.mem_gb,
        status: online ? (n.hb_layers ? "online" : "loading") : "offline",
        layers: online && n.hb_layers ? JSON.parse(n.hb_layers) as DirectoryNode["layers"] : null,
        tok_s: n.hb_tok_s, reliability: n.score ?? cfg.net.reliability.initial_score,
      };
    }),
    pools: async () => pools(),
    readyPools: async (model: string) => pools().filter((p) => p.status === "ready" && p.models.includes(model)),
    stats: async () => accountStatsSnapshot(db, cfg),
  };
}
