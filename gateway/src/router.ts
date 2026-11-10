import type { AccountStats, DirectoryModel, DirectoryNode, DirectoryPool, ModelConfig, ModelsResponse, NetworkResponse, Route } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { configModelFor, poolLayerMap, poolContextLength } from "./route.ts";
import { createPricing } from "./pricing.ts";
import type { PoolQueue } from "./queue.ts";
import { isRestarting, routeDispute, swappingMembers } from "./pools.ts";

/** P5.7: score multiplier for a pool with a member whose swap keeps growing (degrade, not exclude). */
const SWAP_SCORE_FACTOR = 0.5;
import { poolReliability } from "./reliability.ts";
import { coordinatorFor, coordinatorMap, urlHash as hashUrl } from "./formation.ts";
import type { PrivacyMode } from "./privacy.ts";
import { providerCoordinator, providerAvailable } from "./provider-state.ts";

/** Read-only directory boundary (gatewayDirectory in directory.ts); tests inject their own. */
export type Directory = {
  stats?(): Promise<AccountStats[]>;
  models(): Promise<DirectoryModel[]>;
  pools(): Promise<DirectoryPool[]>;
  nodes(): Promise<DirectoryNode[]>;
  readyPools(model: string): Promise<DirectoryPool[]>;
};

export type SelectedPool = { poolId: string; coordinatorUrl: string; route: Route | null; score: number; context_length?: number };

/**
 * Privacy (src/privacy.ts): `trusted-ends` = the first and last layers (closest to the prompt and the
 * answer) on trusted accounts' nodes; `trusted-all` = every layer. Other pools are skipped.
 */
export type SelectOptions = {
  privacy?: { mode: PrivacyMode; accounts: Set<string> };
  /** SPEC §16.3 routing preferences: only this pool (header x-ramx-pool). */
  pin?: string;
  /** Only pools with reliability ≥ this (header x-ramx-min-reliability). */
  minReliability?: number;
  /** The requester (private pools, SPEC §16.3). null = x402. */
  accountId?: string | null;
};

/** PRIVATE_POOLS env: pool → accounts allowed besides the pool's own node owners. */
function privatePools(cfg: Config): Record<string, string[]> {
  if (!cfg.env.PRIVATE_POOLS) return {};
  try { return JSON.parse(cfg.env.PRIVATE_POOLS) as Record<string, string[]>; }
  catch { console.warn("PRIVATE_POOLS is not valid JSON; no pool is private"); return {}; }
}

/** Pools are reached through their private coordinator (or the provider relay); listings carry only its URL hash. */
export function createRouter(cfg: Config, db: Db, directory: Directory, queue?: PoolQueue) {
  const active = new Map<string, number>();
  /** SPEC §16.1 batching: load = running requests / slots, so 1 of 4 slots is 25 % loaded (capped at 1). */
  const slots = cfg.net.router.max_concurrent_per_pool;
  const loadOf = (poolId: string) => Math.min(1, (active.get(poolId) ?? 0) / slots);
  /** Pool context per model, cached briefly so the request path adds no extra directory read per request. */
  const contexts = new Map<string, { value: number | undefined; at: number }>();
  const minContext = (pools: SelectedPool[]): number | undefined =>
    pools.length && pools.every((p) => p.context_length !== undefined) ? Math.min(...pools.map((p) => p.context_length!)) : undefined;
  const pricing = createPricing((model) => {
    const rows = db.prepare("SELECT DISTINCT pool_id, hb_model FROM nodes WHERE hb_online = 1 AND hb_ts >= ?")
      .all(Date.now() - cfg.net.router.pool_heartbeat_max_age_s * 1000) as { pool_id: string; hb_model: string | null }[];
    const ids = [...new Set(rows.filter((n) => configModelFor(cfg.net, n.hb_model)?.model_id === model).map((n) => n.pool_id))];
    return { active: ids.reduce((n, id) => n + (active.get(id) ?? 0), 0), queued: queue?.queued(ids) ?? 0 };
  });

  const ownerOf = (nodeId: string) => (db.prepare("SELECT account_id FROM nodes WHERE node_id = ?").get(nodeId) as { account_id: string } | undefined)?.account_id;

  async function candidates(model: ModelConfig, opts: SelectOptions = {}, rejected?: Map<string, string>): Promise<SelectedPool[]> {
    const reject = (id: string, reason: string) => { rejected?.set(id, reason); };
    const pools = await directory.readyPools(model.model_id);
    // SPEC §16.1 many pools: each pool has its own private coordinator (scheduler) URL.
    const coordinators = coordinatorMap(cfg);
    const now = Date.now();
    const minTs = now - cfg.net.router.pool_heartbeat_max_age_s * 1000;
    const out = new Map<string, SelectedPool>();
    for (const p of pools) {
      const provider = providerCoordinator(db, p.pool_id);
      if (provider && !providerAvailable(db, p.pool_id)) { reject(p.pool_id, "The coordinator relay is unavailable."); continue; }
      const coordinatorUrl = provider ?? coordinatorFor(cfg, p.pool_id, coordinators);
      if (p.status !== "ready") { reject(p.pool_id, "The pool directory listing is not ready."); continue; }
      if (!p.models.includes(model.model_id)) { reject(p.pool_id, "The pool does not advertise this model."); continue; }
      if (p.coordinator_url_hash !== hashUrl(coordinatorUrl)) { reject(p.pool_id, "The coordinator address does not match the directory listing."); continue; }
      if (p.members.length === 0) { reject(p.pool_id, "The pool has no advertised members."); continue; }
      // SPEC §16.3: pinning, private pools, banned owners.
      if (opts.pin && p.pool_id !== opts.pin) continue;
      const priv = privatePools(cfg)[p.pool_id];
      if (priv) {
        const owners = (db.prepare("SELECT DISTINCT account_id FROM nodes WHERE pool_id = ?").all(p.pool_id) as { account_id: string }[]).map((r) => r.account_id);
        if (!opts.accountId || ![...priv, ...owners].includes(opts.accountId)) { reject(p.pool_id, "The pool is private and is not available for public discovery."); continue; }
      }
      if ((db.prepare("SELECT count(*) AS n FROM nodes WHERE pool_id = ? AND banned = 1").get(p.pool_id) as { n: number }).n > 0) { reject(p.pool_id, "A pool member is blocked."); continue; }
      // Post-MVP P5.5: never route into a pool that is restarting (it cannot serve).
      if (isRestarting(db, cfg, p.pool_id, now)) {
        console.warn(JSON.stringify({ msg: "pool_skipped", pool_id: p.pool_id, restarting: true }));
        reject(p.pool_id, "The pool is restarting.");
        continue;
      }
      // P5.7: a member whose swap keeps growing makes the pool slower, not unusable. Lower its score
      // (other pools win) instead of removing it: with one pool, requests are still served.
      const swapping = swappingMembers(db, cfg, p.pool_id, now);
      if (swapping.length > 0) console.warn(JSON.stringify({ msg: "pool_degraded", pool_id: p.pool_id, swapping }));
      const swapFactor = swapping.length > 0 ? SWAP_SCORE_FACTOR : 1;
      // Every advertised member must be registered in THIS pool, online, and fresh.
      const members = p.members.map((id) => db.prepare(
        `SELECT n.hb_ts, n.hb_online, n.hb_model, n.hb_hw_verified, r.score FROM nodes n
         LEFT JOIN node_reliability r ON r.node_id = n.node_id WHERE n.node_id = ? AND n.pool_id = ?`,
      ).get(id, p.pool_id) as { hb_ts: number | null; hb_online: number | null; hb_model: string | null; hb_hw_verified: number | null; score: number | null } | undefined);
      if (members.some(n => !n)) { reject(p.pool_id, "A listed member is not registered in this pool."); continue; }
      if (members.some(n => n?.hb_hw_verified === 0)) { reject(p.pool_id, "A member's hardware has not been verified."); continue; }
      if (members.some(n => !n?.hb_online)) { reject(p.pool_id, "A member is offline."); continue; }
      if (members.some(n => n?.hb_ts == null || n.hb_ts < minTs || n.hb_ts > now + 60_000)) { reject(p.pool_id, "A member's heartbeat is missing, stale, or in the future."); continue; }
      if (members.some(n => configModelFor(cfg.net, n?.hb_model ?? null)?.model_id !== model.model_id)) { reject(p.pool_id, "A member is reporting a different model."); continue; }
      // SPEC §9.2: the pool is the reputation identity (its own success rate + uptime), not its weakest node.
      const reliability = poolReliability(db, cfg, p.pool_id, now);
      const load = loadOf(p.pool_id);
      // Use signed heartbeats for the receipt, never the public listing's claimed layer map.
      if (opts.minReliability !== undefined && reliability < opts.minReliability) continue;
      const route = poolLayerMap(db, cfg.net, p.pool_id, model, now);
      if (opts.privacy) {
        // A privacy request needs a known route: every checked hop must belong to a trusted account.
        const hops = !route ? [] : opts.privacy.mode === "trusted-all" ? route : [route[0]!, route.at(-1)!];
        if (!route || !hops.every((h) => opts.privacy!.accounts.has(ownerOf(h.node_id) ?? ""))) continue;
      }
      out.set(p.pool_id, { poolId: p.pool_id, coordinatorUrl, route, score: reliability * (1 - load) * swapFactor, context_length: poolContextLength(db, cfg.net, p.pool_id, model, now) });
    }
    return [...out.values()].sort((a, b) => b.score - a.score || a.poolId.localeCompare(b.poolId));
  }

  return {
    pricing,
    async availability(poolId: string, modelId: string) {
      const checked_at = Date.now();
      const result = (available: boolean, reason: string, action: string) => ({ available, reason, action, checked_at });
      const model = cfg.model(modelId);
      if (!model) return result(false, "The model is not configured on the gateway.", "Contact the gateway operator.");
      const catalog = await directory.models();
      if (!catalog.some(entry => entry.model_id === modelId)) return result(false, "The model is missing from the marketplace directory.", "Check the model listing and try again.");
      const rejected = new Map<string, string>();
      const eligible = await candidates(model, {}, rejected);
      if (eligible.some(p => p.poolId === poolId)) return result(true, "The gateway can route requests to this pool and model.", "");
      const reason = rejected.get(poolId);
      if (reason) return result(false, reason, "Check connection details and try again.");
      const listing = (await directory.pools()).find(p => p.pool_id === poolId);
      if (!listing) return result(false, "The pool is not listed in the marketplace directory.", "Check the pool listing and try again.");
      if (!listing.models.includes(modelId)) return result(false, "The pool does not advertise this model.", "Check the pool model and try again.");
      return result(false, "The pool is not listed as ready for this model in the marketplace directory.", "Check pool setup and try again.");
    },
    /** Smallest live context over the ready pools, or undefined when any pool has not reported one. */
    async contextLength(model: ModelConfig): Promise<number | undefined> {
      const hit = contexts.get(model.model_id);
      if (hit && Date.now() - hit.at < 10_000) return hit.value;
      const value = minContext(await candidates(model));
      contexts.set(model.model_id, { value, at: Date.now() });
      return value;
    },
    /** Best ready pool; `poolId` = only that pool; `exclude` = any pool but that one (P5.2 failover). */
    async select(model: ModelConfig, poolId?: string, exclude?: string, opts: SelectOptions = {}): Promise<SelectedPool | null> {
      const selected = (await candidates(model, opts)).find((p) => (!poolId || p.poolId === poolId) && p.poolId !== exclude) ?? null;
      if (selected && !selected.route) console.warn(`route unknown for ${model.model_id} in ${selected.poolId}: no valid heartbeat layer map; node shares go to reserve`);
      return selected;
    },
    /** Called only once payment preparation succeeds; released on completion/cancel/error. */
    start(poolId: string): () => void {
      active.set(poolId, (active.get(poolId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (active.get(poolId) ?? 1) - 1;
        if (left > 0) active.set(poolId, left);
        else active.delete(poolId);
      };
    },
    async network(): Promise<NetworkResponse> {
      const [pools, nodes] = await Promise.all([directory.pools(), directory.nodes()]);
      return {
        source: "gateway",
        stats: directory.stats ? await directory.stats() : [],
        nodes,
        pools: pools.map((pool) => {
          return { ...pool, reliability: poolReliability(db, cfg, pool.pool_id), load: loadOf(pool.pool_id),
            route_dispute: routeDispute(db, cfg, pool.pool_id), restarting: isRestarting(db, cfg, pool.pool_id) };
        }),
      };
    },
    async models(): Promise<ModelsResponse> {
      const catalog = await directory.models();
      const data: ModelsResponse["data"] = [];
      const seen = new Set<string>();
      for (const entry of catalog) {
        const model = cfg.model(entry.model_id);
        // Prices/layer counts remain admin configuration. Unknown catalog models cannot be served.
        if (!model || seen.has(model.model_id)) continue;
        seen.add(model.model_id);
        const pools = await candidates(model);
        if (!pools.length) continue;
        data.push({ id: model.model_id, object: "model", created: 0, owned_by: "ramx",
          model_factor: model.model_factor, pools: pools.length, source: "gateway",
          context_length: minContext(pools),
          price: pricing.quote(model) });
      }
      return { object: "list", data };
    },
  };
}
export type Router = ReturnType<typeof createRouter>;
