import { useRef } from "react";
import type { ReactNode } from "react";
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";
import {
  ARI,
  BALANCE,
  BURN,
  C,
  COORD,
  COST,
  EDGES,
  HOLD,
  IN_TOK,
  MAX_CREDITS,
  MODEL,
  NODES,
  OUT_TOK,
  POD,
  POOLED_GB,
  RESERVE,
  SPOKES,
  TOK_S,
  VB_H,
  VB_W,
  WINDOWS,
  ariToCoord,
  creditsFor,
  curvePath,
  layersOf,
  requestPoint,
} from "./stage";
import type { StoryNode } from "./stage";

/* ════════════════════════════════════════════════════════════════════════
   How it works: a pinned scroll story, adapted from the omniverse docs
   ScrollStory (sticky stage + crossfading captions + phase chip + HUD + rail).
   Five chapters: a three-laptop pool → a new computer asks → the coordinator
   routes the query → tokens pay for it → the coordinator splits them by compute.
   The three laptops are illustrative; live pools can have any number of nodes
   (see LayerSim and /network).
   ════════════════════════════════════════════════════════════════════════ */

type Chapter = {
  phase: string;
  title: string;
  body: ReactNode;
  foot: string;
};

const CHAPTERS: Chapter[] = [
  {
    phase: "01 — THE POOL",
    title: "Three laptops, one pool.",
    body: "None of these laptops can run the model alone. Parallax gives each one a slice of layers that fits its memory, and they pass work around the ring like one machine.",
    foot: `Parallax · ${MODEL.id} · ${MODEL.layers} layers over 8 + 16 + 16 GB`,
  },
  {
    phase: "02 — A NEW COMPUTER",
    title: "A new computer asks.",
    body: "Someone outside the pool sends a prompt. They don’t need a GPU. They need credits on their account, an API key, or an agent that pays per request with x402.",
    foot: "OpenAI-compatible API · browser, app or agent",
  },
  {
    phase: "03 — THE COORDINATOR ROUTES",
    title: "The coordinator routes it.",
    body: "The coordinator is the gateway. It picks this pool from its directory, hands the prompt to the first laptop, and streams the answer back as it leaves the last one.",
    foot: "gateway · route captured per request · tok/s measured",
  },
  {
    phase: "04 — TOKENS IN",
    title: "Tokens pay for the work.",
    body: "Before the run, the coordinator holds the maximum cost. After it, it settles the real cost from the tokens in and out and gives the rest back.",
    foot: "hold → settle · (out + 0.2 × in) × model factor",
  },
  {
    phase: "05 — SPLIT BY COMPUTE",
    title: "Split by compute.",
    body: "The coordinator gives 90% of the cost to the laptops by the layers each one served. More work, bigger share. 5% is burned, 5% goes to the reserve, and the receipt goes to the NEAR ledger.",
    foot: "spec §8 · 90 / 5 / 5 · ledger request_settled",
  },
];

const fmt = (v: number, d = 1) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: StoryNode) => `${((layersOf(n) / MODEL.layers) * 100).toFixed(1)}%`;

/* ── caption card (omniverse docs.tsx Caption) ─────────────────────────── */
function Caption({ t, win, num, chapter }: { t: MotionValue<number>; win: [number, number, number, number]; num: string; chapter: Chapter }) {
  const opacity = useTransform(t, win, [0, 1, 1, 0]);
  const y = useTransform(t, win, [28, 0, 0, -18]);
  return (
    <motion.div style={{ opacity, y }} className="story-caption">
      <p className="story-caption-num">{num}</p>
      <h3>{chapter.title}</h3>
      <p>{chapter.body}</p>
      <p className="story-caption-foot">{chapter.foot}</p>
    </motion.div>
  );
}

/* ── one laptop on the stage ───────────────────────────────────────────── */
function Laptop({ n, i, t }: { n: StoryNode; i: number; t: MotionValue<number> }) {
  const requester = !n.layers;
  // ch 01: the pool forms (staggered) · ch 02: the new computer arrives
  // the pool is already on stage when the section scrolls in (no blank stage); the new computer arrives in ch 02
  const inA = requester ? 0.2 : -0.05;
  const inB = requester ? 0.26 : 0;
  const arrive = useTransform(t, [inA, inB], [0, 1]);
  const dx = useTransform(arrive, (a) => n.from[0] * (1 - a));
  const dy = useTransform(arrive, (a) => n.from[1] * (1 - a));
  // ch 01: memory fills as the layers load
  const loaded = layersOf(n) * MODEL.gbPerLayer;
  const memW = useTransform(t, [0.0 + i * 0.01, 0.06 + i * 0.01], [0, (loaded / n.memGb) * 72]);
  const memText = useTransform(memW, (w) => `${fmt((w / 72) * n.memGb)} / ${n.memGb} GB`);
  const layerO = useTransform(t, requester ? [0.24, 0.27] : [-0.05, 0], [0, 1]);
  const healthO = useTransform(t, [-0.05, 0], [0, 1]);
  // ch 05: credits earned for this request, by layers served
  const credits = creditsFor(n);
  const earnW = useTransform(t, [0.89 + i * 0.012, 0.94 + i * 0.012], [0, (credits / MAX_CREDITS) * 92]);
  const earnText = useTransform(earnW, (w) => `+${fmt((w / 92) * MAX_CREDITS)} cr`);
  const earnO = useTransform(t, [0.86, 0.88], [0, 1]);

  return (
    <motion.g style={{ opacity: arrive, x: dx, y: dy }}>
      <g transform={`translate(${n.x} ${n.y})`}>
        {!requester && <motion.circle r={60} fill="none" stroke={n.color} strokeWidth={1} className="story-pulse" style={{ opacity: healthO }} />}
        {/* screen + base */}
        <rect x={-48} y={-36} width={96} height={60} rx={7} fill="#070b14" stroke={n.color} strokeWidth={1.4} strokeDasharray={requester ? "4 3" : undefined} />
        <path d="M-58 28h116l-8 8h-100z" fill="#0b111d" stroke={n.color} strokeWidth={1.2} strokeLinejoin="round" />
        <text y={-18} textAnchor="middle" className="story-svg-name" fill={n.color}>
          {n.name}
        </text>
        {/* memory bar (pool nodes) */}
        {!requester && (
          <g>
            <rect x={-36} y={-6} width={72} height={6} rx={3} fill="rgba(255,255,255,0.07)" />
            <motion.rect x={-36} y={-6} height={6} rx={3} width={memW} fill={n.color} />
            <motion.text y={12} textAnchor="middle" className="story-svg-micro" fill={C.mut}>
              {memText}
            </motion.text>
          </g>
        )}
        {requester && (
          <text y={6} textAnchor="middle" className="story-svg-micro" fill={C.mut}>
            browser · agent
          </text>
        )}
        {/* labels under the laptop */}
        <motion.text y={54} textAnchor="middle" className="story-svg-label" fill={C.mut} style={{ opacity: layerO }}>
          {n.gpu}
        </motion.text>
        {!requester && (
          <motion.text y={70} textAnchor="middle" className="story-svg-label" fill={n.color} style={{ opacity: layerO }}>
            layers [{n.layers![0]}–{n.layers![1]})
          </motion.text>
        )}
        {!requester && (
          <motion.g style={{ opacity: earnO }}>
            <rect x={-46} y={80} width={92} height={5} rx={2.5} fill="rgba(255,255,255,0.07)" />
            <motion.rect x={-46} y={80} height={5} rx={2.5} width={earnW} fill={C.ok} />
            <motion.text y={100} textAnchor="middle" className="story-svg-micro" fill={C.ok}>
              {earnText}
            </motion.text>
          </motion.g>
        )}
      </g>
    </motion.g>
  );
}

/* ── the pool talking: packets run along the triangle on a clock, not on scroll (ch 01–02, 04–05) ── */
function Chatter({ t }: { t: MotionValue<number> }) {
  const o = useTransform(t, [-0.05, 0, 0.4, 0.43, 0.6, 0.64], [0, 0.85, 0.85, 0, 0, 0.45]);
  return (
    <motion.g style={{ opacity: o }}>
      {EDGES.map((e, k) =>
        [0, 1].map((dir) => (
          <circle key={`${k}-${dir}`} r={3} fill={C.white} fillOpacity={0.8}>
            <animateMotion
              dur={`${2.2 + k * 0.35}s`}
              begin={`${dir * 1.1 + k * 0.4}s`}
              repeatCount="indefinite"
              path={curvePath(e)}
              keyPoints={dir ? "1;0" : "0;1"}
              keyTimes="0;1"
              calcMode="linear"
            />
          </circle>
        )),
      )}
    </motion.g>
  );
}

/* ── a request packet on its round trip (ch 03) ───────────────────────── */
function Packet({ t, k }: { t: MotionValue<number>; k: number }) {
  const u = useTransform(t, (v) => {
    const p = Math.max(0, (v - 0.43) / 0.14) * 2 + k / 3;
    return p - Math.floor(p);
  });
  const cx = useTransform(u, (x) => requestPoint(x)[0]);
  const cy = useTransform(u, (x) => requestPoint(x)[1]);
  const o = useTransform(t, [0.43, 0.45, 0.55, 0.58], [0, 1, 1, 0]);
  return <motion.circle r={4.5} cx={cx} cy={cy} fill={C.white} style={{ opacity: o, filter: "drop-shadow(0 0 5px rgba(255,255,255,0.5))" }} />;
}

/* ── a coin flying between two points (ch 04–05) ───────────────────────── */
function Coin({
  t,
  from,
  to,
  win,
  label,
  r = 9,
  color = C.warn,
  arc = 40,
}: {
  t: MotionValue<number>;
  from: [number, number];
  to: [number, number];
  win: [number, number];
  label: string;
  r?: number;
  color?: string;
  arc?: number;
}) {
  const f = useTransform(t, win, [0, 1]);
  const cx = useTransform(f, (v) => from[0] + (to[0] - from[0]) * v);
  const cy = useTransform(f, (v) => from[1] + (to[1] - from[1]) * v - Math.sin(v * Math.PI) * arc);
  const ty = useTransform(cy, (y) => y + 3.5);
  const o = useTransform(t, [win[0] - 0.01, win[0], win[1], win[1] + 0.012], [0, 1, 1, 0]);
  return (
    <motion.g style={{ opacity: o }}>
      <motion.circle r={r} cx={cx} cy={cy} fill="#0b111d" stroke={color} strokeWidth={1.4} />
      <motion.text x={cx} y={ty} textAnchor="middle" className="story-svg-badge" fill={color}>
        {label}
      </motion.text>
    </motion.g>
  );
}

/* ── speech bubble above the new computer (ch 02–03) ───────────────────── */
function Bubble({ t, win, text, typeWin, color }: { t: MotionValue<number>; win: [number, number, number, number]; text: string; typeWin?: [number, number]; color: string }) {
  const o = useTransform(t, win, [0, 1, 1, 0]);
  const typed = useTransform(t, typeWin ?? [win[0], win[1]], [typeWin ? 0 : text.length, text.length]);
  const shown = useTransform(typed, (v) => text.slice(0, Math.round(v)));
  const w = text.length * 7.3 + 28;
  return (
    <motion.g style={{ opacity: o }}>
      <rect x={ARI.x - w / 2} y={ARI.y - 104} width={w} height={32} rx={9} fill="#070a12" stroke={color} />
      <path d={`M${ARI.x - 7} ${ARI.y - 72.5}l7 9 7-9`} fill="#070a12" stroke={color} strokeLinejoin="round" />
      <motion.text x={ARI.x - w / 2 + 14} y={ARI.y - 84} className="story-svg-code" fill={C.text}>
        {shown}
      </motion.text>
    </motion.g>
  );
}

function Hud({ t }: { t: MotionValue<number> }) {
  const o = useTransform(t, [-0.05, 0], [0, 1]);
  const mem = useTransform(t, [0, 0.07], [0, POOLED_GB]);
  const memText = useTransform(mem, (v) => (v < 0.5 ? "—" : `${Math.round(v)} GB`));
  const layers = useTransform(t, [0, 0.07], [0, MODEL.layers]);
  const layersText = useTransform(layers, (v) => (v < 0.5 ? "—" : `${Math.round(v)} / ${MODEL.layers} placed`));
  const coord = useTransform(t, (v): string =>
    v < 0.4 ? "idle" : v < 0.6 ? "routing" : v < 0.72 ? "holding" : v < 0.84 ? "settled" : v < 0.95 ? "splitting" : "● paid",
  );
  const coordColor = useTransform(t, (v): string => (v < 0.4 ? C.mut : v < 0.95 ? C.warn : C.ok));
  const toks = useTransform(t, [0.45, 0.5], [0, TOK_S]);
  const toksText = useTransform(toks, (v) => (v < 0.05 ? "—" : `${v.toFixed(1)} tok/s`));
  const bal = useTransform(t, [0.62, 0.66, 0.73, 0.77], [BALANCE, BALANCE - HOLD, BALANCE - HOLD, BALANCE - COST]);
  const balText = useTransform([t, bal], ([v, b]: number[]) => (v < 0.22 ? "—" : `${fmt(b)} cr`));
  const earned = useTransform(t, [0.89, 0.964], [0, COST * 0.9]);
  const earnedText = useTransform(earned, (v) => (v < 0.05 ? "—" : `${fmt(v)} cr`));
  return (
    <motion.div style={{ opacity: o }} className="story-hud">
      <div>
        <span>nodes</span>
        <span>3 online</span>
      </div>
      <div>
        <span>pooled mem</span>
        <motion.span>{memText}</motion.span>
      </div>
      <div>
        <span>layers</span>
        <motion.span>{layersText}</motion.span>
      </div>
      <div>
        <span>coordinator</span>
        <motion.span style={{ color: coordColor }}>{coord}</motion.span>
      </div>
      <div className="story-hud-split">
        <span>throughput</span>
        <motion.span>{toksText}</motion.span>
      </div>
      <div>
        <span>Ari balance</span>
        <motion.span>{balText}</motion.span>
      </div>
      <div>
        <span>nodes earned</span>
        <motion.span className="story-hud-ok">{earnedText}</motion.span>
      </div>
    </motion.div>
  );
}

/** The coordinator chip in the middle of the pool (ch 03–05). */
function Coordinator({ t }: { t: MotionValue<number> }) {
  const o = useTransform(t, [0.4, 0.43], [0, 1]);
  const s = useTransform(t, [0.4, 0.43], [0.6, 1]);
  const ring = useTransform(t, [0.42, 0.45, 0.56, 0.6, 0.83, 0.86, 0.94, 0.97], [0, 1, 1, 0.25, 0.25, 1, 1, 0.25]);
  // the pot it holds: hold → settle → paid out to the nodes
  const pot = useTransform(t, [0.62, 0.66, 0.72, 0.74, 0.86, 0.95], [0, HOLD, HOLD, COST, COST, 0]);
  const potText = useTransform(pot, (v) => `holding ${fmt(v)} cr`);
  const potO = useTransform(t, [0.62, 0.64, 0.95, 0.97], [0, 1, 1, 0]);
  const w = 164;
  return (
    <motion.g style={{ opacity: o, scale: s }}>
      <motion.circle cx={COORD[0]} cy={COORD[1]} r={56} fill="none" stroke="rgba(242,243,247,0.5)" strokeWidth={1} className="story-pulse" style={{ opacity: ring }} />
      <rect x={COORD[0] - w / 2} y={COORD[1] - 22} width={w} height={44} rx={22} fill={C.bg} stroke={C.white} />
      <text x={COORD[0]} y={COORD[1] - 2} textAnchor="middle" className="story-svg-code" fill={C.text}>
        COORDINATOR
      </text>
      <text x={COORD[0]} y={COORD[1] + 13} textAnchor="middle" className="story-svg-micro" fill={C.mut}>
        gateway · Hedy
      </text>
      <motion.text x={COORD[0]} y={COORD[1] + 40} textAnchor="middle" className="story-svg-micro" fill={C.warn} style={{ opacity: potO }}>
        {potText}
      </motion.text>
    </motion.g>
  );
}

/** Top band text card (route ch 03, cost ch 04, receipt ch 05). */
function TopCard({ t, win, children }: { t: MotionValue<number>; win: [number, number, number, number]; children: ReactNode }) {
  const o = useTransform(t, win, [0, 1, 1, 0]);
  const y = useTransform(t, [win[0], win[1]], [-10, 0]);
  return (
    <motion.g style={{ opacity: o, y }}>
      <rect x={250} y={8} width={500} height={56} rx={8} fill="#070a12" stroke={C.line} />
      {children}
    </motion.g>
  );
}

/** A burn / reserve pill that peels off the coordinator (ch 05). */
function Peel({ t, x, label, color, delay }: { t: MotionValue<number>; x: number; label: string; color: string; delay: number }) {
  const f = useTransform(t, [0.9 + delay, 0.935 + delay], [0, 1]);
  const o = useTransform(t, [0.9 + delay, 0.91 + delay], [0, 1]);
  const px = useTransform(f, (v) => (x - COORD[0]) * v);
  const py = useTransform(f, (v) => 178 * v);
  return (
    <motion.g style={{ opacity: o, x: px, y: py }}>
      <rect x={COORD[0] - 44} y={COORD[1] - 10} width={88} height={20} rx={10} fill={C.bg} stroke={color} />
      <text x={COORD[0]} y={COORD[1] + 3.5} textAnchor="middle" className="story-svg-micro" fill={color}>
        {label}
      </text>
    </motion.g>
  );
}

function Stage({ t }: { t: MotionValue<number> }) {
  /* ch 01: the pool ring + the triangle */
  const ringP = useTransform(t, [-0.05, 0], [0, 1]);
  const ringO = useTransform(t, [-0.05, 0], [0, 0.9]);
  const edgeP = useTransform(t, [-0.05, 0], [0, 1]);
  const edgeColor = useTransform(t, [0.41, 0.44, 0.56, 0.6], [C.edge, C.white, C.white, C.edge]);

  /* ch 03 + ch 05: coordinator spokes */
  const spokeP = useTransform(t, [0.42, 0.46], [0, 1]);
  const spokeO = useTransform(t, [0.42, 0.44, 0.58, 0.62, 0.83, 0.86], [0, 0.9, 0.9, 0.3, 0.3, 1]);
  const shareO = useTransform(t, [0.84, 0.87], [0, 1]);
  const ariLinkO = useTransform(t, [0.42, 0.44, 0.78, 0.82], [0, 0.8, 0.8, 0]);

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid meet" className="story-svg" aria-hidden="true">
      <defs>
        <radialGradient id="story-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.04" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={POD.x} cy={POD.y} r={290} fill="url(#story-glow)" />

      {/* pool ring (ch 01) */}
      <motion.circle cx={POD.x} cy={POD.y} r={POD.r} fill="none" stroke="rgba(242,243,247,0.35)" strokeWidth={1} strokeDasharray="3 7" style={{ pathLength: ringP, opacity: ringO, rotate: -90 }} />

      {/* triangle: the laptops talking (ch 01), lit while the query runs (ch 03) */}
      {EDGES.map((e, i) => (
        <motion.path key={i} d={curvePath(e)} fill="none" stroke={edgeColor} strokeWidth={2} strokeLinecap="round" style={{ pathLength: edgeP }} />
      ))}
      <Chatter t={t} />

      {/* coordinator spokes + compute shares (ch 03, ch 05) */}
      {SPOKES.map((s, i) => (
        <motion.line key={i} x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]} stroke={NODES[i].color} strokeWidth={1.2} strokeDasharray="3 5" style={{ pathLength: spokeP, opacity: spokeO }} />
      ))}
      {/* each laptop's measured share of the work, beside it (left laptop: left side) */}
      {NODES.map((n) => {
        const cx = n.x < COORD[0] ? n.x - 124 : n.x + 124;
        return (
          <motion.g key={n.key} style={{ opacity: shareO }}>
            <rect x={cx - 58} y={n.y - 11} width={116} height={22} rx={11} fill={C.bg} stroke={n.color} />
            <text x={cx} y={n.y + 3.5} textAnchor="middle" className="story-svg-micro" fill={n.color}>
              {layersOf(n)} layers · {pct(n)}
            </text>
          </motion.g>
        );
      })}

      {/* the link from the new computer to the coordinator (ch 03–04) */}
      <motion.line
        x1={ariToCoord(0)[0]}
        y1={ariToCoord(0)[1]}
        x2={ariToCoord(1)[0]}
        y2={ariToCoord(1)[1]}
        stroke={ARI.color}
        strokeWidth={1.2}
        strokeDasharray="3 5"
        style={{ opacity: ariLinkO }}
      />

      {/* laptops: the pool, then the new computer */}
      {NODES.map((n, i) => (
        <Laptop key={n.key} n={n} i={i} t={t} />
      ))}
      <Laptop n={ARI} i={3} t={t} />

      <Coordinator t={t} />

      {/* the prompt and the answer (ch 02–03) */}
      <Bubble t={t} win={[0.26, 0.27, 0.48, 0.51]} typeWin={[0.27, 0.34]} text="> explain x402 in one line" color={ARI.color} />
      <Bubble t={t} win={[0.52, 0.55, 0.62, 0.65]} text="pay per HTTP request ✓" color={C.white} />

      {/* query packets: Ari → coordinator → Rex → Mika → Nova → coordinator → Ari (ch 03) */}
      {[0, 1, 2].map((k) => (
        <Packet key={k} k={k} t={t} />
      ))}

      {/* tokens in: Ari pays the hold, then gets the change back (ch 04) */}
      {[0, 1, 2].map((k) => (
        <Coin key={k} t={t} from={ariToCoord(0)} to={ariToCoord(1)} win={[0.62 + k * 0.018, 0.66 + k * 0.018]} label="cr" />
      ))}
      <Coin t={t} from={ariToCoord(1)} to={ariToCoord(0)} win={[0.73, 0.77]} label="↩" color={C.ok} arc={-30} />

      {/* the split: one coin per laptop, sized by its share of the work (ch 05) */}
      {NODES.map((n, i) => (
        <Coin
          key={n.key}
          t={t}
          from={SPOKES[i].a}
          to={SPOKES[i].b}
          win={[0.87 + i * 0.012, 0.91 + i * 0.012]}
          label="cr"
          r={7 + 6 * Math.sqrt(creditsFor(n) / MAX_CREDITS)}
          color={n.color}
          arc={24}
        />
      ))}
      <Peel t={t} x={COORD[0] - 50} label={`burn ${fmt(BURN)}`} color={C.bad} delay={0} />
      <Peel t={t} x={COORD[0] + 50} label={`reserve ${fmt(RESERVE)}`} color={C.mut} delay={0.008} />

      {/* route (ch 03) */}
      <TopCard t={t} win={[0.44, 0.47, 0.55, 0.58]}>
        <text x={266} y={30} className="story-svg-code" fill={C.mut}>
          <tspan fill={C.ok}>route</tspan> Ari → coordinator → pool-1 · {TOK_S} tok/s
        </text>
        <text x={266} y={50} className="story-svg-code" fill={C.mut}>
          {NODES.map((n, i) => (
            <tspan key={n.key} fill={n.color}>
              {n.name} [{n.layers![0]}–{n.layers![1]}){i < NODES.length - 1 ? " → " : ""}
            </tspan>
          ))}
        </text>
      </TopCard>

      {/* cost: hold → settle (ch 04) */}
      <CostCard t={t} />

      {/* receipt (ch 05) */}
      <TopCard t={t} win={[0.93, 0.95, 1.0, 1.1]}>
        <text x={266} y={30} className="story-svg-code" fill={C.mut}>
          <tspan fill={C.ok}>receipt</tspan> 7f3a…c2 · {IN_TOK} in / {OUT_TOK} out · {fmt(COST)} cr · ledger
        </text>
        <text x={266} y={50} className="story-svg-code" fill={C.mut}>
          {NODES.map((n, i) => (
            <tspan key={n.key} fill={n.color}>
              {n.name} {fmt(creditsFor(n))}
              {i < NODES.length - 1 ? " · " : ""}
            </tspan>
          ))}
          <tspan fill={C.faint}> · burn {fmt(BURN)} · reserve {fmt(RESERVE)}</tspan>
        </text>
      </TopCard>
    </svg>
  );
}

function CostCard({ t }: { t: MotionValue<number> }) {
  const costV = useTransform(t, [0.62, 0.66, 0.72, 0.74], [0, HOLD, HOLD, COST]);
  const costText = useTransform(costV, (v) => (v < 1 ? "—" : `${fmt(v)} cr`));
  const costLabel = useTransform(t, (v): string => (v < 0.73 ? "hold · max_tokens 2048" : `settled · (${OUT_TOK} out + 0.2 × ${IN_TOK} in) × 1.75`));
  return (
    <TopCard t={t} win={[0.61, 0.63, 0.77, 0.8]}>
      <motion.text x={266} y={30} className="story-svg-code" fill={C.mut}>
        {costLabel}
      </motion.text>
      <motion.text x={266} y={51} className="story-svg-name" fill={C.text}>
        {costText}
      </motion.text>
    </TopCard>
  );
}

function StaticStory() {
  return (
    <div className="story-static">
      {CHAPTERS.map((c, i) => (
        <div className="story-caption story-caption-static" key={c.phase}>
          <p className="story-caption-num">
            0{i + 1} / 0{CHAPTERS.length}
          </p>
          <h3>{c.title}</h3>
          <p>{c.body}</p>
          <p className="story-caption-foot">{c.foot}</p>
        </div>
      ))}
    </div>
  );
}

export default function PoolStory() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  // wheel steps → continuous glide; every transform inherits the smoothing.
  const t = useSpring(scrollYProgress, { stiffness: 110, damping: 28, restDelta: 0.0001 });
  const phaseText = useTransform(t, (v): string => {
    const i = WINDOWS.findIndex((w) => v < w[3]);
    return CHAPTERS[i === -1 ? CHAPTERS.length - 1 : i].phase;
  });

  if (reduce) return <StaticStory />;

  return (
    <div ref={ref} className="story">
      <div className="story-stage">
        <Stage t={t} />

        <div className="story-phase">
          <p>How it works</p>
          <motion.p className="story-phase-current">{phaseText}</motion.p>
        </div>

        <Hud t={t} />

        <div className="story-rail" aria-hidden="true">
          <motion.div style={{ scaleY: t }} />
        </div>

        {CHAPTERS.map((c, i) => (
          <Caption key={c.phase} t={t} win={WINDOWS[i]} num={`0${i + 1} / 0${CHAPTERS.length}`} chapter={c} />
        ))}
      </div>
    </div>
  );
}
