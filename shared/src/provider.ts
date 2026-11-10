import { z } from "zod";
import { EvmAddress, PoolId, NearAccountId } from "./common.ts";

export const ProviderStage = z.enum(["waiting", "installing", "downloading", "prepared", "starting", "online", "error", "stopped"]);
export const ProviderCreate = z.object({ name: z.string().trim().min(1).max(60), model: z.string().min(1), expected_members: z.number().int().min(2).max(16), payout_address: NearAccountId });
export const ProviderJoin = z.object({ pool_id: PoolId, payout_address: NearAccountId });
export const ProviderMember = z.object({
  id: z.string(), account_id: z.string(), role: z.enum(["coordinator", "member"]), approved: z.boolean(),
  node_id: EvmAddress.nullable(), stage: ProviderStage, message: z.string(), gpu: z.string().nullable(),
  mem_gb: z.number().nullable(), bytes_done: z.number().nonnegative(), bytes_total: z.number().nonnegative(),
  last_seen: z.number().nullable(), online: z.boolean(),
});
export const ProviderPool = z.object({
  pool_id: PoolId, name: z.string(), model: z.string(), expected_members: z.number(), owner_account: z.string(),
  state: z.enum(["preparing", "starting", "ready", "stopped"]), generation: z.number(),
  coordinator_connected: z.boolean(), members: z.array(ProviderMember),
});
export const ProviderOverview = z.object({
  models: z.array(z.object({ model_id: z.string(), mlx_variant: z.string().nullable(), size_gb: z.number(), num_layers: z.number() })),
  pools: z.array(ProviderPool),
});
export const ProviderEnrollment = z.object({ command: z.string(), expires_at: z.number(), member_id: z.string() });
export const ProviderProgress = z.object({
  stage: ProviderStage, message: z.string().max(240).default(""), ip: z.ipv4().optional(), gpu: z.string().max(120).optional(),
  mem_gb: z.number().positive().max(10000).optional(), bytes_done: z.number().int().nonnegative().max(1e15).default(0),
  bytes_total: z.number().int().nonnegative().max(1e15).default(0),
});
export const ProviderFile = z.object({ size: z.number().int().nonnegative().max(1e13), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const ProviderModelSnapshot = z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/), files: z.record(z.string(), ProviderFile) });
export const ProviderSnapshots = z.record(z.string(), ProviderModelSnapshot);
export const ProviderJob = z.object({ id: z.string(), path: z.enum(["/v1/chat/completions", "/cluster/status_json"]), body: z.unknown().nullable() });
export type ProviderPool = z.infer<typeof ProviderPool>;
export type ProviderMember = z.infer<typeof ProviderMember>;
