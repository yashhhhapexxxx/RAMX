/* Geometry and data for the "How it works" pinned scroll story.
   One centred SVG stage (1000 × 560): three laptops form a pool on a ring, a fourth laptop
   sends a query, and the coordinator (the gateway) splits the payment by compute (spec §8). */

export const VB_W = 1000;
export const VB_H = 560;

export const C = {
  accent: "#278cff",
  accentLt: "#a1d6ff",
  ok: "#8ecab3",
  warn: "#dfb69a",
  bad: "#ef6b6b",
  mut: "#9297a6",
  faint: "#606879",
  grid: "rgba(199,210,239,0.08)",
  line: "rgba(199,210,239,0.16)",
  text: "#f2f3f7",
  bg: "#030407",
  /* monochrome stage lines, matching the landing's black-and-white look */
  edge: "#2c2f36",
  white: "#f2f3f7",
} as const;

type Pt = [number, number];

export type StoryNode = {
  key: string;
  name: string;
  gpu: string;
  memGb: number;
  color: string;
  x: number;
  y: number;
  /** Where it slides in from (offset). */
  from: Pt;
  /** Half-open layer range in the pipeline, or null for the requester laptop. */
  layers: [number, number] | null;
};

/** Pool centre: the middle of the stage. The coordinator sits here. */
export const POD = { x: 500, y: 300, r: 195 };
export const COORD: Pt = [POD.x, POD.y];

export const MODEL = { id: "Qwen3-14B-FP8", layers: 40, gbPerLayer: 0.4 };

const onRing = (deg: number): Pt => {
  const a = (deg * Math.PI) / 180;
  return [Math.round(POD.x + Math.cos(a) * POD.r), Math.round(POD.y + Math.sin(a) * POD.r)];
};
const [mikaX, mikaY] = onRing(-90);
const [rexX, rexY] = onRing(150);
const [novaX, novaY] = onRing(30);

/** An illustrative pool (the demo hardware, spec §1.2): a triangle on the ring, in pipeline order.
    Real pools can have any number of nodes and are shown by LayerSim and /network. */
export const NODES: StoryNode[] = [
  { key: "rex", name: "Rex", gpu: "RTX 4060 · 8 GB", memGb: 8, color: "#83caff", x: rexX, y: rexY, from: [-120, 80], layers: [0, 11] },
  { key: "mika", name: "Mika", gpu: "M4 · 16 GB", memGb: 16, color: "#b4a0ed", x: mikaX, y: mikaY, from: [0, -120], layers: [11, 31] },
  { key: "nova", name: "Nova", gpu: "M5 · 16 GB", memGb: 16, color: "#dfb69a", x: novaX, y: novaY, from: [120, 80], layers: [31, 40] },
];

/** The requester laptop: arrives from the left, outside the pool, level with the coordinator. */
export const ARI: StoryNode = { key: "ari", name: "Ari", gpu: "new computer · outside the pool", memGb: 16, color: "#8ecab3", x: 112, y: POD.y, from: [-220, 0], layers: null };

export const POOLED_GB = NODES.reduce((s, n) => s + n.memGb, 0); // 40
export const TOK_S = 18.4;

/* one example request (spec §8.1): Qwen3-14B factor 1.75, 412 in / 256 out, max_tokens 2048 */
export const FACTOR = 1.75;
export const IN_TOK = 412;
export const OUT_TOK = 256;
export const HOLD = FACTOR * (2048 + 0.2 * IN_TOK); // 3,728.2
export const COST = FACTOR * (OUT_TOK + 0.2 * IN_TOK); // 592.2
export const BALANCE = 10_000;
export const BURN = COST * 0.05;
export const RESERVE = COST * 0.05;
export const layersOf = (n: StoryNode) => (n.layers ? n.layers[1] - n.layers[0] : 0);
/** The coordinator's split: 90% of the cost to the nodes, by layers served. */
export const creditsFor = (n: StoryNode) => (COST * 0.9 * layersOf(n)) / MODEL.layers;
export const MAX_CREDITS = Math.max(...NODES.map(creditsFor));

/* ── paths ─────────────────────────────────────────────────────────────── */

const quad = (a: number, c: number, b: number, u: number) => (1 - u) * (1 - u) * a + 2 * (1 - u) * u * c + u * u * b;
const lerp = (a: Pt, b: Pt, u: number): Pt => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
/** Move `from` a distance `d` towards `to`. */
const toward = (from: Pt, to: Pt, d: number): Pt => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const l = Math.hypot(dx, dy);
  return [from[0] + (dx / l) * d, from[1] + (dy / l) * d];
};

export type Curve = { a: Pt; c: Pt; b: Pt };
export const curvePath = (l: Curve) => `M${l.a[0]},${l.a[1]}Q${l.c[0]},${l.c[1]} ${l.b[0]},${l.b[1]}`;
export const curvePoint = (l: Curve, u: number): Pt => [quad(l.a[0], l.c[0], l.b[0], u), quad(l.a[1], l.c[1], l.b[1], u)];

/** One side of the triangle, bowed out towards the ring so it clears the coordinator chip. */
function edge(p: StoryNode, q: StoryNode): Curve {
  const P: Pt = [p.x, p.y];
  const Q: Pt = [q.x, q.y];
  const m = lerp(P, Q, 0.5);
  const out = toward(m, [2 * m[0] - POD.x, 2 * m[1] - POD.y], 46);
  return { a: toward(P, out, 66), c: out, b: toward(Q, out, 66) };
}

const [rex, mika, nova] = NODES;
/** Triangle sides in pipeline order: Rex → Mika → Nova, and Nova → Rex to close the ring. */
export const EDGES: Curve[] = [edge(rex, mika), edge(mika, nova), edge(nova, rex)];

/** Coordinator spokes (centre → each node), used for routing and for the payout. */
/* The top laptop's labels sit on its spoke, so that spoke stops below them. */
export const SPOKES: { a: Pt; b: Pt }[] = NODES.map((n) => ({ a: toward(COORD, [n.x, n.y], 44), b: toward([n.x, n.y], COORD, n.y < POD.y ? 110 : 58) }));
export const spokePoint = (i: number, u: number): Pt => lerp(SPOKES[i].a, SPOKES[i].b, u);

const ariOut: Pt = [ARI.x + 60, ARI.y - 6];
const coordIn: Pt = [COORD[0] - 76, COORD[1]];

/** Ari ↔ coordinator (payments use this line too). */
export const ariToCoord = (u: number): Pt => lerp(ariOut, coordIn, u);

/** One full request round trip, u in [0,1]: Ari → coordinator → Rex → Mika → Nova → coordinator → Ari. */
export function requestPoint(u: number): Pt {
  const segs: ((v: number) => Pt)[] = [
    (v) => ariToCoord(v),
    (v) => spokePoint(0, v),
    (v) => curvePoint(EDGES[0], v),
    (v) => curvePoint(EDGES[1], v),
    (v) => spokePoint(2, 1 - v),
    (v) => ariToCoord(1 - v),
  ];
  const k = Math.min(segs.length - 1, Math.floor(u * segs.length));
  return segs[k](u * segs.length - k);
}

/** Caption windows [fadeInStart, fullIn, fullOutStart, gone], same shape as the omniverse story. */
export const WINDOWS: [number, number, number, number][] = [
  [-0.02, 0.0, 0.15, 0.18],
  [0.2, 0.23, 0.35, 0.38],
  [0.4, 0.43, 0.55, 0.58],
  [0.6, 0.63, 0.77, 0.8],
  [0.82, 0.85, 1.0, 1.1],
];
