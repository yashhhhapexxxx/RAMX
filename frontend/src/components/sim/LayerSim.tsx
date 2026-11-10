/* Layer split + query simulator. N laptops → the model's layers placed into pipeline stages by
   Parallax's own rules (lib/layers.ts parallaxPlacement) → one token travels stage by stage → the request settles with the real §8.3 rule
   (costMc / splitMc, the gateway's integer math) → the node owners' credits, and what they buy
   on a different pool. "Live pool" mode uses a real layer map from /network. */
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import type { NodeListing, PoolListing, RouteHop } from "@shared/types";
import config from "../../../../shared/config/ramx.config.json";
import { costMc, splitMc } from "../../lib/credits";
import { CHIPS, coversExactly, parallaxPlacement, stageGiB } from "../../lib/layers";
import { fmtLayers, fmtMc, fmtNum, gpuShort, nodeName } from "../../lib/format";

type Laptop = { id: string; name: string; gpu: string; mem: number; owner: string; chip: string };
type ModelCfg = (typeof config.models)[number];

const MEM_OPTIONS = [8, 12, 16, 18, 24, 32, 36, 48, 64];
const MAX_LAPTOPS = 8;
const HOP_MS = 520;
const short = (id: string) => id.split("/")[1] ?? id;
const letter = (i: number) => String.fromCharCode(65 + i);
const mkLaptop = (i: number, mem: number, chip = "M5"): Laptop => ({ id: `sim-${letter(i)}`, name: `Laptop ${letter(i)}`, gpu: "laptop", mem, owner: `owner-${letter(i)}`, chip });
/* the demo pool: four 16 GB Macs */
const START: Laptop[] = [mkLaptop(0, 16, "M4"), mkLaptop(1, 16, "M5"), mkLaptop(2, 16, "M5"), mkLaptop(3, 16, "M2")];

type Phase = { kind: "idle" } | { kind: "hop"; stage: number } | { kind: "settled" };
type Run = Phase & { key: string };

export default function LayerSim({ pools = [], nodes = [], preferLive = false }: { pools?: PoolListing[]; nodes?: NodeListing[]; preferLive?: boolean }) {
  const reduce = useReducedMotion();
  const livePools = pools.filter((p) => p.layer_map.length > 0);
  // Until the viewer picks, follow `preferLive` (live data usually arrives after the first render).
  const [picked, setMode] = useState<"sim" | "live" | null>(null);
  const mode = picked ?? (preferLive && livePools.length > 0 ? "live" : "sim");
  const [poolId, setPoolId] = useState<string>("");
  const [modelId, setModelId] = useState(config.models[config.models.length - 1].model_id);
  const [laptops, setLaptops] = useState<Laptop[]>(START);
  const [inTok, setInTok] = useState(400);
  const [outTok, setOutTok] = useState(256);
  const [you, setYou] = useState(0);
  const [selfRequest, setSelfRequest] = useState(false);
  const [runState, setRun] = useState<Run>({ kind: "idle", key: "" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const live = mode === "live" && livePools.length > 0;
  const pool = live ? (livePools.find((p) => p.pool_id === poolId) ?? livePools[0]) : undefined;

  /* ── the pool being shown: simulated laptops, or the live layer map ── */
  const view = (() => {
    if (pool) {
      const model = config.models.find((m) => m.model_id === pool.models[0]);
      const total = model?.num_layers ?? pool.layer_map.reduce((m, h) => Math.max(m, h.layers[1]), 0);
      const lap: Laptop[] = pool.layer_map.map((h) => {
        const n = nodes.find((x) => x.node_id === h.node_id);
        return { id: h.node_id, name: nodeName(n, h.node_id), gpu: n ? gpuShort(n.gpu) : "unlisted", mem: n?.mem_gb ?? 0, owner: n?.owner_account ?? `unknown-${h.node_id}`, chip: "" };
      });
      return { model, modelId: pool.models[0], total, sizeGb: model?.size_gb ?? 0, factor: model?.model_factor ?? 1, laptops: lap, route: pool.layer_map as RouteHop[] | null, fits: coversExactly(pool.layer_map, total), placement: null };
    }
    const model = config.models.find((m) => m.model_id === modelId) as ModelCfg;
    const placement = parallaxPlacement(laptops.map((l) => ({ id: l.id, memGb: l.mem, chip: l.chip })), model);
    return { model, modelId, total: model.num_layers, sizeGb: model.size_gb, factor: model.model_factor, laptops, route: placement?.pipelines[0] ?? null, fits: !!placement, placement };
  })();
  /* every stage of every pipeline (copies of the model), for the laptop cards */
  const hopOf = (id: string): { hop: RouteHop; copy: number } | undefined => {
    const pipes = view.placement?.pipelines ?? (view.route ? [view.route] : []);
    for (let c = 0; c < pipes.length; c++) {
      const hop = pipes[c].find((h) => h.node_id === id);
      if (hop) return { hop, copy: c };
    }
    return undefined;
  };

  const stages = view.route ?? [];
  const youIdx = Math.min(you, view.laptops.length - 1);
  const youLap = view.laptops[youIdx];
  const cost = costMc(view.factor, inTok, outTok);
  const split = splitMc(cost, view.route, view.total, (id) => selfRequest && view.laptops.find((l) => l.id === id)?.owner === youLap?.owner);
  const yourMc = split.nodes.filter((n) => view.laptops.find((l) => l.id === n.node_id)?.owner === youLap?.owner).reduce((a, n) => a + n.mc, 0);
  const pooledGb = view.laptops.reduce((a, l) => a + l.mem, 0);
  // A run belongs to one setup: change anything and it reads as idle again.
  const key = JSON.stringify([mode, pool?.pool_id, modelId, laptops, inTok, outTok, you, selfRequest]);
  const phase: Phase = runState.key === key ? runState : { kind: "idle" };
  const setPhase = (p: Phase) => setRun({ ...p, key });
  const settled = phase.kind === "settled";
  const activeStage = phase.kind === "hop" ? phase.stage : -1;

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  function run() {
    if (!stages.length) return;
    if (timer.current) clearTimeout(timer.current);
    if (reduce) return setPhase({ kind: "settled" });
    const step = (k: number) => {
      if (k >= stages.length) {
        setPhase({ kind: "settled" });
        return;
      }
      setPhase({ kind: "hop", stage: k });
      timer.current = setTimeout(() => step(k + 1), HOP_MS);
    };
    step(0);
  }

  const setMem = (i: number, mem: number) => setLaptops((ls) => ls.map((l, j) => (j === i ? { ...l, mem } : l)));
  const setChip = (i: number, chip: string) => setLaptops((ls) => ls.map((l, j) => (j === i ? { ...l, chip } : l)));
  const add = () => setLaptops((ls) => (ls.length >= MAX_LAPTOPS ? ls : [...ls, mkLaptop(ls.length, 16)]));
  const remove = () => setLaptops((ls) => (ls.length <= 1 ? ls : ls.slice(0, -1)));
  const stageOf = (id: string) => stages.findIndex((h) => h.node_id === id);
  const color = (_id: string, i: number) => BLUES[i % BLUES.length];

  return (
    <div className={`sim${settled ? " is-settled" : ""}${activeStage >= 0 ? " is-running" : ""}`}>
      <div className="sim-controls">
        <div className="tabs" role="radiogroup" aria-label="Pool source">
          <button role="radio" aria-checked={mode === "sim"} className={mode === "sim" ? "is-active" : ""} onClick={() => setMode("sim")}>
            Simulated pool
          </button>
          <button role="radio" aria-checked={mode === "live"} className={mode === "live" ? "is-active" : ""} onClick={() => setMode("live")} disabled={livePools.length === 0} title={livePools.length ? "Layer maps from the directory's pool listings" : "No pool with a layer map is listed right now"}>
            Live pool{livePools.length ? ` (${livePools.length})` : ""}
          </button>
        </div>

        {live ? (
          <label className="sim-field">
            <span>Pool</span>
            <select className="select" value={pool?.pool_id} onChange={(e) => setPoolId(e.target.value)}>
              {livePools.map((p) => (
                <option key={p.pool_id} value={p.pool_id}>
                  {p.pool_id} · {short(p.models[0])} · {p.layer_map.length} nodes
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="sim-field">
              <span>Model</span>
              <select className="select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                {config.models.map((m) => (
                  <option key={m.model_id} value={m.model_id}>
                    {short(m.model_id)} · {m.num_layers} layers · {m.size_gb} GB
                  </option>
                ))}
              </select>
            </label>
            <div className="sim-field">
              <span>Laptops</span>
              <div className="sim-stepper">
                <button className="icon-button" onClick={remove} disabled={laptops.length <= 1} aria-label="Remove a laptop">
                  −
                </button>
                <output aria-live="polite">{laptops.length}</output>
                <button className="icon-button" onClick={add} disabled={laptops.length >= MAX_LAPTOPS} aria-label="Add a laptop">
                  +
                </button>
              </div>
            </div>
          </>
        )}
        <label className="sim-field sim-range">
          <span>
            Prompt <b>{inTok}</b> tokens
          </span>
          <input type="range" min={0} max={2000} step={10} value={inTok} onChange={(e) => setInTok(+e.target.value)} />
        </label>
        <label className="sim-field sim-range">
          <span>
            Answer <b>{outTok}</b> tokens
          </span>
          <input type="range" min={1} max={2048} step={1} value={outTok} onChange={(e) => setOutTok(+e.target.value)} />
        </label>
      </div>

      {/* the model, split into pipeline stages */}
      <div className="sim-model">
        <div className="sim-model-head">
          <span className="sim-model-name">{short(view.modelId)}</span>
          <span className="faint">
            {view.total} layers · {view.sizeGb} GB of weights · {pooledGb} GB pooled across {view.laptops.length} {view.laptops.length === 1 ? "laptop" : "laptops"}
          </span>
        </div>
        <div className="sim-bar" role="img" aria-label={view.fits ? stages.map((h) => `${view.laptops.find((l) => l.id === h.node_id)?.name} layers ${h.layers[0]} to ${h.layers[1]}`).join(", then ") : "The pool cannot hold this model"}>
          {Array.from({ length: view.total }, (_, k) => {
            const s = stages.findIndex((h) => k >= h.layers[0] && k < h.layers[1]);
            const li = s >= 0 ? view.laptops.findIndex((l) => l.id === stages[s].node_id) : -1;
            return <i key={k} className={`sim-cell${s >= 0 && s === activeStage ? " is-hot" : ""}${s >= 0 && s < activeStage ? " is-done" : ""}`} style={li >= 0 ? { ["--c" as string]: color(view.laptops[li].id, li) } : undefined} />;
          })}
        </div>
        {!view.fits && (
          <p className="sim-warn" role="status">
            {live ? "This pool's layer map does not cover every layer exactly once, so the route is unknown and node shares go to the reserve." : `These laptops cannot hold ${short(view.modelId)} (about ${view.sizeGb} GB of weights): Parallax lets each laptop use about 65% of its memory for weights. Add a laptop or more memory.`}
          </p>
        )}
        {!live && view.placement && (
          <p className="faint sim-source" style={{ marginTop: 10 }}>
            Placed by Parallax's rules: as few stages as possible, layers in proportion to each chip's compute, capped by memory.
            {view.placement.equalSplit ? " Same-memory pool: every laptop gets an equal share (website onboarding rule)." : ""}
            {view.placement.pipelines.length > 1 ? ` ${view.placement.pipelines.length} full copies of the model; a request uses one.` : ""}
            {view.placement.standby.length ? ` ${view.placement.standby.length} ${view.placement.standby.length === 1 ? "laptop is not needed and waits" : "laptops are not needed and wait"} on standby.` : ""}
          </p>
        )}
      </div>

      {/* the laptops, in pipeline order */}
      <ol className="sim-laptops" style={{ ["--n" as string]: view.laptops.length }}>
        {activeStage >= 0 && (
          <span className="sim-token" aria-hidden="true" style={{ left: `${((view.laptops.findIndex((l) => l.id === stages[activeStage].node_id) + 0.5) / view.laptops.length) * 100}%` }} />
        )}
        {view.laptops.map((l, i) => {
          const s = stageOf(l.id);
          const placed = hopOf(l.id);
          const hop = placed?.hop;
          const n = hop ? hop.layers[1] - hop.layers[0] : 0;
          const usedGb = hop ? stageGiB(view.modelId, view.sizeGb, view.total, hop) : 0;
          const share = split.nodes.find((x) => x.node_id === l.id);
          const isYou = i === youIdx;
          return (
            <li key={l.id} style={{ ["--c" as string]: color(l.id, i), ["--i" as string]: i }} className={`sim-laptop${s === activeStage ? " is-hot" : ""}${s >= 0 && s < activeStage ? " is-done" : ""}${isYou ? " is-you" : ""}`}>
              <div className="sim-screen">
                <span className="sim-layers">{hop ? `${placed && placed.copy > 0 ? `copy ${placed.copy + 1} · ` : ""}${fmtLayers(hop.layers)}` : live ? "no layers" : "standby"}</span>
                <span className="sim-count">{n} layers</span>
              </div>
              <div className="sim-base" aria-hidden="true" />
              <span className="sim-name">{l.name}</span>
              {live ? (
                <span className="faint sim-sub">{l.mem ? `${l.mem} GB` : "no listing"}</span>
              ) : (
                <>
                <label className="sim-mem">
                  <span className="sr-only">Chip of {l.name}</span>
                  <select className="select" value={l.chip} onChange={(e) => setChip(i, e.target.value)}>
                    {CHIPS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="sim-mem">
                  <span className="sr-only">Memory of {l.name}</span>
                  <select className="select" value={l.mem} onChange={(e) => setMem(i, +e.target.value)}>
                    {MEM_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m} GB
                      </option>
                    ))}
                  </select>
                </label>
                </>
              )}
              {l.mem > 0 && (
                <span className="sim-membar" title={`${fmtNum(usedGb, 1)} of ${l.mem} GB used by weights`}>
                  <i style={{ width: `${Math.min(100, (usedGb / l.mem) * 100)}%` }} />
                </span>
              )}
              <span className="sim-earn" aria-live="polite">
                {share?.self ? "0 cr · own request" : share ? `+${fmtMc(share.mc)} cr` : "—"}
              </span>
              <button className={`sim-you${isYou ? " is-on" : ""}`} onClick={() => setYou(i)} aria-pressed={isYou}>
                {isYou ? "your laptop" : "make mine"}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="sim-run">
        <button className="button button-blue" onClick={run} disabled={!view.fits || activeStage >= 0}>
          {activeStage >= 0 ? `Stage ${activeStage + 1} of ${stages.length}…` : settled ? "Send another query" : "Send a query"}
        </button>
        <label className="sim-check">
          <input type="checkbox" checked={selfRequest} onChange={(e) => setSelfRequest(e.target.checked)} />
          <span>The query comes from you, the owner of {youLap?.name ?? "your laptop"}</span>
        </label>
      </div>

      {/* the settlement, with the real numbers */}
      <div className="sim-ledger">
        <div className="sim-cost">
          <span className="faint">Cost</span>
          <p className="sim-formula">
            <b>{fmtMc(cost)} credits</b>
          </p>
          <div className="sim-split" aria-label="Split of this request">
            <span style={{ flex: split.nodes.reduce((a, n) => a + n.mc, 0) || 0.0001 }} className="sim-split-nodes">
              nodes {fmtMc(split.nodes.reduce((a, n) => a + n.mc, 0))}
            </span>
            <span style={{ flex: split.burn_mc || 0.0001 }} className="sim-split-burn">
              burn {fmtMc(split.burn_mc)}
            </span>
            <span style={{ flex: split.reserve_mc || 0.0001 }} className="sim-split-reserve">
              reserve {fmtMc(split.reserve_mc)}
            </span>
          </div>
        </div>
        <div className={`sim-loop${settled ? " is-on" : ""}`}>
          <span className="faint">You earn</span>
          {selfRequest ? (
            <p>
              <b>0 credits</b> <span className="faint">· own request</span>
            </p>
          ) : (
            <p>
              <b>+{fmtMc(yourMc)} credits</b> <span className="faint">· {youLap?.name ?? "your laptop"}</span>
            </p>
          )}
        </div>
      </div>
      {live && <p className="faint sim-source">Source: directory pool listing {pool?.pool_id}. Memory and GPU come from each node's own listing.</p>}
    </div>
  );
}

/* the landing's blues: neighbouring laptops alternate light/dark blue; the active stage lights up pale (sim.css) */
const BLUES = ["#5aa6ff", "#2f6fbf", "#8cc4f7", "#24508a", "#4a90e2", "#386cb0", "#6aaef5", "#2a5c9c"];
