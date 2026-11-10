/* Figure W1 geometry: the layer press line, built with the Anatomy kit in the browser whenever the pool changes
   (never per frame). World units ≈ millimetres of a bench model; x runs along the line, y toward the viewer, z up.
   Each station is a small stamping press straddling the bench's rail: a back column, a front column, a crown and a
   ram that drops onto the token. Each bench is a laptop's workbench: legs, top, the laptop at the back, the rail with
   end stops, a coin chute on a post at the front and a cup under it. A cable carries the token from bench to bench;
   the gateway stand at the end holds the output tray, the burn grate and the reserve box. */
import * as k from "../kit/iso-kit";
import type { Flat, Plan, Point3, Projection } from "../kit/iso-kit";
import type { Line } from "./model";
import { coinsOf, layersOf } from "./model";

export const W = 760;
export const H = 260;
const AZIMUTH = 72;

export const PITCH = 8;
const END = 13;
const LAPTOP_W = 30;
const GAP = 30;
export const LEG_Z = [0, 36] as const;
export const TOP_Z = [36, 41] as const;
export const RAIL_Z = [41, 43] as const;
export const SHUTTLE_Z = [43, 45.6] as const;
export const TOKEN_Z = [45.6, 47] as const;
const COLUMN_Z = [41, 56] as const;
const CROWN_Z = [56, 59] as const;
const HEAD_Z = [50, 52.5] as const;
const ROD_Z = [52.5, 58.8] as const;
export const STAMP = 3;
const BENCH_Y = [-28, 28] as const;
export const CHUTE = { y: 19, top: 84, bottom: 63, r: 2.4 };
export const CUP = { y: 19, r: 6, z: TOP_Z[1], h: 1.6 };
export const COIN = { r: 3.4, h: 0.55 };
const GATE_W = 64;

export type Station = { bench: number; x: number; layer: number };
export type BenchGeo = { x0: number; x1: number; railStart: number; railEnd: number; chuteX: number; stations: number };
export type Geo = {
  P: Projection;
  svg: string;
  stations: Station[];
  benches: BenchGeo[];
  hops: Flat[][];
  tray: Point3;
  burn: Point3;
  reserve: Point3;
  chuteTop: (bench: number) => Point3;
};

const S = (paths: k.SolidPaths, style?: k.SolidStyle) => k.solidSvg(paths, style);
const L = (d: string, style?: k.LineStyle) => k.lineSvg(d, style);

/** Bench extents along x for a line: each bench is as long as its stations plus the laptop and end room. */
export function layoutOf(line: Line) {
  const benches: BenchGeo[] = [];
  let x = 0;
  line.benches.forEach((_, i) => {
    const n = Math.max(layersOf(line, i), 0);
    const w = LAPTOP_W + END * 2 + Math.max(n, 4) * PITCH;
    const railStart = x + LAPTOP_W + END - PITCH / 2;
    benches.push({ x0: x, x1: x + w, railStart, railEnd: railStart + Math.max(n, 4) * PITCH + PITCH, chuteX: x + 16, stations: n });
    x += w + GAP;
  });
  return { benches, gateX: x - GAP + 22, length: x - GAP + 22 + GATE_W };
}

export function geometryOf(line: Line): Geo {
  const { benches, gateX, length } = layoutOf(line);
  const coins = coinsOf(line);
  const fit: Point3[] = [...k.boxCorners({ x: -6, y: BENCH_Y[0] - 4, w: length + 12, d: BENCH_Y[1] - BENCH_Y[0] + 8, r: 0 }, 0, CHUTE.top + 6)];
  const P = k.fitProjection(fit, W, H, { pad: 18, azimuth: AZIMUTH });
  const at = (p: Point3) => k.iso(p, P);
  const parts: string[] = [];
  const stations: Station[] = [];
  const hops: Flat[][] = [];
  let layer = 0;

  // floor halo under the whole line
  parts.push(`<path class="iso-halo" d="${k.haloOf({ x: -4, y: BENCH_Y[0] - 2, w: length + 8, d: BENCH_Y[1] - BENCH_Y[0] + 4, r: 6 }, 0, 0.1, P)}"/>`);

  benches.forEach((b, i) => {
    const out: string[] = [];
    const top: Plan = { x: b.x0, y: BENCH_Y[0], w: b.x1 - b.x0, d: BENCH_Y[1] - BENCH_Y[0], r: 2 };
    // legs: back two, then a stretcher, then the front two after the top (the top hides their upper ends anyway)
    const legs = k.corners(top, 5).sort((a, c) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([c[0], c[1], 0], P));
    for (const [x, y] of legs) out.push(S(k.slabOf({ x: x - 2, y: y - 2, w: 4, d: 4, r: 0.6 }, LEG_Z[0], LEG_Z[1] - LEG_Z[0], P, 3), { tone: "mid", crease: "none" }));
    out.push(S(k.slabOf({ x: b.x0 + 3, y: -1.5, w: b.x1 - b.x0 - 6, d: 3, r: 0.6 }, 9, 3, P, 3), { tone: "lo" }));
    const screws = k.corners(top, 3.4);
    out.push(S(k.slabOf(top, TOP_Z[0], TOP_Z[1] - TOP_Z[0], P, 4, 0.8), { tone: "mid", inner: L(k.sideSeam(top, TOP_Z[0] + 1.6, P, 4), { tone: "faint" }) }));
    out.push(L(k.planOutline(k.insetPlan(top, 2.2), TOP_Z[1], P), { tone: "faint" }));
    out.push(k.dotsSvg(screws.map(([x, y]) => at([x, y, TOP_Z[1]])), { size: 0.45 }));

    // the laptop at the back-left: base with a key grid, lid standing up with a bezel on its face
    const lx = b.x0 + 4;
    const base: Plan = { x: lx, y: -25, w: LAPTOP_W - 4, d: 13, r: 1 };
    out.push(S(k.slabOf({ x: lx, y: -26.2, w: LAPTOP_W - 4, d: 1.2, r: 0.3 }, TOP_Z[1], 18, P, 2, 0.3), { tone: "hi", crease: "lo" }));
    const lidFace = (u: number, v: number): Point3 => [lx + u, -25, TOP_Z[1] + v];
    out.push(`<path class="iso-line" data-tone="lo" d="${k.pathOf([at(lidFace(2, 2.4)), at(lidFace(LAPTOP_W - 6, 2.4)), at(lidFace(LAPTOP_W - 6, 16)), at(lidFace(2, 16))], true)}"/>`);
    out.push(`<path class="ll-screen" data-bench="${i}" d="${k.pathOf([at(lidFace(2.6, 3)), at(lidFace(LAPTOP_W - 6.6, 3)), at(lidFace(LAPTOP_W - 6.6, 15.4)), at(lidFace(2.6, 15.4))], true)}"/>`);
    out.push(S(k.slabOf(base, TOP_Z[1], 1.4, P, 3, 0.3), { tone: "hi", crease: "lo" }));
    out.push(k.dotsSvg(k.dotGrid(lx + 3, -22.5, 10, 4, 2, TOP_Z[1] + 1.4, P), { size: 0.32, tone: "lo" }));
    out.push(L(k.planOutline({ x: lx + 8, y: -14.6, w: 10, d: 2.2, r: 0.4 }, TOP_Z[1] + 1.4, P), { tone: "faint" }));

    // rail with end stops
    const rail: Plan = { x: b.railStart, y: -2.5, w: b.railEnd - b.railStart, d: 5, r: 0.6 };
    out.push(S(k.slabOf(rail, RAIL_Z[0], RAIL_Z[1] - RAIL_Z[0], P, 3, 0.3), { tone: "mid" }));
    const ticks = k.topTicks(b.railStart + PITCH, b.railEnd - PITCH * 0.5, PITCH, 5, 2.5, RAIL_Z[1], [1, 1.6], P);
    out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
    const stop = (x: number) => S(k.slabOf({ x: x - 1.6, y: -4, w: 3.2, d: 8, r: 0.5 }, RAIL_Z[0], 5.2, P, 3, 0.4), { tone: "mid" }) + k.dotsSvg([at([x, -2.4, RAIL_Z[0] + 5.2]), at([x, 2.4, RAIL_Z[0] + 5.2])], { size: 0.4 });
    out.push(`<g data-stop="start">${stop(b.railStart - 1.6)}</g>`);

    // the shuttle (moved by the live loop: data-shuttle) and the stations, back half then front half each
    const shuttle = `<g data-shuttle="${i}">${S(k.slabOf({ x: -3.4, y: -3.2, w: 6.8, d: 6.4, r: 0.8 }, SHUTTLE_Z[0], SHUTTLE_Z[1] - SHUTTLE_Z[0], P, 3, 0.3), { tone: "hi", crease: "lo" })}<g data-token="${i}" style="opacity:0">${S(k.cylinder(0, 0, 2.2, TOKEN_Z[0], TOKEN_Z[1] - TOKEN_Z[0], P, 20), { tone: "hi", lit: true })}</g></g>`;
    const shuttleAt = translate(P, [b.railStart + PITCH / 2, 0, 0]);
    const backs: string[] = [];
    const fronts: string[] = [];
    for (let j = 0; j < b.stations; j++) {
      const sx = b.railStart + PITCH + j * PITCH;
      stations.push({ bench: i, x: sx, layer });
      const back = S(k.slabOf({ x: sx - 1, y: -9.5, w: 2, d: 2, r: 0.3 }, COLUMN_Z[0], COLUMN_Z[1] - COLUMN_Z[0], P, 2), { tone: "mid", crease: "none" });
      const ram =
        S(k.slabOf({ x: sx - 0.8, y: -0.8, w: 1.6, d: 1.6, r: 0.6 }, ROD_Z[0], ROD_Z[1] - ROD_Z[0], P, 3), { tone: "hi", crease: "none" }) +
        S(k.slabOf({ x: sx - 2.2, y: -2.6, w: 4.4, d: 5.2, r: 0.5 }, HEAD_Z[0], HEAD_Z[1] - HEAD_Z[0], P, 3, 0.25), { tone: "hi", crease: "lo" });
      const front = S(k.slabOf({ x: sx - 1, y: 7.5, w: 2, d: 2, r: 0.3 }, COLUMN_Z[0], COLUMN_Z[1] - COLUMN_Z[0], P, 2), { tone: "mid", crease: "none" });
      const crown = S(k.slabOf({ x: sx - 2.8, y: -10.2, w: 5.6, d: 20.4, r: 0.6 }, CROWN_Z[0], CROWN_Z[1] - CROWN_Z[0], P, 3, 0.3), { tone: "mid", crease: "lo" }) + k.dotsSvg([at([sx, -8.5, CROWN_Z[1]]), at([sx, 8.5, CROWN_Z[1]])], { size: 0.38 });
      const lamp = `<g data-lamp="${layer}">${S(k.cylinder(sx, 4.2, 1.1, CROWN_Z[1], 0.6, P, 14), { tone: "mid" })}</g>`;
      backs.push(back);
      fronts.push(`<g data-ram="${layer}">${ram}</g>${front}${crown}${lamp}`);
      layer++;
    }
    // Painter's order: every back column is behind the shuttle wherever they overlap on screen, every ram, crown
    // and front column in front of it, so the shuttle slots between the two halves for its whole travel.
    out.push(backs.join(""), `<g data-shuttle-slot="${i}" transform="${shuttleAt}">${shuttle}</g>`, fronts.join(""));
    out.push(`<g data-stop="end">${stop(b.railEnd + 1.6)}</g>`);

    // coin chute on a post at the front-left, a hopper on top, the cup under its mouth
    const cx = b.chuteX;
    out.push(S(k.slabOf({ x: cx - 9.4, y: CHUTE.y - 1.4, w: 2.8, d: 2.8, r: 0.4 }, TOP_Z[1], CHUTE.top - TOP_Z[1] - 2, P, 2), { tone: "mid", crease: "none" }));
    out.push(S(k.slabOf({ x: cx - 9.4, y: CHUTE.y - 1.2, w: 7, d: 2.4, r: 0.4 }, CHUTE.top - 10, 2.2, P, 2), { tone: "mid" }));
    out.push(`<g data-cup="${i}">${S(k.cylinder(cx, CUP.y, CUP.r, CUP.z, CUP.h, P, 28, 0.4), { tone: "mid", crease: "lo" })}${L(k.ring(cx, CUP.y, CUP.r - 1.2, CUP.z + CUP.h, P, 28), { tone: "lo" })}</g>`);
    out.push(`<g data-stack="${i}">${stackOf(P, cx, CUP.y, coins.perBench[i])}</g>`);
    out.push(fallers(P, `b${i}`, [cx, CHUTE.y, CHUTE.bottom - COIN.h]));
    out.push(S(k.cylinder(cx, CHUTE.y, CHUTE.r, CHUTE.bottom, CHUTE.top - CHUTE.bottom - 6, P, 20), { tone: "hi", crease: "lo", inner: L(k.sideArc(cx, CHUTE.y, CHUTE.r, CHUTE.bottom + 3, P, 14), { tone: "faint" }) }));
    out.push(S(k.cylinder(cx, CHUTE.y, CHUTE.r + 2.6, CHUTE.top - 6, 6, P, 24, 0.4), { tone: "mid", crease: "lo" }) + L(k.ring(cx, CHUTE.y, CHUTE.r + 1.4, CHUTE.top, P, 24), { tone: "lo" }));

    parts.push(`<g data-bench="${i}">${out.join("")}</g>`);

    // the cable to the next bench: from this end stop, sagging under the gap, to the next start stop
    const next = benches[i + 1];
    if (next) {
      const from: Point3 = [b.railEnd + 3.2, 0, RAIL_Z[0] + 2.6];
      const to: Point3 = [next.railStart - 3.2, 0, RAIL_Z[0] + 2.6];
      const mid = (b.x1 + next.x0) / 2;
      const pts: Point3[] = [];
      const run = (a: Point3, c: Point3, n: number) => {
        for (let s = 0; s <= n; s++) {
          const t = s / n;
          pts.push([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t - Math.sin(Math.PI * t) * (a[2] - 26)]);
        }
      };
      void mid;
      run(from, to, 36);
      const flat = pts.map(at);
      hops.push(flat);
      parts.push(`<g data-hop="${i}"><path class="iso-line ll-cable" d="${k.pathOf(flat)}"/><path class="iso-line ll-cable-core" d="${k.pathOf(flat)}"/>${k.dotsSvg([flat[0], flat[flat.length - 1]], { size: 0.9, tone: "hi" })}</g>`);
    }
  });

  // the gateway stand: a cabinet with the output tray, the burn grate and the reserve box, two chutes over them
  const gate: Plan = { x: gateX, y: -24, w: GATE_W, d: 48, r: 2 };
  const g: string[] = [];
  g.push(S(k.slabOf(gate, 0, TOP_Z[1], P, 4, 0.8), { tone: "mid", inner: L(k.sideSeam(gate, 6, P, 4) + k.sideSeam(gate, TOP_Z[1] - 6, P, 4), { tone: "faint" }) }));
  g.push(L(k.planOutline(k.insetPlan(gate, 2.2), TOP_Z[1], P), { tone: "faint" }));
  const tray: Plan = { x: gateX + 6, y: -18, w: 20, d: 14, r: 1.6 };
  g.push(S(k.slabOf(tray, TOP_Z[1], 2.4, P, 4, 0.3), { tone: "mid", inner: L(k.planOutline(k.insetPlan(tray, 1.6), TOP_Z[1] + 2.4, P), { tone: "lo" }) }));
  g.push(`<g data-out style="display:none">${S(k.cylinder(tray.x + tray.w / 2, tray.y + tray.d / 2, 2.2, TOP_Z[1] + 1.2, 1.4, P, 20), { tone: "hi", lit: true })}</g>`);
  const grate: Plan = { x: gateX + 34, y: -18, w: 22, d: 14, r: 1 };
  g.push(S(k.slabOf(grate, TOP_Z[1], 1.6, P, 3, 0.3), { tone: "lo", crease: "lo" }));
  const bars: string[] = [];
  for (let gx = grate.x + 3; gx < grate.x + grate.w - 1.5; gx += 2.6) bars.push(k.lineOnTop([gx, grate.y + 1.4], [gx, grate.y + grate.d - 1.4], TOP_Z[1] + 1.6, P));
  g.push(L(k.planOutline(k.insetPlan(grate, 1.4), TOP_Z[1] + 1.6, P), { tone: "mid" }), L(bars.join(""), { tone: "mid" }));
  g.push(`<g data-burn-glow></g>`);
  const box: Plan = { x: gateX + 34, y: 4, w: 22, d: 16, r: 1.4 };
  g.push(S(k.slabOf(box, TOP_Z[1], 9, P, 3, 0.5), { tone: "hi", crease: "lo", inner: L(k.sideSeam(box, TOP_Z[1] + 3, P, 3), { tone: "faint" }) }));
  g.push(L(k.planOutline({ x: box.x + 5, y: box.y + 7, w: 12, d: 2, r: 0.8 }, TOP_Z[1] + 9, P), { tone: "mid" }));
  g.push(k.dotsSvg(k.corners(box, 2).map(([x, y]) => at([x, y, TOP_Z[1] + 9])), { size: 0.4 }));
  for (const [key, cx, cy] of [["burn", grate.x + grate.w / 2, grate.y + grate.d / 2], ["reserve", box.x + box.w / 2, box.y + box.d / 2 - 2.5]] as const) {
    g.push(fallers(P, key, [cx, cy, CHUTE.bottom + 4 - COIN.h]));
    g.push(S(k.slabOf({ x: cx + 6, y: cy - 1.2, w: 2.4, d: 2.4, r: 0.4 }, TOP_Z[1] + (cy > 0 ? 9 : 1.6), CHUTE.top - TOP_Z[1] - (cy > 0 ? 9 : 1.6) - 4, P, 2), { tone: "mid", crease: "none" }));
    g.push(S(k.cylinder(cx, cy, CHUTE.r, CHUTE.bottom + 4, CHUTE.top - CHUTE.bottom - 10, P, 20), { tone: "hi", crease: "lo" }));
    g.push(S(k.slabOf({ x: cx + 1.6, y: cy - 1, w: 6.8, d: 2, r: 0.4 }, CHUTE.top - 12, 2, P, 2), { tone: "mid" }));
    g.push(S(k.cylinder(cx, cy, CHUTE.r + 2.6, CHUTE.top - 6, 6, P, 24, 0.4), { tone: "mid", crease: "lo" }) + L(k.ring(cx, cy, CHUTE.r + 1.4, CHUTE.top, P, 24), { tone: "lo" }));
  }
  parts.push(`<g data-gate>${g.join("")}</g>`);
  parts.push(`<g data-flight style="display:none"><circle r="${(2.4 * scaleOf(P)).toFixed(2)}" class="ll-token"/></g>`);

  const burn: Point3 = [grate.x + grate.w / 2, grate.y + grate.d / 2, TOP_Z[1] + 1.6];
  const reserve: Point3 = [box.x + box.w / 2, box.y + box.d / 2 - 2.5, TOP_Z[1] + 9];
  return {
    P,
    svg: parts.join(""),
    stations,
    benches,
    hops,
    tray: [tray.x + tray.w / 2, tray.y + tray.d / 2, TOP_Z[1] + 2.4],
    burn,
    reserve,
    chuteTop: (bench: number) => [benches[bench].chuteX, CHUTE.y, CHUTE.bottom],
  };
}

export function translate(P: Projection, by: Point3) {
  return k.translateAlong(P, by);
}

/** One coin, flat on its face at `at` (its bottom), as kit markup. */
export function coinSvg(P: Projection, at: Point3, lit = false) {
  return S(k.cylinder(at[0], at[1], COIN.r, at[2], COIN.h, P, 22, 0.2), { tone: "hi", crease: "lo", lit });
}

/** The coins at rest in a bench's cup, bottom up: `count` coins, slightly staggered like a real stack. */
export function stackOf(P: Projection, x: number, y: number, count: number) {
  const out: string[] = [];
  for (let c = 0; c < count; c++) {
    const jx = Math.sin(c * 2.4) * 0.35;
    const jy = Math.cos(c * 1.7) * 0.35;
    out.push(`<g data-coin="${c}" style="display:none">${coinSvg(P, [x + jx, y + jy, CUP.z + CUP.h + c * COIN.h], false)}</g>`);
  }
  return out.join("");
}

/** A small pool of coins hidden at a chute's mouth; the live loop drops them by translating down. */
function fallers(P: Projection, key: string, mouth: Point3) {
  return Array.from({ length: 3 }, (_, n) => `<g data-fall="${key}" data-n="${n}" style="display:none">${coinSvg(P, mouth, true)}</g>`).join("");
}

/** Screen px per world unit. */
export function scaleOf(P: Projection) {
  const a = k.iso([0, 0, 0], P);
  const b = k.iso([0, 0, 10], P);
  return Math.hypot(b[0] - a[0], b[1] - a[1]) / 10 / Math.cos((30 * Math.PI) / 180);
}

export { coinsOf };
