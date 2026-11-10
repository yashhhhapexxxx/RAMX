import { useEffect, useState } from "react";
import type { LedgerType } from "@shared/types";
import { api, onFallback } from "../data";

import { useAsync } from "./useAsync";

/** Live pools, nodes and account stats (the gateway directory) via the poll / mock ticker. */
export function useNetwork() {
  const result = useAsync(() => api.network(), [], { refreshMs: 5000 });
  const extra = { error: result.error, reload: result.reload, loading: result.loading };
  return result.data ? { ...result.data, ...extra } : result.error ? { pools: [], nodes: [], stats: [], updated_at: 0, ...extra } : undefined;
}

export const useModels = () => useAsync(() => api.models(), [], { refreshMs: 15_000 });
export const useLedger = (type?: LedgerType) => useAsync(() => api.ledger({ type }), [type], { refreshMs: 10_000 });
export const usePayouts = (address: string | undefined) =>
  useAsync(() => (address ? api.payouts(address) : Promise.resolve(null)), [address], { refreshMs: 15_000 });

/** Which live calls are currently served by mock fallback (empty in mock mode). */
export function useFallbacks() {
  const [used, setUsed] = useState<string[]>([]);
  useEffect(() => onFallback(setUsed), []);
  return used;
}

/** Re-render every `ms` (for countdowns and "x s ago" labels). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** The gateway applies the same marketplace and routing checks used by model discovery. */
export function usePoolAvailability(poolId: string | undefined, model: string | undefined) {
  const key = `${poolId ?? ""}\n${model ?? ""}`;
  const result = useAsync(async () => {
    if (!poolId || !model) return { key, value: null };
    const { env } = await import("../config/env");
    const { PoolAvailability } = await import("@ramx/shared");
    const url = `${env.gatewayUrl.replace(/\/$/, "")}/pools/${encodeURIComponent(poolId)}/availability?model=${encodeURIComponent(model)}`;
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Could not check request availability. Try again.");
    return { key, value: PoolAvailability.parse(await response.json()) };
  }, [poolId, model], { refreshMs: 5000 });
  return { ...result, data: result.data?.key === key && !result.error ? result.data.value : null };
}
