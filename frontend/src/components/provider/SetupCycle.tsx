import { useEffect, useState } from "react";

/** Animated pentagon of the five setup steps (decorative; the pool card shows real progress). */
const STEPS = [
  { title: "Verify identity", note: "World ID · one human, one account" },
  { title: "Join or create pool", note: "Start a crew or request a place" },
  { title: "Connect laptop", note: "One command in Terminal" },
  { title: "Prepare model", note: "Download weights, load layers" },
  { title: "Serve", note: "Answer requests, earn credits" },
];
/* the site's black-and-white scheme: one ink, the active and done steps lit, the rest dim */
const INK = "#f2f3f7", DIM = "#606879", MUTE = "#9297a6";
/* the landing's one accent: the active step and the path walked so far */
const ACCENT = "#278cff";
const W = 560, H = 470, CX = W / 2, CY = 240, R = 175;
const pts = STEPS.map((_, i) => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / STEPS.length;
  return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
});
const ring = `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L")} Z`;

/* 24×24 symbols, drawn centred on 0,0 */
function Symbol({ i }: { i: number }) {
  const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (i) {
    case 0: // shield + check
      return (
        <g {...s}>
          <path d="M0 -11 L9 -7.5 V0 C9 6 4.5 9.5 0 11 C-4.5 9.5 -9 6 -9 0 V-7.5 Z" />
          <path d="M-4 0 L-1 3 L4.5 -3" />
        </g>
      );
    case 1: // three linked circles
      return (
        <g {...s}>
          <circle cx="0" cy="-6" r="4" />
          <circle cx="-7" cy="5.5" r="4" />
          <circle cx="7" cy="5.5" r="4" />
          <path d="M-2 -2.5 L-5 2 M2 -2.5 L5 2 M-3 5.5 H3" />
        </g>
      );
    case 2: // laptop
      return (
        <g {...s}>
          <rect x="-9" y="-8" width="18" height="12" rx="1.5" />
          <path d="M-12 7.5 H12 L10 4 H-10 Z" />
          <path d="M-5 -3 L-2 -1 L-5 1 M0 1 H4" />
        </g>
      );
    case 3: // stacked layers
      return (
        <g {...s}>
          <path d="M0 -10 L11 -5 L0 0 L-11 -5 Z" />
          <path d="M-11 0 L0 5 L11 0" />
          <path d="M-11 5 L0 10 L11 5" />
        </g>
      );
    default: // bolt
      return (
        <g {...s}>
          <path d="M2 -11 L-7 2 H0 L-2 11 L7 -2 H0 Z" />
        </g>
      );
  }
}

export default function SetupCycle() {
  const [active, setActive] = useState(0);
  const [still, setStill] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const reduce = !!mq?.matches;
    setStill(reduce);
    if (reduce) return;
    const t = window.setInterval(() => setActive((a) => (a + 1) % STEPS.length), 1800);
    return () => window.clearInterval(t);
  }, []);
  const cur = STEPS[active];

  return (
    <div className="setup-cycle">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Setup in five steps: verify identity, join or create a pool, connect your laptop, prepare the model, serve">
        <defs>
          <radialGradient id="sc-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <path id="sc-path" d={ring} />
        </defs>

        {/* outer rotating rings */}
        <g className={still ? "" : "sc-spin"} style={{ transformOrigin: `${CX}px ${CY}px` }}>
          <circle cx={CX} cy={CY} r={R + 46} fill="none" stroke={INK} strokeOpacity="0.25" strokeDasharray="1 10" strokeWidth="2" />
        </g>
        <g className={still ? "" : "sc-spin-rev"} style={{ transformOrigin: `${CX}px ${CY}px` }}>
          <circle cx={CX} cy={CY} r={R - 62} fill="none" stroke={INK} strokeOpacity="0.15" strokeDasharray="40 14 4 14" />
        </g>

        {/* faint lift behind the readout */}
        <circle cx={CX} cy={CY} r="120" fill="url(#sc-core)" className={still ? "" : "sc-breathe"} style={{ transformOrigin: `${CX}px ${CY}px` }} />

        {/* pentagon edges: base + flowing dashes */}
        <path d={ring} fill="none" stroke={DIM} strokeOpacity="0.5" strokeWidth="1.5" />
        <path d={ring} fill="none" stroke={DIM} strokeWidth="1.5" strokeDasharray="6 10" className={still ? "" : "sc-flow"} />
        {/* completed edges up to the active step */}
        {pts.map((p, i) => {
          if (i >= active) return null;
          const q = pts[i + 1];
          return <line key={`e${i}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={ACCENT} strokeWidth="2" strokeLinecap="round" opacity="0.9" />;
        })}

        {/* spokes to centre */}
        {pts.map((p, i) => (
          <line key={`s${i}`} x1={CX} y1={CY} x2={p.x} y2={p.y} stroke={i === active ? ACCENT : INK} strokeOpacity={i === active ? 0.45 : 0.08} strokeWidth={i === active ? 1.4 : 1} className="sc-spoke" />
        ))}

        {/* comet running round the pentagon */}
        {!still && (
          <g>
            {[0, 0.12, 0.24].map((lag, k) => (
              <circle key={k} r={6 - k * 1.8} fill="#ffffff" opacity={1 - k * 0.3}>
                <animateMotion dur="9s" repeatCount="indefinite" begin={`-${lag}s`} rotate="auto">
                  <mpath href="#sc-path" />
                </animateMotion>
              </circle>
            ))}
          </g>
        )}

        {/* step nodes */}
        {pts.map((p, i) => {
          const on = i === active;
          const done = i < active;
          const s = STEPS[i];
          const below = p.y > CY + 10;
          return (
            <g key={s.title} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} className={`sc-node${on ? " is-on" : ""}`} style={{ color: on || done ? INK : MUTE }}>
              {on && !still && <circle r="44" fill="none" stroke={ACCENT} strokeWidth="1.2" className="sc-ping" />}
              <circle r="36" fill={on ? ACCENT : INK} fillOpacity={on ? 0.12 : 0.02} />
              <circle r="29" fill="#070a12" stroke={on ? ACCENT : done ? INK : DIM} strokeWidth={on ? 2 : 1.4} />
              <g transform={on ? "scale(1.25)" : "scale(1.05)"} className="sc-symbol">
                <Symbol i={i} />
              </g>
              <text y={below ? 56 : -46} textAnchor="middle" className="sc-label" fill={on ? "#ffffff" : "#aab2c3"}>
                {s.title}
              </text>
              <text y={below ? 74 : -64} textAnchor="middle" className="sc-num" fill={MUTE}>
                {String(i + 1).padStart(2, "0")}
              </text>
            </g>
          );
        })}

        {/* centre readout */}
        <text x={CX} y={CY - 14} textAnchor="middle" className="sc-center-num" fill={ACCENT}>
          STEP {String(active + 1).padStart(2, "0")} / 05
        </text>
        <text x={CX} y={CY + 14} textAnchor="middle" className="sc-center-title" fill="#ffffff" key={`t${active}`}>
          {cur.title}
        </text>
        <text x={CX} y={CY + 38} textAnchor="middle" className="sc-center-note" fill="#9aa3b5" key={`n${active}`}>
          {cur.note}
        </text>
      </svg>
    </div>
  );
}
