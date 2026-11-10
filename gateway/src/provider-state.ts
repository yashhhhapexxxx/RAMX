import type { Db } from "./db.ts";

export type ProviderPoolRow = { pool_id: string; owner_account: string; name: string; model: string; expected_members: number;
  state: "preparing" | "starting" | "ready" | "stopped"; generation: number; dht_prefix: string; lan_secret: string;
  snapshots: string | null; scheduler_addr: string | null; start_at: number | null; created_at: number };
export type ProviderMemberRow = { id: string; pool_id: string; account_id: string; role: "coordinator" | "member";
  approved: number; revoked: number; node_id: string | null; payout_address: string; token_hash: string | null;
  token_expires_at: number | null; stage: string; message: string; ip: string | null; gpu: string | null; mem_gb: number | null;
  bytes_done: number; bytes_total: number; last_seen: number | null };
export const providerPool = (db: Db, id: string) => db.prepare("SELECT * FROM provider_pools WHERE pool_id = ?").get(id) as ProviderPoolRow | undefined;
export const providerMembers = (db: Db, id: string) => db.prepare("SELECT * FROM provider_members WHERE pool_id = ? AND revoked = 0 ORDER BY role, id").all(id) as ProviderMemberRow[];
export const providerUrl = (id: string) => `provider://${id}`;
export const providerCoordinator = (db: Db, id: string): string | null => providerPool(db, id) ? providerUrl(id) : null;
export function providerConnected(db: Db, id: string, now = Date.now()): boolean {
  const coordinator = providerMembers(db, id).find(m => m.role === "coordinator" && m.approved);
  return !!coordinator?.token_hash && !!coordinator.last_seen && coordinator.last_seen > now - 30_000;
}
export function providerAvailable(db: Db, id: string): boolean {
  return providerPool(db, id)?.state === "ready" && providerConnected(db, id);
}
