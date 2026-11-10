import { z } from "zod";
import { AccountId, EvmAddress, Hex32, LayerRange, ModelId, PoolId, Route } from "./common.ts";

/**
 * Directory records served by the gateway (GET /network, /v1/models). The gateway builds them from
 * the signed node heartbeats it receives and its own reliability scores; nothing is self-published.
 */

export const DIRECTORY_ENTITY = {
  node: "ramx.node",
  pool: "ramx.pool",
  model: "ramx.model",
  accountStats: "ramx.account_stats",
} as const;

export const DirectoryNode = z.object({
  type: z.literal(DIRECTORY_ENTITY.node),
  owner_account: AccountId,
  node_id: EvmAddress,
  pool_id: PoolId,
  gpu: z.string().min(1),
  mem_gb: z.number().positive(),
  status: z.enum(["online", "loading", "offline"]),
  layers: LayerRange.nullable(),
  tok_s: z.number().nonnegative().nullable(),
  reliability: z.number().min(0).max(1),
});
export type DirectoryNode = z.infer<typeof DirectoryNode>;

export const DirectoryPool = z.object({
  type: z.literal(DIRECTORY_ENTITY.pool),
  pool_id: PoolId,
  /** Router query: pools that list a model. MVP pools serve one model. */
  models: z.array(ModelId).min(1),
  members: z.array(EvmAddress),
  status: z.enum(["ready", "loading", "offline"]),
  /** keccak256 of the coordinator URL. The URL itself stays private. */
  coordinator_url_hash: Hex32,
  /** Null while the pool has no valid layer map (status is then not "ready"). */
  layer_map: Route.nullable(),
  /**
   * Pool reliability (SPEC §9.2): 0.7 × pool success rate + 0.3 × pool uptime, computed by the
   * gateway for the pool as one identity. Computed by the gateway.
   */
  reliability: z.number().min(0).max(1),
  context_length: z.number().int().positive().optional(),
});
export type DirectoryPool = z.infer<typeof DirectoryPool>;

export const DirectoryModel = z.object({
  type: z.literal(DIRECTORY_ENTITY.model),
  model_id: ModelId,
  mlx_variant: ModelId,
  size_gb: z.number().positive(),
  model_factor: z.number().positive(),
  license: z.string().min(1),
});
export type DirectoryModel = z.infer<typeof DirectoryModel>;

export const AccountStats = z.object({
  type: z.literal(DIRECTORY_ENTITY.accountStats),
  /** Pseudonymous: the gateway account ID, never the World nullifier. */
  account_id: AccountId,
  earned_mc: z.number().int().nonnegative(),
  spent_mc: z.number().int().nonnegative(),
  ratio: z.number().nonnegative(),
  /** Lowest reliability of the account's nodes; null if it has no nodes. */
  reliability: z.number().min(0).max(1).nullable(),
});
export type AccountStats = z.infer<typeof AccountStats>;
