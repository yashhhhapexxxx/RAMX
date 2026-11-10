/* Figure W1, "the layer press line". The model is a line of 40 stamping stations; each laptop is a workbench
   holding the span of stations (layers) it serves. A query token rides a shuttle through every station, hops
   between benches over a cable and drops into the gateway's tray as an output token; then each bench's chute
   drops one coin per layer it served (the 90%), 2 coins fall into the burn grate and 2 into the reserve box.
   Add or remove a laptop or change its memory and the stations re-divide (lib/layers.ts); credits come from
   the gateway's integer rule (lib/credits.ts). Self-contained: place it anywhere. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Plate } from "./kit/react/draw";
import { iso, translateAlong } from "./kit/iso-kit";
import "./kit/iso.css";
import "./line/layer-line.css";
import { CHUTE, COIN, CUP, H, RAIL_Z, STAMP, TOP_Z, W, geometryOf, scaleOf } from "./line/geometry";
import { DEVICES, FACTOR, LIVE_BENCHES, MAX_BENCHES, MEM_STEPS, MODEL_NAME, REQUEST, TOTAL_LAYERS, VEST_MIN, coinsOf, credits, layersOf, lineOf, slowBy } from "./line/model";
import type { Bench } from "./line/model";
import { coinsAt, hopAt, phaseAt, ramAt, shownPassMs, shuttleAt, stampedAt, timelineOf } from "./line/motion";

type Props = { theme?: "dark" | "light"; className?: string };

export default function LayerLine({ theme = "dark", className }: Props) {
  const [benches, setBenches] = useState<Bench[]>(LIVE_BENCHES);
  const [live, setLive] = useState(true);
  const [self, setSelf] = useState<number | null>(null);
  const line = useMemo(() => lineOf(benches, live, self), [benches, live, self]);
  const geo = useMemo(() => geometryOf(line), [line]);
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGGElement>(null);

  const edit = (next: Bench[]) => {
    setBenches(next);
    setLive(false);
    setSelf((s) => (s !== null && s < next.length ? s : null));
  };
  const add = () => benches.length < MAX_BENCHES && edit([...benches, { ...DEVICES[benches.length % DEVICES.length], id: `bench-${Date.now()}` }]);
  const remove = () => benches.length > 1 && edit(benches.slice(0, -1));
  const cycleMem = (i: number) => edit(benches.map((b, j) => (j === i ? { ...b, memGb: MEM_STEPS[(MEM_STEPS.indexOf(b.memGb) + 1) % MEM_STEPS.length] } : b)));
  const reset = () => {
    setBenches(LIVE_BENCHES);
    setLive(true);
    setSelf(null);
  };

  const summary = line.route ? `${line.benches.map((_, i) => layersOf(line, i)).join(" · ")} layers · ${line.tokS!.toFixed(1)} tok/s` : `${MODEL_NAME} does not fit`;

  useEffect(() => {
    const root = svgRef.current;
    const stage = stageRef.current;
    if (!root || !stage || !line.route) return;
    return animate(stage, root, line, geo);
  }, [line, geo]);

  const coins = coinsOf(line);
  return (
    <div className={`iso ll${className ? ` ${className}` : ""}`} data-theme={theme}>
      <Plate fig="Fig 2" title="The layer press line" hint="Add a laptop · change its memory" readout={summary}>
        <div
          ref={stageRef}
          className="iso-stage ll-stage"
          tabIndex={0}
          role="group"
          aria-label={`${MODEL_NAME} as a press line of ${TOTAL_LAYERS} stations over ${line.benches.length} laptops. Plus and minus add or remove a laptop, 1 to 4 change a laptop's memory, S marks a laptop as yours.`}
          onKeyDown={(e) => {
            if (e.key === "+" || e.key === "=") add();
            else if (e.key === "-") remove();
            else if (/^[1-4]$/.test(e.key) && Number(e.key) <= benches.length) cycleMem(Number(e.key) - 1);
            else if (e.key === "s" || e.key === "S") setSelf((s) => (s === null ? 0 : s + 1 < benches.length ? s + 1 : null));
            else return;
            e.preventDefault();
          }}
        >
          <svg className="iso-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Workbenches in a row, each with a laptop, a rail of stamping presses and a coin chute; a gateway stand with a tray, a burn grate and a reserve box at the end." focusable="false">
            <g ref={svgRef} dangerouslySetInnerHTML={{ __html: geo.svg }} />
          </svg>
        </div>
      </Plate>
      <div className="ll-panel">
        <div className="ll-benches">
          {line.benches.map((b, i) => {
            const hop = line.route?.find((h) => h.node_id === b.id);
            return (
              <div className="ll-bench" key={b.id} data-self={self === i ? "" : undefined}>
                <span className="ll-name">
                  <b>{i + 1}</b> {b.gpu}
                </span>
                <button type="button" onClick={() => cycleMem(i)} aria-label={`Laptop ${i + 1} memory ${b.memGb} GB, change`}>
                  {b.memGb} GB
                </button>
                <span className="ll-num">{hop ? `[${hop.layers[0]}, ${hop.layers[1]})` : "—"}</span>
                <span className="ll-num">{self === i ? "0 · yours" : `${credits(line.nodesMc[i])} cr`}</span>
                <label className="ll-mine">
                  <input type="radio" name="ll-self" checked={self === i} onChange={() => setSelf(i)} /> mine
                </label>
              </div>
            );
          })}
        </div>
        <div className="ll-actions">
          <button type="button" onClick={add} disabled={benches.length >= MAX_BENCHES}>
            + laptop
          </button>
          <button type="button" onClick={remove} disabled={benches.length <= 1}>
            − laptop
          </button>
          <button type="button" onClick={() => setSelf(null)} disabled={self === null}>
            not mine
          </button>
          <button type="button" onClick={reset} disabled={live && self === null}>
            live pool
          </button>
        </div>
        <p className="ll-caption">
          {line.route ? (
            <>
              {line.live ? "The live pool's layer map, " : "Estimated split (layers by usable memory), "}
              {line.tokS!.toFixed(1)} tok/s{line.live ? " measured" : " estimated"}, shown about ×{slowBy(line.tokS!, shownPassMs(timelineOf(geo.stations, line.benches.length, coins)))} slower. One request of {REQUEST.inTokens} in, {REQUEST.outTokens} out costs {FACTOR} × ({REQUEST.outTokens} + 0.2 × {REQUEST.inTokens}) = {credits(line.costMc)} credits: 90% to the benches by layers (a coin per layer), {credits(line.burnMc)} burned, {credits(line.reserveMc)} to the reserve. A laptop gets 0 on its own owner's request. Earnings vest for {VEST_MIN} minutes.
            </>
          ) : (
            <>These laptops cannot hold {MODEL_NAME} ({TOTAL_LAYERS} layers): each keeps 2 GB back, and the rest is too small. Add a laptop or more memory.</>
          )}
        </p>
      </div>
    </div>
  );
}

type Geo = ReturnType<typeof geometryOf>;
type LineT = ReturnType<typeof lineOf>;

/* The live loop: one timeline per request, DOM writes through attributes only. */
function animate(stage: HTMLElement, root: SVGGElement, line: LineT, geo: Geo) {
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const readout = stage.closest(".iso-plate")?.querySelector("[data-readout]");
  const coins = coinsOf(line);
  const tl = timelineOf(geo.stations, line.benches.length, coins);
  const q = <T extends Element>(sel: string) => Array.from(root.querySelectorAll<T>(sel));
  const shuttles = line.benches.map((_, i) => root.querySelector<SVGGElement>(`[data-shuttle="${i}"]`));
  const tokens = line.benches.map((_, i) => root.querySelector<SVGGElement>(`[data-token="${i}"]`));
  const rams = q<SVGGElement>("[data-ram]");
  const lamps = q<SVGGElement>("[data-lamp] .iso-solid");
  const stacks = line.benches.map((_, i) => Array.from(root.querySelectorAll<SVGGElement>(`[data-stack="${i}"] [data-coin]`)));
  const fallers = (key: string) => Array.from(root.querySelectorAll<SVGGElement>(`[data-fall="${key}"]`));
  // Each chute: its pool of falling coins, how many it drops, its mouth and where coin n lands.
  const mouth = CHUTE.bottom - COIN.h;
  const chutes = [
    ...line.benches.map((_, i) => ({ els: fallers(`b${i}`), count: coins.perBench[i], from: mouth, land: (n: number) => CUP.z + CUP.h + n * COIN.h })),
    { els: fallers("burn"), count: coins.burn, from: mouth + 4, land: () => TOP_Z[1] + 1.6 },
    { els: fallers("reserve"), count: coins.reserve, from: mouth + 4, land: () => TOP_Z[1] + 9 },
  ];
  const flight = root.querySelector<SVGGElement>("[data-flight]");
  const out = root.querySelector<SVGGElement>("[data-out]");
  const rest = geo.benches.map((b) => b.railStart + 4);
  const shuttleOffset = geo.benches.map((b) => b.railStart + 4);
  const k = scaleOf(geo.P);
  const write = (el: Element | null, attr: string, value: string | null) => {
    if (!el || el.getAttribute(attr) === value) return;
    if (value === null) el.removeAttribute(attr);
    else el.setAttribute(attr, value);
  };
  const show = (el: Element | null, on: boolean) => write(el, "style", on ? null : "display:none");

  const say = (text: string) => {
    if (readout && readout.textContent !== text) readout.textContent = text;
  };
  const benchName = (i: number) => `${line.benches[i].gpu} ${line.benches[i].memGb} GB`;

  const paint = (t: number) => {
    // shuttles and the token they carry
    line.benches.forEach((_, b) => {
      const s = shuttleAt(t, b, geo.stations, tl, rest[b]);
      write(shuttles[b], "transform", translateAlong(geo.P, [s.x - shuttleOffset[b], 0, 0]));
      write(tokens[b], "style", s.carrying ? null : "opacity:0");
    });
    // rams and lamps
    geo.stations.forEach((_, n) => {
      const drop = ramAt(t, n, tl, STAMP);
      write(rams[n], "transform", drop > 1e-3 ? translateAlong(geo.P, [0, 0, -drop]) : null);
      const stamped = stampedAt(t, n, tl) && t < tl.total - 0.6;
      write(lamps[n], "data-lit", stamped ? "" : null);
    });
    // the token in flight: over a cable between benches, or dropping into the gateway's tray
    let flying: [number, number] | null = null;
    line.benches.forEach((_, b) => {
      const u = b < geo.hops.length ? hopAt(t, b, tl) : null;
      if (u === null) return;
      const pts = geo.hops[b];
      const f = u * (pts.length - 1);
      const i = Math.min(pts.length - 2, Math.floor(f));
      const a = pts[i];
      const c = pts[i + 1];
      flying = [a[0] + (c[0] - a[0]) * (f - i), a[1] + (c[1] - a[1]) * (f - i)];
    });
    if (t >= tl.passEnd && t < tl.passEnd + 0.55) {
      const last = line.benches.length - 1;
      const from = iso([geo.stations[geo.stations.length - 1].x, 0, RAIL_Z[1] + 4], geo.P);
      const to = iso(geo.tray, geo.P);
      const u = (t - tl.passEnd) / 0.55;
      flying = [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u - Math.sin(Math.PI * u) * 22 * (k / 2)];
      void last;
    }
    if (flying) {
      const [fx, fy] = flying;
      write(flight, "transform", `translate(${fx.toFixed(2)} ${fy.toFixed(2)})`);
    }
    show(flight, Boolean(flying));
    show(out, t >= tl.passEnd + 0.55 && t < tl.total - 0.3);
    // coins: landed ones show in the stacks, falling ones ride a small pool at each chute's mouth
    chutes.forEach((chute, c) => {
      const { landed, falling } = coinsAt(t, tl, chute.count);
      if (c < stacks.length) stacks[c].forEach((el, n) => show(el, n < landed && t < tl.total - 0.3));
      chute.els.forEach((el, n) => {
        const f = falling[n];
        if (!f) return show(el, false);
        show(el, true);
        write(el, "transform", translateAlong(geo.P, [0, 0, -(chute.from - chute.land(f.index)) * f.u * f.u]));
      });
    });
    // readout from where the parts are
    const ph = phaseAt(t, geo.stations, tl);
    if (ph.kind === "pass") {
      const st = geo.stations[ph.station];
      const hopping = line.benches.some((_, b) => b < geo.hops.length && hopAt(t, b, tl) !== null);
      say(hopping ? `hop to ${benchName(st.bench)}` : `layer ${st.layer + 1} of ${TOTAL_LAYERS} · ${benchName(st.bench)}`);
    } else if (ph.kind === "out") say(`1 token out · ${line.tokS!.toFixed(1)} tok/s`);
    else say(`${line.nodesMc.map((mc) => credits(mc)).join(" · ")} cr · burn ${credits(line.burnMc)}`);
  };

  let t = 0;
  let last = 0;
  let frame = 0;
  let visible = false;
  const tick = (now: number) => {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    t = (t + dt) % tl.total;
    paint(t);
    frame = visible && !document.hidden && !still.matches ? requestAnimationFrame(tick) : 0;
  };
  const kick = () => {
    if (!frame && visible && !document.hidden && !still.matches) {
      last = 0;
      frame = requestAnimationFrame(tick);
    }
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  // Reduced motion: the finished state (every station stamped, the coins in their cups), still.
  const settle = () => paint(still.matches ? tl.payEnd + 0.01 : t);
  settle();
  const seen = new IntersectionObserver((entries) => {
    visible = Boolean(entries.at(-1)?.isIntersecting);
    if (visible) kick();
    else stop();
  }, { rootMargin: "120px 0px" });
  seen.observe(stage);
  const onVisibility = () => (document.hidden ? stop() : kick());
  const onStill = () => {
    settle();
    kick();
  };
  document.addEventListener("visibilitychange", onVisibility);
  still.addEventListener("change", onStill);
  return () => {
    stop();
    seen.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    still.removeEventListener("change", onStill);
  };
}

