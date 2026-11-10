import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { costMc, splitCost } from "../src/ledger.ts";

const cfg = loadConfig({ POOL_COORDINATOR_URL: "http://127.0.0.1:1", DATABASE_PATH: ":memory:" });
const ID = "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8";

test("Qwen3-30B-A3B catalog: 48 layers, MLX variant, factor 1.5", () => {
  const m = cfg.net.models.find((x) => x.model_id === ID)!;
  assert.ok(m);
  assert.equal(m.num_layers, 48);
  assert.equal(m.mlx_variant, "lmstudio-community/Qwen3-30B-A3B-Instruct-2507-MLX-8bit");
  // 256 out + 400 in → 1.5 × (256 + 80) = 504 credits.
  assert.equal(costMc(cfg.net, m, 400, 256), 504_000);
});

test("Qwen3-30B-A3B split over 5 nodes (4 Macs + RTX 4060) by layers; burn 5%; rounding goes to the reserve", () => {
  const m = cfg.net.models.find((x) => x.model_id === ID)!;
  const route = [
    { node_id: "0xa", layers: [0, 10] as [number, number] },
    { node_id: "0xb", layers: [10, 20] as [number, number] },
    { node_id: "0xc", layers: [20, 30] as [number, number] },
    { node_id: "0xd", layers: [30, 41] as [number, number] },
    { node_id: "0xe", layers: [41, 48] as [number, number] },
  ];
  const cost = costMc(cfg.net, m, 400, 256);
  const s = splitCost(cfg.net, cost, route, m.num_layers, (n) => `owner-${n}`, "requester");
  const nodesShare = Math.floor(cost * 0.9);
  assert.deepEqual(s.nodes, {
    "0xa": Math.floor(nodesShare * 10 / 48), "0xb": Math.floor(nodesShare * 10 / 48), "0xc": Math.floor(nodesShare * 10 / 48),
    "0xd": Math.floor(nodesShare * 11 / 48), "0xe": Math.floor(nodesShare * 7 / 48),
  });
  assert.equal(s.burn_mc, Math.floor(cost * 0.05));
  const paid = Object.values(s.nodes).reduce((a, b) => a + b, 0);
  assert.equal(paid + s.burn_mc + s.reserve_mc, cost);
  // Self-request: the requester's own node gets nothing; its share goes to the reserve.
  const self = splitCost(cfg.net, cost, route, m.num_layers, (n) => (n === "0xe" ? "requester" : `owner-${n}`), "requester");
  assert.equal(self.nodes["0xe"], 0);
  assert.equal(self.reserve_mc, s.reserve_mc + s.nodes["0xe"]!);
});
