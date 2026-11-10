/* Layer placement for the simulator (illustrative). Parallax does the real placement inside a pool;
   the gateway only checks that the reported ranges cover [0, num_layers) exactly once (SPEC §5.5). */
import type { RouteHop } from "@shared/types";

/** Memory a laptop keeps for the OS and KV cache before it takes layers (rough, for the sim). */
export const RESERVED_GB = 2;

/** Layers per node, proportional to usable memory, never more than a node can hold.
    Returns null when the pool cannot hold the model. Sums to `totalLayers` exactly. */
export function allocateLayers(memGb: number[], totalLayers: number, modelGb: number): number[] | null {
  if (memGb.length === 0 || totalLayers <= 0) return null;
  const gbPerLayer = modelGb / totalLayers;
  const usable = memGb.map((m) => Math.max(0, m - RESERVED_GB));
  const capacity = usable.map((u) => Math.floor(u / gbPerLayer));
  if (capacity.reduce((a, b) => a + b, 0) < totalLayers) return null;
  const total = usable.reduce((a, b) => a + b, 0);
  const exact = usable.map((u) => (u / total) * totalLayers);
  const out = exact.map((x, i) => Math.min(capacity[i], Math.floor(x)));
  // Hand out the rest by largest remainder, skipping full nodes.
  let left = totalLayers - out.reduce((a, b) => a + b, 0);
  while (left > 0) {
    let best = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i] >= capacity[i]) continue;
      if (best < 0 || exact[i] - out[i] > exact[best] - out[best]) best = i;
    }
    if (best < 0) return null;
    out[best]++;
    left--;
  }
  return out;
}

/** Counts → half-open pipeline stages in node order. Nodes with 0 layers are left out. */
export function toRoute(ids: string[], counts: number[]): RouteHop[] {
  let at = 0;
  const route: RouteHop[] = [];
  counts.forEach((c, i) => {
    if (c <= 0) return;
    route.push({ node_id: ids[i], layers: [at, at + c] });
    at += c;
  });
  return route;
}

/** True when the ranges cover [0, totalLayers) exactly once (the gateway's validity rule). */
export function coversExactly(route: RouteHop[], totalLayers: number) {
  const sorted = [...route].sort((a, b) => a.layers[0] - b.layers[0]);
  let at = 0;
  for (const h of sorted) {
    if (h.layers[0] !== at || h.layers[1] <= h.layers[0]) return false;
    at = h.layers[1];
  }
  return at === totalLayers;
}

/* ───────────── Parallax placement (port of Parallax 162354a, scheduling/layer_allocation.py) ─────────────
   1. Capacity: a node holds floor((memory × param_mem_ratio − embedding/LM head on the end stages) / layer size)
      decoder layers (scheduling/node.py get_decoder_layer_capacity). Memory = unified RAM on a Mac, VRAM on NVIDIA.
   2. Pipelines: the DP allocator picks k full pipelines (copies of the model) and the fewest total stages,
      maximising k² / stages. Laptops it does not need stay on standby (no layers).
   3. Inside a pipeline: nodes sorted by capacity (largest first); layers split in proportion to compute
      (TFLOPS) by water-filling, capped by capacity; the first stage holds the embedding, the last the LM head.
   The website onboarding adds two rules on top (pool/provider/helper.py, pool/hooks):
   - param_mem_ratio 0.37 on Macs for the tested "Qwen3-14B × 3 members" profile (default 0.65);
   - same-memory pools: capacity capped at ceil(layers / members), so every member gets an equal share. */

/** Chips as Parallax rates them (fp16 TFLOPS, parallax/server/server_info.py). Unknown NVIDIA GPUs get 50. */
export const CHIPS: { id: string; label: string; tflops: number; backend: "mlx" | "cuda" }[] = [
  { id: "M1", label: "Apple M1", tflops: 4.58, backend: "mlx" },
  { id: "M2", label: "Apple M2", tflops: 7.1, backend: "mlx" },
  { id: "M3", label: "Apple M3", tflops: 7.1, backend: "mlx" },
  { id: "M4", label: "Apple M4", tflops: 8.52, backend: "mlx" },
  { id: "M4 Pro", label: "Apple M4 Pro", tflops: 17.04, backend: "mlx" },
  { id: "M5", label: "Apple M5", tflops: 9.37, backend: "mlx" },
  { id: "M5 Pro", label: "Apple M5 Pro", tflops: 18.74, backend: "mlx" },
  { id: "RTX", label: "NVIDIA RTX (e.g. 4060)", tflops: 50, backend: "cuda" },
];

/** Parallax's own size estimates (GiB) for the catalog models: one decoder layer, and the embedding / LM head. */
const PARALLAX_SIZES: Record<string, { layerGiB: number; embedGiB: number }> = {
  "Qwen/Qwen3-8B-FP8": { layerGiB: 0.1797, embedGiB: 1.1592 },
  "Qwen/Qwen3-14B-FP8": { layerGiB: 0.3076, embedGiB: 1.449 },
  "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8": { layerGiB: 0.5801, embedGiB: 0.5796 },
};

export type PlacementNode = { id: string; memGb: number; chip: string };
export type Placement = { pipelines: RouteHop[][]; standby: string[]; equalSplit: boolean; paramMemRatio: number };

export function parallaxPlacement(nodes: PlacementNode[], model: { model_id: string; num_layers: number; size_gb: number }): Placement | null {
  const L = model.num_layers;
  const sizes = PARALLAX_SIZES[model.model_id] ?? { layerGiB: (model.size_gb * 0.93) / L, embedGiB: 0.5 };
  const chip = (id: string) => CHIPS.find((c) => c.id === id) ?? CHIPS[CHIPS.length - 1];
  const n = nodes.length;
  if (n === 0 || L <= 0) return null;
  const allMlx = nodes.every((x) => chip(x.chip).backend === "mlx");
  const profile14 = model.model_id === "Qwen/Qwen3-14B-FP8" && n === 3;
  const mems = nodes.map((x) => x.memGb);
  const equalSplit = n >= 2 && Math.max(...mems) - Math.min(...mems) <= 0.5;
  const share = Math.ceil(L / n);
  const ratioOf = (x: PlacementNode) => (profile14 && chip(x.chip).backend === "mlx" ? 0.37 : 0.65);
  // NVIDIA laptops report a little less VRAM than the label (an 8 GB RTX 4060 reports 7.6 GiB).
  const memOf = (x: PlacementNode) => (chip(x.chip).backend === "cuda" ? x.memGb * 0.95 : x.memGb);
  const cap = (i: number, embed = false, head = false) => {
    const bytes = memOf(nodes[i]) * ratioOf(nodes[i]) - (embed ? sizes.embedGiB : 0) - (head ? sizes.embedGiB : 0);
    const c = Math.floor(bytes / sizes.layerGiB + 1e-9);
    return equalSplit ? Math.min(c, share) : c;
  };
  const caps = nodes.map((_, i) => cap(i));
  const totalCap = caps.reduce((a, b) => a + b, 0);
  if (totalCap < L) return null;

  // 2. DP over nodes in join order (allocate_from_standby): open = remaining layers of open pipelines.
  const suffix = Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + caps[i];
  type Act = { kind: "skip" } | { kind: "assign"; j: number; close: boolean } | { kind: "start"; close: boolean };
  let best: { k: number; score: number; plan: number[][] } | null = null;
  for (let k = 1; k <= Math.min(n, Math.floor(totalCap / L)); k++) {
    const memo = new Map<string, { cost: number; act: Act }>();
    const dp = (i: number, open: number[], done: number): number => {
      if (done === k && open.length === 0) return 0;
      if (i === n) return Infinity;
      const key = `${i}|${open.join(",")}|${done}`;
      const hit = memo.get(key);
      if (hit) return hit.cost;
      const newNeeded = k - done - open.length;
      if (newNeeded < 0 || suffix[i] < open.reduce((a, b) => a + b, 0) + Math.max(0, newNeeded) * L || done + open.length + (n - i) < k) {
        memo.set(key, { cost: Infinity, act: { kind: "skip" } });
        return Infinity;
      }
      let bestCost = dp(i + 1, open, done);
      let act: Act = { kind: "skip" };
      open.forEach((rj, j) => {
        const after = rj - caps[i];
        if (after <= 0) {
          const afterClose = rj - cap(i, false, true);
          const next = [...open];
          if (afterClose <= 0) {
            next.splice(j, 1);
            const c = 1 + dp(i + 1, next, done + 1);
            if (c < bestCost) [bestCost, act] = [c, { kind: "assign", j, close: true }];
          } else {
            next[j] = afterClose;
            next.sort((a, b) => a - b);
            const c = 1 + dp(i + 1, next, done);
            if (c < bestCost) [bestCost, act] = [c, { kind: "assign", j, close: false }];
          }
        } else {
          const next = [...open];
          next[j] = after;
          next.sort((a, b) => a - b);
          const c = 1 + dp(i + 1, next, done);
          if (c < bestCost) [bestCost, act] = [c, { kind: "assign", j, close: false }];
        }
      });
      if (newNeeded > 0) {
        const r = L - cap(i, true);
        if (r <= 0) {
          const c = 1 + dp(i + 1, open, done + 1);
          if (c < bestCost) [bestCost, act] = [c, { kind: "start", close: true }];
        } else {
          const c = 1 + dp(i + 1, [...open, r].sort((a, b) => a - b), done);
          if (c < bestCost) [bestCost, act] = [c, { kind: "start", close: false }];
        }
      }
      memo.set(key, { cost: bestCost, act });
      return bestCost;
    };
    const stages = dp(0, [], 0);
    if (!Number.isFinite(stages)) continue;
    const score = (k * k) / stages;
    if (best && score <= best.score) continue;
    // Backtrack: follow the stored actions, tracking which open pipeline (by residual) each node joined.
    const plan: number[][] = [];
    let open: { r: number; nodes: number[] }[] = [];
    let done = 0;
    for (let i = 0; i < n; i++) {
      const key = `${i}|${open.map((o) => o.r).join(",")}|${done}`;
      const act = memo.get(key)?.act;
      if (!act) break;
      if (act.kind === "assign") {
        const o = open[act.j];
        o.nodes.push(i);
        if (act.close) { plan.push(o.nodes); open.splice(act.j, 1); done++; }
        else o.r = o.r - caps[i] <= 0 ? o.r - cap(i, false, true) : o.r - caps[i];
      } else if (act.kind === "start") {
        if (act.close) { plan.push([i]); done++; }
        else open.push({ r: L - cap(i, true), nodes: [i] });
      }
      open = open.sort((a, b) => a.r - b.r);
    }
    best = { k, score, plan };
  }
  if (!best) return null;

  // 3. Water-filling inside each pipeline (adjust_pipeline_layers).
  const pipelines = best.plan.map((members) => {
    const order = [...members].sort((a, b) => caps[b] - caps[a]); // stable: ties keep join order
    const m = order.length;
    const c = order.map((i, s) => cap(i, s === 0, s === m - 1 && m > 1));
    const power = order.map((i) => chip(nodes[i].chip).tflops);
    const at = (lam: number) => c.reduce((a, ci, s) => a + Math.min(ci, lam * power[s]), 0);
    let lo = 0, hi = Math.max(...c.map((ci, s) => ci / power[s]));
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (at(mid) >= L) hi = mid; else lo = mid; }
    const target = c.map((ci, s) => Math.min(ci, hi * power[s]));
    const counts = target.map((t, s) => Math.min(c[s], Math.floor(t)));
    let left = L - counts.reduce((a, b) => a + b, 0);
    const byFrac = target.map((t, s) => ({ f: t - counts[s], s })).sort((a, b) => b.f - a.f || a.s - b.s);
    for (const { s } of byFrac) { if (left <= 0) break; if (c[s] - counts[s] > 0) { counts[s]++; left--; } }
    let start = 0;
    const route: RouteHop[] = [];
    order.forEach((i, s) => { if (counts[s] > 0) { route.push({ node_id: nodes[i].id, layers: [start, start + counts[s]] }); start += counts[s]; } });
    return route;
  });
  const used = new Set(pipelines.flat().map((h) => h.node_id));
  return { pipelines, standby: nodes.filter((x) => !used.has(x.id)).map((x) => x.id), equalSplit, paramMemRatio: profile14 && allMlx ? 0.37 : 0.65 };
}

/** Weights a stage holds, in GiB, by Parallax's estimate (decoder layers, plus embedding / LM head on the ends). */
export function stageGiB(modelId: string, sizeGb: number, totalLayers: number, hop: RouteHop): number {
  const sizes = PARALLAX_SIZES[modelId] ?? { layerGiB: (sizeGb * 0.93) / totalLayers, embedGiB: 0.5 };
  const n = hop.layers[1] - hop.layers[0];
  return n * sizes.layerGiB + (hop.layers[0] === 0 ? sizes.embedGiB : 0) + (hop.layers[1] === totalLayers ? sizes.embedGiB : 0);
}
