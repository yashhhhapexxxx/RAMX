/* Figure W1 truth: the layer press line. Every number the figure shows comes from here.
   Default view = the live pool (Qwen3-14B, 40 layers): M4 16 GB [0,14), M5 16 GB [14,29), RTX 4060 8 GB [29,40),
   about 8 tok/s decode. Any edit re-divides the layers with lib/layers.ts (proportional to usable memory) and
   the decode speed becomes an estimate from per-layer times calibrated on the live pool.
   Credits use the gateway's integer rule (lib/credits.ts costMc/splitMc): 90% to the benches by layers, 5% burn,
   5% reserve; a bench owned by the requester gets 0 and its share goes to the reserve. */
import type { RouteHop } from "@shared/types";
import config from "../../../../../shared/config/ramx.config.json";
import { allocateLayers, toRoute } from "../../../lib/layers";
import { costMc, splitMc } from "../../../lib/credits";

export type Device = { gpu: string; memGb: number; msPerLayer: number };
export type Bench = Device & { id: string };

const MODEL = config.models.find((m) => m.model_id === "Qwen/Qwen3-14B-FP8") ?? config.models[config.models.length - 1];
export const MODEL_NAME = "Qwen3-14B";
export const TOTAL_LAYERS = MODEL.num_layers;
export const MODEL_GB = MODEL.size_gb;
export const FACTOR = MODEL.model_factor;
export const VEST_MIN = Math.round(config.incentives.vesting_s / 60);
export const MAX_BENCHES = 4;
export const MEM_STEPS = [8, 16, 24, 32];

/* Per-layer decode time by device (ms), and the hop between laptops. Calibrated so the live pool's route
   gives its measured ~8 tok/s: 14 × 2.6 + 15 × 2.2 + 11 × 2.0 + 2 hops × 16.8 = 125 ms a token. */
export const HOP_MS = 16.8;
export const DEVICES: Device[] = [
  { gpu: "M4", memGb: 16, msPerLayer: 2.6 },
  { gpu: "M5", memGb: 16, msPerLayer: 2.2 },
  { gpu: "RTX 4060", memGb: 8, msPerLayer: 2.0 },
];
export const LIVE_BENCHES: Bench[] = DEVICES.map((d, i) => ({ ...d, id: `bench-${i}` }));
export const LIVE_ROUTE: RouteHop[] = [
  { node_id: "bench-0", layers: [0, 14] },
  { node_id: "bench-1", layers: [14, 29] },
  { node_id: "bench-2", layers: [29, 40] },
];
export const LIVE_TOK_S = 8;

/* The request the line runs: a short prompt and answer. */
export const REQUEST = { inTokens: 120, outTokens: 200 };

export type Line = {
  benches: Bench[];
  route: RouteHop[] | null;
  live: boolean;
  tokS: number | null;
  costMc: number;
  nodesMc: number[];
  burnMc: number;
  reserveMc: number;
  self: number | null;
};

/** The line for a set of benches. `live` keeps the live pool's own route and its measured speed. */
export function lineOf(benches: Bench[], live: boolean, self: number | null = null): Line {
  const route = live ? LIVE_ROUTE : (() => {
    const counts = allocateLayers(benches.map((b) => b.memGb), TOTAL_LAYERS, MODEL_GB);
    return counts ? toRoute(benches.map((b) => b.id), counts) : null;
  })();
  const total = costMc(FACTOR, REQUEST.inTokens, REQUEST.outTokens);
  const selfId = self === null ? null : benches[self]?.id;
  const split = splitMc(total, route, TOTAL_LAYERS, (id) => id === selfId);
  const nodesMc = benches.map((b) => split.nodes.find((n) => n.node_id === b.id)?.mc ?? 0);
  return { benches, route, live, tokS: route ? (live ? LIVE_TOK_S : tokSOf(benches, route)) : null, costMc: total, nodesMc, burnMc: split.burn_mc, reserveMc: split.reserve_mc, self };
}

export function layersOf(line: Line, index: number) {
  const hop = line.route?.find((h) => h.node_id === line.benches[index].id);
  return hop ? hop.layers[1] - hop.layers[0] : 0;
}

export function tokSOf(benches: Bench[], route: RouteHop[]) {
  const ms = route.reduce((sum, h) => sum + (h.layers[1] - h.layers[0]) * (benches.find((b) => b.id === h.node_id)?.msPerLayer ?? 2.4), 0) + (route.length - 1) * HOP_MS;
  return 1000 / ms;
}

/* Coins: one coin per layer served stands for 1/40 of the nodes' 90%; burn and reserve drop 2 coins each (≈5%).
   A self-request bench drops its coins into the reserve instead. */
export function coinsOf(line: Line) {
  const perBench = line.benches.map((_, i) => (line.self === i ? 0 : layersOf(line, i)));
  const toReserve = line.self === null ? 0 : layersOf(line, line.self);
  return { perBench, burn: 2, reserve: 2 + toReserve };
}

export const credits = (mc: number) => (mc / 1000).toFixed(1);

/* Slow-motion factor: the shuttle takes `shownMs` to cross the line; the real pass takes 1000 / tok/s ms. */
export const slowBy = (tokS: number, shownMs: number) => Math.round(shownMs / (1000 / tokS));
