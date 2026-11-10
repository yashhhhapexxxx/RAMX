/* Figure H1, "the card on the turntable": an RTX 4060 lying fans-up on a machined turntable,
   built with the Anatomy kit's 3D turn mode. Run with Node:
     node scripts/anatomy/gpu-hero.mjs            writes src/components/anatomy/gpu/stage.gen.json
     node scripts/anatomy/gpu-hero.mjs --audit    kit audit + orbit audit (slow; add --quick)
   World units are millimetres of the real card. The page data is generated, never hand-edited. */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as G from "./kit/lathe.mjs";
import * as A from "./kit/audit.mjs";
import { turning } from "./kit/turn-build.mjs";
import * as TA from "./kit/turn-audit.mjs";
import { glCamera } from "./kit/gl.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../../src/components/anatomy/gpu/stage.gen.json");
const argv = process.argv.slice(2);

export const W = 640;
export const H = 440;
const AZIMUTH = 38;
const ELEVATION = 30;

/* ── layout (mm) ── */
const PLINTH_R = 122;
const PLINTH_Z = [-12, 0];
const PLATTER_R = 108;
const PLATTER_Z = [0, 6];
const FOOT_Z = [6, 9.8];
const BACK_Z = [9.8, 11.6];
const PCB_Z = [11.6, 13.2];
const PCB = { x: -118, y: -50, w: 206, d: 100, r: 2 };
const BACKPLATE = { x: -118, y: -50, w: 230, d: 100, r: 3 };
const DIE_C = [-16, -4];
const BOARD_TOP = 15;
const COLD_Z = [BOARD_TOP, 18];
const PIPE_R = 3;
const PIPE_Z = COLD_Z[1] + PIPE_R;
const FIN_Z = [PIPE_Z + PIPE_R, 40];
const SHROUD_TOP = 44;
const FAN_R = 39;
const FANS = [[-56, -3], [56, -3]];
export const LIFT = 56;
const BENCH = { x: -140, y: -140, w: 280, d: 280, r: 26 };
const BENCH_Z = [-22, -12];

export const P = k.fitProjection(
  [...k.boxCorners(BENCH, BENCH_Z[0] - 5, BENCH_Z[1]), ...Array.from({ length: 48 }, (_, i) => [128 * Math.cos((i / 48) * Math.PI * 2), 128 * Math.sin((i / 48) * Math.PI * 2), SHROUD_TOP + LIFT + 2])],
  W,
  H,
  { pad: 10, azimuth: AZIMUTH, elevation: ELEVATION },
);
const at = (p) => k.iso(p, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const VERT = (x, y) => G.frameOf([x, y, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]);
const UP = { o: [0, 0, 0], a: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] };
const frameOf = (o, a, u) => {
  const axis = G.unit3(a);
  const uu = G.unit3(G.sub3(u, G.mul3(axis, G.dot3(u, axis))));
  return { o, a: axis, u: uu, v: G.cross3(axis, uu) };
};
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));

export const R = A.recorder(P);
const put = (item) => R.put({ ...item, shapes: item.shapes.map((shape, index) => R.solid(Object.assign(shape, { name: shape.name ?? (index ? `${item.name}#${index + 1}` : item.name) }))) });

/* ── static ground: bench plate on feet, plinth with a degree ring, index, ruler, label plate ── */
function ground() {
  for (const [x, y] of byDepth(k.corners(BENCH, 26))) {
    const svg = S(k.cylinder(x, y, 9, BENCH_Z[0] - 5, 1.8, P, 28), { tone: "lo" }) + S(k.cylinder(x, y, 7, BENCH_Z[0] - 3.2, 3.2, P, 28), { tone: "mid" });
    put({ name: `bench.foot.${x}.${y}`, layer: "back", at: [x, y, BENCH_Z[0] - 5], svg, shapes: [A.cylinder(x, y, 9, BENCH_Z[0] - 5, 1.8, { ground: true }), A.cylinder(x, y, 7, BENCH_Z[0] - 3.2, 3.2)] });
  }
  const screws = k.corners(BENCH, 9);
  const benchSvg =
    S(k.slabOf(BENCH, BENCH_Z[0], BENCH_Z[1] - BENCH_Z[0], P, 8, 1.6), { tone: "mid", inner: L(k.sideSeam(BENCH, BENCH_Z[0] + 3.4, P, 8), { tone: "faint" }) }) +
    L(k.planOutline(k.insetPlan(BENCH, 5), BENCH_Z[1], P), { tone: "faint" }) +
    L(screws.map(([x, y]) => k.ring(x, y, 2.6, BENCH_Z[1], P, 16)).join(""), { tone: "lo" }) +
    D(screws.map(([x, y]) => at([x, y, BENCH_Z[1]])), { size: 0.55 });
  put({ name: "bench.plate", layer: "back", at: [0, 0, BENCH_Z[0]], bias: 4, svg: benchSvg, shapes: [A.slab(BENCH, BENCH_Z[0], BENCH_Z[1] - BENCH_Z[0], { ground: true })] });

  // ruler strip along the front-right edge, ticks hanging from its outer edge
  const strip = { x: -96, y: BENCH.y + BENCH.d - 15, w: 192, d: 8, r: 1 };
  const t = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 5, 5, strip.y + strip.d - 0.8, BENCH_Z[1] + 0.6, [2.2, 4], P);
  const rulerSvg = S(k.slabOf(strip, BENCH_Z[1], 0.6, P, 3), { tone: "lo", crease: "none" }) + L(t.minor, { tone: "lo" }) + L(t.major, { tone: "mid" });
  put({ name: "bench.ruler", layer: "back", at: [0, strip.y, BENCH_Z[1]], svg: rulerSvg, shapes: [A.slab(strip, BENCH_Z[1], 0.6)] });

  // label plate on the front-left: three rule lines stand for engraved text
  const plate = { x: BENCH.x + 10, y: 88, w: 10, d: 30, r: 1.2 };
  const pz = BENCH_Z[1] + 0.8;
  const plateSvg =
    S(k.slabOf(plate, BENCH_Z[1], 0.8, P, 4), { tone: "lo" }) +
    L(k.planOutline(k.insetPlan(plate, 1.6), pz, P), { tone: "faint" }) +
    L(k.lineOnTop([plate.x + 3.4, plate.y + 5], [plate.x + 3.4, plate.y + 24], pz, P), { tone: "lo", free: true }) +
    L(k.lineOnTop([plate.x + 5.4, plate.y + 5], [plate.x + 5.4, plate.y + 17], pz, P), { tone: "lo", free: true }) +
    L(k.lineOnTop([plate.x + 7.2, plate.y + 5], [plate.x + 7.2, plate.y + 20], pz, P), { tone: "faint", free: true }) +
    D([at([plate.x + 5, plate.y + 3, pz]), at([plate.x + 5, plate.y + plate.d - 3, pz])], { size: 0.5 });
  put({ name: "bench.label", layer: "back", at: [plate.x + 5, plate.y + 15, BENCH_Z[1]], svg: plateSvg, shapes: [A.slab(plate, BENCH_Z[1], 0.8)] });

  // a parts tray in the right corner: a shallow dish with four spare bracket screws
  const tray = { x: 92, y: -132, w: 38, d: 24, r: 3 };
  const tz = BENCH_Z[1] + 3;
  const screws4 = [[100, -124], [108, -118], [118, -125], [122, -114]];
  let traySvg = S(k.slabOf(tray, BENCH_Z[1], 3, P, 6, 0.6), { tone: "mid", inner: L(k.planOutline(k.insetPlan(tray, 2), tz, P), { tone: "lo" }) });
  for (const [x, y] of byDepth(screws4)) traySvg += S(k.cylinder(x, y, 2.2, tz - 1.2, 2, P, 20), { tone: "hi" }) + L(k.lineOnTop([x - 1.2, y], [x + 1.2, y], tz + 0.8, P), { tone: "lo" });
  put({ name: "bench.tray", layer: "back", at: [111, -120, BENCH_Z[1]], svg: traySvg, shapes: [A.slab(tray, BENCH_Z[1], 3)] });

  // the plinth: a turned base under the platter, knurled band, degree ring on its rim
  const plinth =
    S(k.cylinder(0, 0, PLINTH_R, PLINTH_Z[0], PLINTH_Z[1] - PLINTH_Z[0], P, 96, 1.2), { tone: "mid", crease: "lo", inner: L(k.sideArc(0, 0, PLINTH_R, PLINTH_Z[0] + 4.2, P, 60) + k.sideArc(0, 0, PLINTH_R, PLINTH_Z[1] - 1.2, P, 60), { tone: "faint" }) }) +
    L(k.knurl(0, 0, PLINTH_R, PLINTH_Z[0] + 4.2, PLINTH_Z[1] - 1.2, 180, P, 0.3), { tone: "lo" });
  const ticks = k.radialTicks(0, 0, PLINTH_R - 1.2, 72, 6, PLINTH_Z[1], [2.4, 4.4], P);
  const ringSvg = L(k.ring(0, 0, PLINTH_R - 1.2, PLINTH_Z[1], P, 160) + k.ring(0, 0, PLINTH_R - 5.6, PLINTH_Z[1], P, 160), { tone: "faint" }) + L(ticks.minor, { tone: "lo" }) + L(ticks.major, { tone: "mid" });
  put({ name: "stand.plinth", layer: "back", at: [0, 0, PLINTH_Z[0]], bias: 2, svg: `<path class="iso-halo" d="${k.haloOf({ x: -PLINTH_R, y: -PLINTH_R, w: 2 * PLINTH_R, d: 2 * PLINTH_R, r: PLINTH_R }, BENCH_Z[1], 0.1, P)}" style="filter:blur(6px)"/>${plinth}${ringSvg}`, shapes: [A.cylinder(0, 0, PLINTH_R, PLINTH_Z[0], PLINTH_Z[1] - PLINTH_Z[0])] });

  // brass index on the bench, pointing at the plinth's degree ring from the viewer's side
  const a = (AZIMUTH * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const toWorld = (pts) => pts.map(([r, tt]) => [c * r - s * tt, s * r + c * tt]);
  const block = toWorld([[PLINTH_R + 2, -7], [PLINTH_R + 14, -7], [PLINTH_R + 14, 7], [PLINTH_R + 2, 7]]);
  const wedge = toWorld([[PLINTH_R + 0.6, -0.8], [PLINTH_R + 0.6, 0.8], [PLINTH_R + 9, 3.6], [PLINTH_R + 9, -3.6]]);
  const bz = BENCH_Z[1];
  const svg = S(k.extrude(block, bz, 6, P, { bevel: 0.5 }), { tone: "mid" }) + D(toWorld([[PLINTH_R + 11.5, -4.5], [PLINTH_R + 11.5, 4.5]]).map(([x, y]) => at([x, y, bz + 6])), { size: 0.5 }) + `<g data-mat="brass">${S(k.extrude(wedge, bz + 6, 1.4, P, { bevel: 0.3 }), { tone: "hi" })}</g>`;
  put({ name: "stand.index", layer: "back", at: [c * (PLINTH_R + 8), s * (PLINTH_R + 8), bz], svg, shapes: [A.extruded(block, bz, 6), A.extruded(wedge, bz + 6, 1.4)] });
}

/* ── the 3D scene ── */
export const T = turning(P, { recorder: R });
const table = T.group("table", { turn: { pivot: [0, 0] } });
const cooler = T.group("cooler", { parent: table, slide: { direction: [0, 0, 1], travel: LIFT } });
const fanA = T.group("fanA", { parent: cooler, turn: { pivot: FANS[0] } });
const fanB = T.group("fanB", { parent: cooler, turn: { pivot: FANS[1] } });
const board = T.layer("board");
const top = T.layer("cooler");
T.stack(["back", "board", "glow", "cooler"]);

/* One figure value per motion: turn (deg), lift (0..1), spin (deg). Fans counter-rotate, as on many dual-fan cards. */
export const follow = (values) => ({ ...values, table: values.table ?? 0, cooler: LIFT * (values.lift ?? 0), fanA: values.spin ?? 0, fanB: -(values.spin ?? 0) });
export const poses = () => {
  const out = [];
  for (let deg = 0; deg < 360; deg += 1.5) out.push(follow({ table: deg, lift: ((deg / 1.5) % 5) / 4, spin: (deg * 7.3) % 360 }));
  for (let i = 0; i <= 40; i++) out.push(follow({ table: 37 + i * 2, lift: i / 40, spin: i * 11 }));
  return out;
};

const B = { group: table, layer: board };
const pr = (name, plan, z0, z1, extra = {}) => T.prism({ name, ...B, plan, z: z0, h: z1 - z0, steps: extra.steps ?? 2, tone: "mid", ...extra });

/* platter: a turned steel disc with a knurled rim and a degree ring on its face */
const platter = T.round({ name: "table.platter", ...B, F: VERT(0, 0), s0: PLATTER_Z[0], s1: PLATTER_Z[1], r: PLATTER_R, tone: "hi", crease: "lo", material: "steel", details: { ribs: { s0: PLATTER_Z[0] + 1, s1: PLATTER_Z[1] - 1, count: 120, fade: [0.08, 0.5], seams: true, tone: "lo" } } });
{
  const ring = (r, n) => Array.from({ length: n }, (_, j) => `${j ? "L" : "M"}${(r * Math.cos((j / n) * Math.PI * 2)).toFixed(3)} ${(r * Math.sin((j / n) * Math.PI * 2)).toFixed(3)}`).join("") + "Z";
  const tick = (ang, a0, a1) => `M${(Math.cos(ang) * a0).toFixed(3)} ${(Math.sin(ang) * a0).toFixed(3)}L${(Math.cos(ang) * a1).toFixed(3)} ${(Math.sin(ang) * a1).toFixed(3)}`;
  const minor = [];
  const major = [];
  for (let i = 0; i < 120; i++) (i % 10 ? minor : major).push(tick((i / 120) * Math.PI * 2, PLATTER_R - 4 - (i % 10 ? 2 : 4), PLATTER_R - 4));
  const svg = `<path class="iso-line" data-tone="lo" d="${ring(PLATTER_R - 4, 200)}"/><path class="iso-line" data-tone="lo" d="${minor.join("")}"/><path class="iso-line" data-tone="mid" d="${major.join("")}"/><path class="iso-line" data-tone="faint" d="${ring(PLATTER_R - 14, 200)}"/>`;
  T.plane({ part: platter, o: [0, 0, PLATTER_Z[1]], u: [1, 0, 0], v: [0, 1, 0], svg, fade: [0.04, 0.3] });
}

/* rubber feet under the backplate */
for (const [x, y] of k.corners(BACKPLATE, 14)) T.round({ name: `card.foot.${x}.${y}`, ...B, F: VERT(x, y), s0: FOOT_Z[0], s1: FOOT_Z[1], r: 5, tone: "mid", material: "rubber" });

/* backplate with screws and a vent row */
{
  const screws = [...k.corners(BACKPLATE, 6), [DIE_C[0] - 24, DIE_C[1] - 24], [DIE_C[0] + 24, DIE_C[1] - 24], [DIE_C[0] - 24, DIE_C[1] + 24], [DIE_C[0] + 24, DIE_C[1] + 24]];
  void screws;
  pr("card.backplate", BACKPLATE, BACK_Z[0], BACK_Z[1], { tone: "mid", bevel: 0.4, material: "gunmetal", details: { dots: [-30, 0, 30].map((y) => ({ at: [BACK_Z[0] + 0.9, BACKPLATE.x + BACKPLATE.w, y], normal: [1, 0, 0], size: 0.45 })) } });
}

/* the PCB, its edge connector tab (with the key notch) and gold fingers */
const SMD = [];
for (let i = 0; i < 9; i++) for (let j = 0; j < 2; j++) SMD.push([DIE_C[0] - 26 + i * 6.5, DIE_C[1] + (j ? 26 : -26)]);
for (let i = 0; i < 12; i++) SMD.push([20 + i * 5, 34], [20 + i * 5, -36]);
const pcbDots = [
  ...[[-112, -44], [-112, 44], [82, -44], [82, 44], [DIE_C[0] - 22, DIE_C[1] - 22], [DIE_C[0] + 22, DIE_C[1] - 22], [DIE_C[0] - 22, DIE_C[1] + 22], [DIE_C[0] + 22, DIE_C[1] + 22]].map(([x, y]) => ({ at: [PCB_Z[1], x, y], normal: [0, 0, 1], size: 0.6, tone: "hi" })),
  ...SMD.map(([x, y]) => ({ at: [PCB_Z[1], x, y], normal: [0, 0, 1], size: 0.38, tone: "lo" })),
];
const pcbRings = [[-112, -44], [-112, 44], [82, -44], [82, 44], [DIE_C[0] - 22, DIE_C[1] - 22], [DIE_C[0] + 22, DIE_C[1] - 22], [DIE_C[0] - 22, DIE_C[1] + 22], [DIE_C[0] + 22, DIE_C[1] + 22]].map(([x, y]) => ({ at: [PCB_Z[1], x, y], normal: [0, 0, 1], r: 2.2, tone: "lo" }));
const pcb = pr("card.pcb", PCB, PCB_Z[0], PCB_Z[1], { tone: "lo", crease: "faint", details: { dots: pcbDots, rings: pcbRings } });
{
  // traces: a few rule lines from the die to the memory, drawn in the PCB's top plane
  const trace = (pts) => `M${pts.map((p) => p.map((v) => v.toFixed(2)).join(" ")).join("L")}`;
  const lines = [];
  for (let i = 0; i < 5; i++) {
    const o = i * 2.2 - 4.4;
    lines.push(trace([[DIE_C[0] - 17.5, DIE_C[1] + o], [DIE_C[0] - 36.5, DIE_C[1] + o]]));
    lines.push(trace([[DIE_C[0] + 17.5, DIE_C[1] + o], [DIE_C[0] + 34.5, DIE_C[1] + o]]));
    lines.push(trace([[DIE_C[0] + o, DIE_C[1] + 17.5], [DIE_C[0] + o, DIE_C[1] + 30.5]]));
  }
  T.plane({ part: pcb, o: [0, 0, PCB_Z[1]], u: [1, 0, 0], v: [0, 1, 0], svg: `<path class="iso-line" data-tone="faint" d="${lines.join("")}"/>`, fade: [0.04, 0.3] });
}
const TAB_Y = [-57, -50];
const tabs = [[-70, -56], [-54, -8]];
for (const [index, [x0, x1]] of tabs.entries()) {
  pr(`card.tab.${index}`, { x: x0, y: TAB_Y[0], w: x1 - x0, d: TAB_Y[1] - TAB_Y[0], r: 0.4 }, PCB_Z[0], PCB_Z[1], { tone: "lo" });
  const gold = T.prism({ name: `card.fingers.${index}`, ...B, plan: { x: x0 + 0.8, y: TAB_Y[0] + 0.6, w: x1 - x0 - 1.6, d: 5.2, r: 0.3 }, z: PCB_Z[1], h: 0.12, steps: 2, tone: "hi", material: "gold" });
  const pads = [];
  for (let x = x0 + 2; x < x1 - 1.2; x += 1.6) pads.push(`M${x.toFixed(2)} ${(TAB_Y[0] + 0.6).toFixed(2)}L${x.toFixed(2)} ${(TAB_Y[0] + 5.8).toFixed(2)}`);
  T.plane({ part: gold, o: [0, 0, PCB_Z[1] + 0.12], u: [1, 0, 0], v: [0, 1, 0], svg: `<path class="iso-line" data-tone="lo" d="${pads.join("")}"/>`, fade: [0.04, 0.3] });
}

/* the GPU: substrate and the lit die */
pr("card.substrate", { x: DIE_C[0] - 19, y: DIE_C[1] - 19, w: 38, d: 38, r: 1 }, PCB_Z[1], PCB_Z[1] + 1, { tone: "mid", material: "gunmetal", details: { dots: [[-15, -15], [15, -15], [-15, 15], [15, 15]].map(([x, y]) => ({ at: [PCB_Z[1] + 1, DIE_C[0] + x, DIE_C[1] + y], normal: [0, 0, 1], size: 0.4 })) } });
export const DIE = { x: DIE_C[0] - 10, y: DIE_C[1] - 10, w: 20, d: 20, z: PCB_Z[1] + 1.8 };
pr("card.die", { x: DIE.x, y: DIE.y, w: DIE.w, d: DIE.d, r: 0.5 }, PCB_Z[1] + 1, DIE.z, { tone: "hi", lit: true, bevel: 0.2 });

/* four 2 GB GDDR6 packages round the die (8 GB on a 128-bit bus) */
const VRAM = [[DIE_C[0] - 42, DIE_C[1] - 9], [DIE_C[0] - 42, DIE_C[1] + 9], [DIE_C[0], DIE_C[1] + 36], [DIE_C[0] + 40, DIE_C[1]]];
for (const [index, [x, y]] of VRAM.entries()) {
  const vertical = index < 2 || index === 3;
  const plan = vertical ? { x: x - 7, y: y - 6, w: 14, d: 12, r: 0.6 } : { x: x - 6, y: y - 7, w: 12, d: 14, r: 0.6 };
  pr(`card.vram.${index}`, plan, PCB_Z[1], PCB_Z[1] + 1.2, { tone: "mid", material: "rubber", details: { dots: [{ at: [PCB_Z[1] + 1.2, plan.x + 1.6, plan.y + 1.6], normal: [0, 0, 1], size: 0.45, tone: "hi" }] } });
}

/* power stages and chokes, a low row on the right of the die */
for (let i = 0; i < 5; i++) {
  const x = 34 + i * 10;
  pr(`card.stage.${i}`, { x, y: 4, w: 6, d: 5, r: 0.4 }, PCB_Z[1], PCB_Z[1] + 0.9, { tone: "mid", material: "gunmetal" });
  pr(`card.choke.${i}`, { x: x - 1, y: 12, w: 8, d: 8, r: 0.8 }, PCB_Z[1], PCB_Z[1] + 1.7, { tone: "mid", material: "gunmetal", details: { dots: [{ at: [PCB_Z[1] + 1.7, x + 3, 16], normal: [0, 0, 1], size: 0.45 }] } });
}
pr("card.controller", { x: 40, y: -26, w: 9, d: 9, r: 0.5 }, PCB_Z[1], PCB_Z[1] + 0.9, { tone: "mid", material: "rubber" });
pr("card.bios", { x: -96, y: 22, w: 7, d: 5, r: 0.4 }, PCB_Z[1], PCB_Z[1] + 0.9, { tone: "mid", material: "rubber" });

/* ── table group, cooler layer: things that stand taller than the board ── */
const C = { group: table, layer: top };
// the 8-pin power connector on the PCB's top edge
const PWR = { x: 54, y: 43, w: 20, d: 7, r: 0.6 };
const pins = [];
for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) pins.push({ at: [BOARD_TOP + 1.8 + j * 3, PWR.x + 3 + i * 4.6, PWR.y + PWR.d], normal: [0, 1, 0], size: 0.55, tone: "lo" });
pr("card.power.base", PWR, PCB_Z[1], BOARD_TOP, { material: "rubber" });
T.prism({ name: "card.power", ...C, plan: PWR, z: BOARD_TOP, h: 6.6, steps: 2, tone: "mid", bevel: 0.3, material: "rubber", details: { dots: pins } });
T.prism({ name: "card.power.latch", ...C, plan: { x: PWR.x + 7, y: PWR.y + PWR.d, w: 6, d: 1.4, r: 0.3 }, z: BOARD_TOP + 4, h: 2.4, steps: 2, tone: "mid", material: "rubber" });
// the I/O bracket: a steel plate standing at the card's end, held by two feet screwed to the PCB
const BR_X = [-122.2, -120.2];
const BR_Y = [-52, 56];
const BR_Z = [BOARD_TOP, 52];
const ventDots = [];
const bracket = T.prism({ name: "card.bracket", ...C, plan: { x: BR_X[0], y: BR_Y[0], w: BR_X[1] - BR_X[0], d: BR_Y[1] - BR_Y[0], r: 0 }, z: BR_Z[0], h: BR_Z[1] - BR_Z[0], steps: 2, tone: "hi", crease: "lo", material: "steel", details: { dots: ventDots } });
for (const y of [-30, 30]) {
  T.round({ name: `card.standoff.${y}`, ...B, F: VERT(BR_X[1] + 4.4, y), s0: PCB_Z[1], s1: BOARD_TOP, r: 2.6, tone: "mid", material: "brass" });
  T.prism({ name: `card.bracket.foot.${y}`, ...C, plan: { x: BR_X[1], y: y - 4, w: 8, d: 8, r: 0.5 }, z: BOARD_TOP, h: 1.2, steps: 2, tone: "mid", material: "steel", details: { dots: [{ at: [BOARD_TOP + 1.2, BR_X[1] + 4.4, y], normal: [0, 0, 1], size: 0.5 }] } });
}
// vent slots through the bracket, drawn on both faces as closed outlines
{
  const slots = (swap) => {
    const out = [];
    for (let i = 0; i < 16; i++) {
      const y = -46 + i * 6.2;
      const z0 = 31;
      const z1 = 48;
      const r = 1.2;
      const a = (yy, zz) => (swap ? `${zz.toFixed(2)} ${yy.toFixed(2)}` : `${yy.toFixed(2)} ${zz.toFixed(2)}`);
      out.push(`M${a(y, z0 + r)}L${a(y, z1 - r)}A${r} ${r} 0 0 ${swap ? 0 : 1} ${a(y + 2 * r, z1 - r)}L${a(y + 2 * r, z0 + r)}A${r} ${r} 0 0 ${swap ? 0 : 1} ${a(y, z0 + r)}Z`);
    }
    return `<path class="iso-line" data-tone="lo" d="${out.join("")}"/>`;
  };
  T.plane({ part: bracket, o: [BR_X[1], 0, 0], u: [0, 1, 0], v: [0, 0, 1], svg: slots(false), fade: [0.12, 0.45] });
  T.plane({ part: bracket, o: [BR_X[0], 0, 0], u: [0, 0, 1], v: [0, 1, 0], svg: slots(true), fade: [0.12, 0.45] });
}
// display outputs: three DisplayPort shells and one HDMI on the bracket's outer face
for (const [index, [y, w]] of [[-38, 16], [-17, 16], [4, 16], [26, 15]].entries()) {
  T.prism({ name: `card.port.${index}`, ...C, F: { o: [0, 0, 0], a: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, polygon: [[y, 20], [y + w, 20], [y + w, 26.5], [y + 2, 26.5], [y, 24.5]].map(([a, b]) => [a, b]), s0: -BR_X[0], s1: -BR_X[0] + 1.8, tone: "mid", material: "chrome" });
}

/* ── cooler: cold plate, heat pipes, fin stack, shroud, fan motors ── */
const K = { group: cooler, layer: top };
T.prism({ name: "cool.plate", ...K, plan: { x: DIE_C[0] - 16, y: DIE_C[1] - 16, w: 32, d: 32, r: 1.2 }, z: COLD_Z[0], h: COLD_Z[1] - COLD_Z[0], steps: 2, tone: "hi", material: "copper", details: { dots: [[-13, -13], [13, -13], [-13, 13], [13, 13]].map(([x, y]) => ({ at: [COLD_Z[1], DIE_C[0] + x, DIE_C[1] + y], normal: [0, 0, 1], size: 0.5 })) } });
const PIPES = [-9.6, -3.2, 3.2, 9.6].map((o) => DIE_C[1] + o);
const PIPE_X = [-102, 98];
for (const [index, y] of PIPES.entries()) {
  const x0 = PIPE_X[0] + (index % 2) * 4;
  const x1 = PIPE_X[1] - ((index + 1) % 2) * 4;
  T.round({ name: `cool.pipe.${index}`, ...K, F: frameOf([x0, y, PIPE_Z], [1, 0, 0], [0, 0, 1]), s0: 0, s1: x1 - x0, r: PIPE_R, ends: ["dome", "dome"], tone: "hi", crease: "lo", material: "copper" });
}
const FIN_Y = [-46, 40];
const FIN_T = 0.7;
const FIN_COUNT = 33;
const FIN_X0 = -101;
const FIN_STEP = (199 - FIN_T) / (FIN_COUNT - 1);
for (let i = 0; i < FIN_COUNT; i++) {
  const x = FIN_X0 + i * FIN_STEP;
  T.prism({ name: `cool.fin.${i}`, ...K, plan: { x, y: FIN_Y[0], w: FIN_T, d: FIN_Y[1] - FIN_Y[0], r: 0 }, z: FIN_Z[0], h: FIN_Z[1] - FIN_Z[0], steps: 1, tone: "mid", crease: "faint", material: "steel" });
}
// shroud: skirts round the fin stack, a bridge between the fan cells, corner gussets
const SH = { tone: "mid", crease: "lo" };
const skirtZ = [FIN_Z[0] - 2, SHROUD_TOP];
const sk = (name, plan, z0 = skirtZ[0], z1 = skirtZ[1], extra = {}) => T.prism({ name, ...K, plan, z: z0, h: z1 - z0, steps: 2, bevel: 0.5, ...SH, ...extra });
sk("shroud.front", { x: -112, y: -50, w: 224, d: 4, r: 1.2 }, skirtZ[0], skirtZ[1], { details: { seams: [skirtZ[0] + 4], dots: [-80, -30, 30, 80].map((x) => ({ at: [skirtZ[0] + 9, x, -50], normal: [0, -1, 0], size: 0.5 })) } });
sk("shroud.back", { x: -112, y: FIN_Y[1], w: 224, d: 2.6, r: 0.8 }, skirtZ[0], skirtZ[1], { details: { seams: [skirtZ[0] + 4] } });
sk("shroud.end.l", { x: -112, y: FIN_Y[0], w: 6, d: FIN_Y[1] - FIN_Y[0], r: 0.6 });
sk("shroud.end.r", { x: 106, y: FIN_Y[0], w: 6, d: FIN_Y[1] - FIN_Y[0], r: 0.6 });
sk("shroud.bridge", { x: -6, y: FIN_Y[0], w: 12, d: FIN_Y[1] - FIN_Y[0], r: 0.6 }, FIN_Z[1], SHROUD_TOP, { details: { dots: [-30, 0, 30].map((y) => ({ at: [SHROUD_TOP, 0, y], normal: [0, 0, 1], size: 0.55 })) } });
T.prism({ name: "shroud.trim", ...K, plan: { x: -100, y: -50, w: 200, d: 1.4, r: 0.4 }, z: SHROUD_TOP, h: 0.7, steps: 2, tone: "hi", material: "chrome" });
const GUSSET = 30;
for (const [ci, [cx]] of FANS.entries()) {
  const xs = ci === 0 ? [-106, -6] : [6, 106];
  const corners = [[xs[0], FIN_Y[0], 1, 1], [xs[1], FIN_Y[0], -1, 1], [xs[0], FIN_Y[1], 1, -1], [xs[1], FIN_Y[1], -1, -1]];
  for (const [gi, [x, y, sx, sy]] of corners.entries()) {
    const tri = [[x, y], [x + sx * GUSSET, y], [x, y + sy * GUSSET]];
    const poly = sx * sy > 0 ? tri : [tri[0], tri[2], tri[1]];
    T.prism({ name: `shroud.gusset.${ci}.${gi}`, ...K, F: UP, polygon: poly, s0: FIN_Z[1], s1: SHROUD_TOP, ...SH, bevel: 0.4 });
  }
  void cx;
}
// fan motors: a stator disc on three struts sitting on the fins
const STATOR_Z = [FIN_Z[1], FIN_Z[1] + 2.2];
for (const [ci, [cx, cy]] of FANS.entries()) {
  T.round({ name: `fan.${ci}.stator`, ...K, F: VERT(cx, cy), s0: STATOR_Z[0], s1: STATOR_Z[1], r: 11, tone: "mid", material: "gunmetal" });
  for (const [si, ang] of [90, 210, 330].entries()) {
    const a = ((ang + (ci ? 180 : 0)) * Math.PI) / 180;
    const d = [Math.cos(a), Math.sin(a)];
    const n = [-d[1], d[0]];
    const r0 = 11;
    const r1 = 41;
    const half = 1.4;
    const poly = [[r0, -half], [r1, -half], [r1, half], [r0, half]].map(([r, t]) => [cx + d[0] * r + n[0] * t, cy + d[1] * r + n[1] * t]);
    T.prism({ name: `fan.${ci}.strut.${si}`, ...K, F: UP, polygon: poly, s0: FIN_Z[1], s1: FIN_Z[1] + 1.2, tone: "mid", material: "gunmetal" });
  }
}

/* ── fan rotors: a hub with a sticker ring and nine pitched blades each ── */
const HUB_Z = [STATOR_Z[1], STATOR_Z[1] + 4];
const BLADES = 9;
const PITCH = (14 * Math.PI) / 180;
const BLADE_Z = 44.4;
for (const [ci, [cx, cy]] of FANS.entries()) {
  const group = ci ? fanB : fanA;
  const hand = ci ? -1 : 1;
  const hub = T.round({ name: `fan.${ci}.hub`, group, layer: top, F: VERT(cx, cy), s0: HUB_Z[0], s1: HUB_Z[1], r: 12, tone: "hi", crease: "lo", material: "gunmetal" });
  const ring = (r, n) => Array.from({ length: n }, (_, j) => `${j ? "L" : "M"}${(cx + r * Math.cos((j / n) * Math.PI * 2)).toFixed(3)} ${(cy + r * Math.sin((j / n) * Math.PI * 2)).toFixed(3)}`).join("") + "Z";
  T.plane({ part: hub, o: [0, 0, HUB_Z[1]], u: [1, 0, 0], v: [0, 1, 0], svg: `<path class="iso-line" data-tone="lo" d="${ring(9.4, 72)}"/><path class="iso-line" data-tone="faint" d="${ring(6.6, 60)}"/><path class="iso-line" data-tone="mid" d="${ring(2.2, 24)}"/>`, fade: [0.04, 0.3] });
  for (let b = 0; b < BLADES; b++) {
    const a = ((b / BLADES) * 360 * Math.PI) / 180;
    const u = [Math.cos(a), Math.sin(a), 0];
    const tang = [-Math.sin(a) * hand, Math.cos(a) * hand, 0];
    const n = G.add3(G.mul3([0, 0, 1], Math.cos(PITCH)), G.mul3(tang, -Math.sin(PITCH)));
    const v = G.cross3(n, u);
    // blade outline in (radial, chord): a swept paddle, convex
    const poly = [[12, -3.4], [24, -7.2], [36, -9.6], [FAN_R - 0.6, -7.4], [FAN_R - 0.6, 4.6], [30, 6.2], [12, 3.0]];
    T.prism({ name: `fan.${ci}.blade.${b}`, group, layer: top, F: { o: [cx, cy, BLADE_Z], a: n, u, v }, polygon: poly, s0: -0.45, s1: 0.45, tone: "hi", crease: "faint", material: "gunmetal" });
  }
}

ground();
const verify = argv.includes("--verify");
const out = T.build({ statics: R.items, poses, verify });
A.settle(R, P);
if (argv.includes("--audit")) {
  A.auditOrExit(R, P);
  TA.orbitOrExit(T, R, P, {
    sweep: { at: (x) => follow({ table: x, spin: x * 3 }), from: 0, to: 360, frame: 0.3 },
    clips: [{ name: "lift", at: (t) => follow({ table: 40 + 6 * t, lift: Math.min(1, t / 1.2), spin: 90 * t }), from: 0, to: 1.6, frame: 1 / 60 }],
    quick: argv.includes("--quick"),
    only: argv.find((a) => a.startsWith("--only="))?.slice(7).split(",") ?? null,
    log: argv.includes("--verbose") ? (text) => console.log(`  … ${text}`) : null,
  });
}

const layerOf = (name) => R.items.filter((item) => item.layer === name).sort((a, b) => a.key - b.key).map((item) => item.svg);
const LABEL = "An RTX 4060 graphics card lying fans-up on a machined turntable: backplate, circuit board with gold edge fingers, the GPU die with four memory chips round it, power stages, an 8-pin power connector, the I/O bracket, copper heat pipes under a stack of aluminium fins, the shroud and two fans.";
const backSvg = k.figureSvg({ width: W, height: H, label: LABEL, body: layerOf("back") });
const stage = `${backSvg}${out.layerSvg("board", { width: W, height: H })}<canvas class="iso-layer gh-gl" data-canvas="glow" aria-hidden="true"></canvas>${out.layerSvg("cooler", { width: W, height: H })}`;
const data = { W, H, stage, css: out.css, turn: out.data, gl: { camera: glCamera(P), die: [DIE_C[0], DIE_C[1], DIE.z], pcbZ: PCB_Z[1] }, lift: LIFT };
const json = JSON.stringify(data);
if (!argv.includes("--audit")) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
}
console.log(`gpu hero · ${(json.length / 1024).toFixed(0)} KB · ${out.report.parts} parts · ${out.report.layers.map((l) => `${l.name}: ${l.planar} planar, ${l.framed} framed, ${l.dynamic} dynamic`).join(" · ")} · build ${out.report.seconds.toFixed(1)} s`);
