import { useEffect, useState } from "react";

/** Decorative live animation: laptops around a pool hub, with packets flowing through the pipeline. */
const COLORS = ["#278cff", "#a1d6ff", "#b4a0ed", "#8ecab3", "#5fb4ff"];
const W = 380, H = 300, CX = W / 2, CY = H / 2, R = 112;

export default function PoolOrbit() {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setStill(mq.matches);
    const on = () => setStill(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const nodes = COLORS.map((c, i) => {
    const a = (i / COLORS.length) * Math.PI * 2 - Math.PI / 2;
    return { c, x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
  });
  // Pipeline ring: node i → node i+1 (layers pass laptop to laptop), plus spokes to the hub.
  const ring = nodes.map((n, i) => {
    const m = nodes[(i + 1) % nodes.length];
    const mx = (n.x + m.x) / 2, my = (n.y + m.y) / 2;
    // bow each arc outward a little
    const bx = CX + (mx - CX) * 1.18, by = CY + (my - CY) * 1.18;
    return `M${n.x.toFixed(1)},${n.y.toFixed(1)} Q${bx.toFixed(1)},${by.toFixed(1)} ${m.x.toFixed(1)},${m.y.toFixed(1)}`;
  });

  return (
    <svg className="pool-orbit" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Illustration: laptops in a pool passing model layers to each other">
      <defs>
        <radialGradient id="po-hub" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#a1d6ff" stopOpacity="0.9" />
          <stop offset="55%" stopColor="#278cff" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#278cff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="po-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#278cff" />
          <stop offset="50%" stopColor="#b4a0ed" />
          <stop offset="100%" stopColor="#8ecab3" />
        </linearGradient>
        {COLORS.map((c, i) => (
          <linearGradient key={c} id={`po-scr-${i}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={c} stopOpacity="0.95" />
            <stop offset="100%" stopColor={COLORS[(i + 2) % COLORS.length]} stopOpacity="0.55" />
          </linearGradient>
        ))}
        <linearGradient id="po-metal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e9ecf2" />
          <stop offset="100%" stopColor="#7d828d" />
        </linearGradient>
        <filter id="po-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* slow rotating dashed orbit */}
      <g className={still ? "" : "po-spin"} style={{ transformOrigin: `${CX}px ${CY}px` }}>
        <circle cx={CX} cy={CY} r={R + 26} fill="none" stroke="url(#po-ring)" strokeOpacity="0.35" strokeDasharray="2 9" />
        <circle cx={CX} cy={CY} r={R - 30} fill="none" stroke="#a1d6ff" strokeOpacity="0.12" strokeDasharray="1 6" />
      </g>

      {/* spokes to the hub */}
      {nodes.map((n, i) => (
        <line key={`s${i}`} x1={CX} y1={CY} x2={n.x} y2={n.y} stroke={n.c} strokeOpacity="0.18" />
      ))}

      {/* pipeline arcs with flowing dashes */}
      {ring.map((d, i) => (
        <path key={`r${i}`} id={`po-arc-${i}`} d={d} fill="none" stroke={nodes[i].c} strokeOpacity="0.55" strokeWidth="1.4" strokeDasharray="4 6" className={still ? "" : "po-flow"} />
      ))}

      {/* packets travelling laptop → laptop */}
      {!still &&
        ring.map((_, i) => (
          <circle key={`p${i}`} r="3.8" fill={nodes[(i + 1) % nodes.length].c} filter="url(#po-glow)">
            <animateMotion dur="2.5s" repeatCount="indefinite" begin={`${i * 0.5}s`}>
              <mpath href={`#po-arc-${i}`} />
            </animateMotion>
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="2.5s" begin={`${i * 0.5}s`} repeatCount="indefinite" />
          </circle>
        ))}

      {/* hub */}
      <circle cx={CX} cy={CY} r="40" fill="url(#po-hub)" className={still ? "" : "po-breathe"} style={{ transformOrigin: `${CX}px ${CY}px` }} />
      <circle cx={CX} cy={CY} r="13" fill="#0b1630" stroke="#a1d6ff" strokeWidth="1.5" filter="url(#po-glow)" />
      <circle cx={CX} cy={CY} r="4" fill="#a1d6ff" />

      {/* computers: laptops and desktop monitors, each with a live colourful screen */}
      {nodes.map((n, i) => {
        const desktop = i % 2 === 1;
        const sw = desktop ? 40 : 38, sh = desktop ? 26 : 24;
        return (
          <g key={`n${i}`} transform={`translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`}>
            <circle r="30" fill={n.c} fillOpacity="0.1" className={still ? "" : "po-pulse"} style={{ animationDelay: `${i * 0.4}s` }} />
            {/* screen bezel */}
            <rect x={-sw / 2 - 3} y={-sh / 2 - 6} width={sw + 6} height={sh + 6} rx="3.5" fill="#15171c" stroke="url(#po-metal)" strokeWidth="1.2" />
            {/* screen */}
            <rect x={-sw / 2} y={-sh / 2 - 3} width={sw} height={sh} rx="1.5" fill={`url(#po-scr-${i})`} filter="url(#po-glow)" className={still ? "" : "po-screen"} style={{ animationDelay: `${i * 0.6}s` }} />
            {/* "code" lines scrolling on the screen */}
            <g opacity="0.85">
              {[0, 1, 2, 3].map((k) => (
                <rect key={k} x={-sw / 2 + 4} y={-sh / 2 + 1 + k * 5} height="2" rx="1" width={[24, 16, 28, 12][k] * (sw / 40)} fill="#0b0d12" fillOpacity="0.55" className={still ? "" : "po-code"} style={{ animationDelay: `${i * 0.3 + k * 0.25}s` }} />
              ))}
            </g>
            {/* camera dot */}
            <circle cx="0" cy={-sh / 2 - 4.5} r="0.9" fill="#9aa0ab" />
            {desktop ? (
              <>
                {/* monitor stand */}
                <rect x="-3" y={sh / 2} width="6" height="7" fill="url(#po-metal)" />
                <rect x="-12" y={sh / 2 + 7} width="24" height="3" rx="1.5" fill="url(#po-metal)" />
              </>
            ) : (
              <>
                {/* hinge + keyboard deck */}
                <path d={`M${-sw / 2 - 3} ${sh / 2} L${sw / 2 + 3} ${sh / 2} L${sw / 2 + 9} ${sh / 2 + 7} L${-sw / 2 - 9} ${sh / 2 + 7} Z`} fill="url(#po-metal)" />
                <rect x="-7" y={sh / 2 + 4.6} width="14" height="1.6" rx="0.8" fill="#4b505a" />
                {[-14, -8, -2, 4, 10].map((kx) => (
                  <rect key={kx} x={kx} y={sh / 2 + 1.4} width="4" height="1.4" rx="0.4" fill="#5b606b" />
                ))}
              </>
            )}
            {/* power LED */}
            <circle cx={sw / 2 - 2} cy={desktop ? sh / 2 + 3.5 : sh / 2 + 3.5} r="1.3" fill={n.c} className={still ? "" : "po-led"} style={{ animationDelay: `${i * 0.5}s` }} />
          </g>
        );
      })}
    </svg>
  );
}
