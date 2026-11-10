import type { RamxConfig } from "@ramx/shared";

/**
 * Stream stall limits (post-MVP P5.1, docs/POST_MVP_PLAN.md). Parallax finds a dead node only by a
 * 30 s heartbeat timeout, and a broken stream can hang far longer. The gateway knows the normal
 * gap between tokens of each pool, so it can end a stalled stream much sooner.
 *
 *   before the first token: first_token_base_ms + first_token_ms_per_input_token × input tokens
 *   after the first token:  max(stall_min_ms, stall_p95_factor × p95 gap of the pool)
 *
 * Gaps are kept in memory only (last GAPS_KEPT per pool). No database writes.
 */
const GAPS_KEPT = 512;

export function createStallTracker(cfg: RamxConfig) {
  const gaps = new Map<string, number[]>();
  const r = cfg.resilience;
  return {
    /** Record one gap between two content chunks of a healthy stream. */
    gap(poolId: string, ms: number): void {
      let g = gaps.get(poolId);
      if (!g) { g = []; gaps.set(poolId, g); }
      g.push(ms);
      if (g.length > GAPS_KEPT) g.shift();
    },
    /** p95 gap, or null with fewer than 20 samples. */
    p95(poolId: string): number | null {
      const g = gaps.get(poolId);
      if (!g || g.length < 20) return null;
      const sorted = [...g].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    },
    stallMs(poolId: string): number {
      const p = this.p95(poolId);
      return p === null ? r.stall_min_ms : Math.max(r.stall_min_ms, Math.ceil(r.stall_p95_factor * p));
    },
    firstTokenMs(inputTokens: number): number {
      return Math.ceil(r.first_token_base_ms + r.first_token_ms_per_input_token * inputTokens);
    },
  };
}
export type StallTracker = ReturnType<typeof createStallTracker>;
