/**
 * `slots` inference slots per pool (MVP 1; SPEC §16.1 batching: router.max_concurrent_per_pool, and
 * Parallax batches the running requests). Highest ratio first; equal ratios retain arrival order.
 */
export function createPoolQueue(slots = 1) {
  type Waiter = { ratio: number; grant(): void };
  const pools = new Map<string, { busy: number; waiting: Waiter[] }>();
  return {
    queued(poolIds: string[]): number {
      return poolIds.reduce((n, id) => n + (pools.get(id)?.waiting.length ?? 0), 0);
    },
    isIdle(poolId: string): boolean {
      const p = pools.get(poolId);
      return !p || (p.busy === 0 && p.waiting.length === 0);
    },
    acquire(poolId: string, ratio: number, signal: AbortSignal): Promise<() => void> {
      if (signal.aborted) return Promise.reject(new DOMException("Request cancelled", "AbortError"));
      let pool = pools.get(poolId);
      if (!pool) { pool = { busy: 0, waiting: [] }; pools.set(poolId, pool); }
      const state = pool;
      return new Promise((resolve, reject) => {
        const cancel = () => {
          const index = state.waiting.indexOf(waiter);
          if (index >= 0) state.waiting.splice(index, 1);
          signal.removeEventListener("abort", cancel);
          reject(new DOMException("Request cancelled", "AbortError"));
        };
        const waiter: Waiter = { ratio, grant() {
          signal.removeEventListener("abort", cancel);
          state.busy++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            state.busy--;
            const next = state.waiting.shift();
            if (next) next.grant();
            else if (state.busy === 0) pools.delete(poolId);
          });
        } };
        if (state.busy < slots) waiter.grant();
        else {
          state.waiting.push(waiter);
          state.waiting.sort((a, b) => b.ratio - a.ratio);
          signal.addEventListener("abort", cancel, { once: true });
        }
      });
    },
  };
}
export type PoolQueue = ReturnType<typeof createPoolQueue>;
