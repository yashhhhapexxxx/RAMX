/* Figure W1 timeline: one request through the press line, as a pure function of time.
   pass: the shuttle visits every station of a bench and each ram stamps the token; the token hops over the
   cable to the next bench; at the end it drops into the gateway's tray. pay: every bench's chute drops one coin
   per layer it served, the burn chute 2 into the grate, the reserve chute 2 (plus any own-request share).
   Shown slowed: the real pass of one token takes 1000 / tok/s ms. */
import type { Station } from "./geometry";

export const STEP = 0.2;
export const MOVE = 0.45;
export const HOP = 0.7;
export const DROP = 0.55;
export const COIN_EVERY = 0.12;
export const FALL = 0.3;
const RETURN = 0.9;
const HOLD = 2.4;

export type Timeline = {
  stationAt: number[];
  benchEnd: number[];
  benchStart: number[];
  passEnd: number;
  payAt: number;
  payEnd: number;
  total: number;
};

export function timelineOf(stations: Station[], benchCount: number, coins: { perBench: number[]; burn: number; reserve: number }): Timeline {
  const stationAt: number[] = [];
  const benchStart: number[] = Array(benchCount).fill(0);
  const benchEnd: number[] = Array(benchCount).fill(0);
  let t = 0;
  let bench = -1;
  for (const s of stations) {
    if (s.bench !== bench) {
      if (bench >= 0) {
        benchEnd[bench] = t;
        t += HOP;
      }
      bench = s.bench;
      benchStart[bench] = t;
    }
    stationAt.push(t);
    t += STEP;
  }
  if (bench >= 0) benchEnd[bench] = t;
  const passEnd = t;
  const payAt = passEnd + DROP + 0.3;
  const most = Math.max(0, ...coins.perBench, coins.burn, coins.reserve);
  const payEnd = payAt + most * COIN_EVERY + FALL;
  return { stationAt, benchStart, benchEnd, passEnd, payAt, payEnd, total: payEnd + HOLD };
}

const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** Where bench `b`'s shuttle is (world x) and whether it carries the token, at time t. */
export function shuttleAt(t: number, b: number, stations: Station[], tl: Timeline, restX: number) {
  const mine = stations.map((s, k) => ({ s, k })).filter(({ s }) => s.bench === b);
  if (!mine.length) return { x: restX, carrying: false };
  if (t < tl.benchStart[b]) return { x: restX, carrying: false };
  if (t >= tl.benchEnd[b]) {
    const back = ease((t - tl.benchEnd[b] - 0.2) / RETURN);
    const last = mine[mine.length - 1].s.x;
    return { x: last + (restX - last) * back, carrying: false };
  }
  let prev = restX;
  for (const { s, k } of mine) {
    const t0 = tl.stationAt[k];
    if (t < t0 + STEP) {
      const u = (t - t0) / STEP;
      return { x: prev + (s.x - prev) * ease(u / MOVE), carrying: true };
    }
    prev = s.x;
  }
  return { x: prev, carrying: true };
}

/** Ram drop (world units, ≥ 0) for station k at time t: a single press after the shuttle arrives. */
export function ramAt(t: number, k: number, tl: Timeline, stroke: number) {
  const u = (t - tl.stationAt[k]) / STEP;
  if (u <= MOVE || u >= 1) return 0;
  return stroke * Math.sin((Math.PI * (u - MOVE)) / (1 - MOVE));
}

/** True once station k has stamped the token this cycle. */
export const stampedAt = (t: number, k: number, tl: Timeline) => t >= tl.stationAt[k] + STEP * (MOVE + (1 - MOVE) / 2);

/** Coins that have landed for a chute dropping `count`, and the fall fraction of each coin still in the air. */
export function coinsAt(t: number, tl: Timeline, count: number) {
  const landed: number[] = [];
  const falling: { index: number; u: number }[] = [];
  for (let n = 0; n < count; n++) {
    const start = tl.payAt + n * COIN_EVERY;
    if (t >= start + FALL) landed.push(n);
    else if (t >= start) falling.push({ index: n, u: (t - start) / FALL });
  }
  return { landed: landed.length, falling };
}

/** Which bench is working (or hopping toward) at time t, for the readout. */
export function phaseAt(t: number, stations: Station[], tl: Timeline) {
  if (t < tl.passEnd) {
    for (let k = stations.length - 1; k >= 0; k--) if (t >= tl.stationAt[k]) return { kind: "pass" as const, station: k };
    return { kind: "pass" as const, station: 0 };
  }
  if (t < tl.payAt) return { kind: "out" as const, station: stations.length - 1 };
  if (t < tl.payEnd) return { kind: "pay" as const, station: stations.length - 1 };
  return { kind: "rest" as const, station: stations.length - 1 };
}

/** True while bench b's token is crossing the cable to bench b + 1, with the fraction done. */
export function hopAt(t: number, b: number, tl: Timeline) {
  const start = tl.benchEnd[b];
  if (t < start || t >= start + HOP) return null;
  return (t - start) / HOP;
}

/** The pass time on screen, for the slow-motion factor in the readout. */
export const shownPassMs = (tl: Timeline) => tl.passEnd * 1000;
