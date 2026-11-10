import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import AgentSprite from "./AgentSprite";
import { crew } from "../data/crew";
import type { AgentId, MissionPhase } from "../data/crew";

type Pose = { x: number; y: number; say?: string };
const homes: Record<AgentId, Pose> = {
  pip: { x: 16, y: 67 },
  milo: { x: 33, y: 74 },
  quil: { x: 50, y: 57 },
  iris: { x: 67, y: 74 },
  wren: { x: 84, y: 67 },
};
const poses: Partial<Record<MissionPhase, Partial<Record<AgentId, Pose>>>> = {
  introducing: {
    pip: { x: 24, y: 67, say: "Rex. 8 GB, ready." },
    milo: { x: 37, y: 73 },
    quil: { x: 50, y: 49, say: "Meet the pool." },
    iris: { x: 63, y: 73 },
    wren: { x: 76, y: 67 },
  },
  planning: {
    pip: { x: 28, y: 69 },
    milo: { x: 40, y: 75 },
    quil: { x: 50, y: 46, say: "Splitting Qwen3-14B." },
    iris: { x: 61, y: 75 },
    wren: { x: 73, y: 68 },
  },
  discovering: {
    pip: { x: 10, y: 54, say: "Layers 0–11 are mine." },
    milo: { x: 28, y: 72 },
    quil: { x: 49, y: 57 },
    iris: { x: 67, y: 71 },
    wren: { x: 85, y: 62 },
  },
  investigating: {
    pip: { x: 26, y: 57 },
    milo: { x: 39, y: 72, say: "11–31 here." },
    quil: { x: 52, y: 49 },
    iris: { x: 67, y: 63 },
    wren: { x: 85, y: 72 },
  },
  reviewing: {
    pip: { x: 27, y: 65 },
    milo: { x: 39, y: 72 },
    quil: { x: 57, y: 49 },
    iris: { x: 47, y: 63, say: "Settled. Split by layers." },
    wren: { x: 79, y: 69 },
  },
  writing: {
    pip: { x: 16, y: 69 },
    milo: { x: 32, y: 74 },
    quil: { x: 51, y: 52 },
    iris: { x: 68, y: 72 },
    wren: { x: 61, y: 58, say: "Receipt on the NEAR ledger." },
  },
  complete: {
    pip: { x: 23, y: 70 },
    milo: { x: 36, y: 74 },
    quil: { x: 50, y: 54, say: "Pool ready. Listed by the gateway." },
    iris: { x: 64, y: 74 },
    wren: { x: 77, y: 70 },
  },
};
/* Hanging badges (public/brand, drawn in one ink via CSS mask) for NEAR, USDC and the TEE judge above the crew (landing only); one lights up in the phase that talks about it. */
const HANGERS = [
  { id: "near", name: "NEAR", x: 20, len: 24 },
  { id: "usdc", name: "USDC", x: 50, len: 24 },
  { id: "tee", name: "TEE", x: 80, len: 24 },
];
/* Landing layout = the repo's architecture: the gateway (Hedy) coordinates everything.
   It talks to NEAR (login, ledger, payouts), USDC (x402 payments) and the TEE judge (spot-checks),
   and routes each request to a pool: Pod (Parallax scheduler) → Rex → Mika → Nova → back to the gateway. */
const GATEWAY = { x: 50, y: 47 };
const landingHomes: Record<AgentId, Pose> = {
  iris: GATEWAY,
  quil: { x: 17, y: 78 },
  pip: { x: 39, y: 80 },
  milo: { x: 61, y: 80 },
  wren: { x: 83, y: 78 },
};
const landingPoses: Partial<Record<MissionPhase, Partial<Record<AgentId, Pose>>>> = {
  introducing: { iris: { ...GATEWAY, say: "I’m the gateway. I talk to everything." } },
  planning: { iris: { ...GATEWAY, say: "NEAR wallet checked. Signed in." } },
  discovering: { iris: { ...GATEWAY, say: "Agent paid in USDC with x402." } },
  investigating: { quil: { x: 17, y: 78, say: "Routing: Rex → Mika → Nova." } },
  reviewing: { wren: { x: 83, y: 78, say: "Last layers done. Answer to the gateway." } },
  writing: { iris: { ...GATEWAY, say: "Receipt and split on the NEAR ledger." } },
  complete: { iris: { ...GATEWAY, say: "Spot-checked in a TEE. Laptops paid by layers." } },
};
/* svg coordinates (viewBox 1000 × 280). The badges hang in a band above the scene; their bottom edge is
   ≈ 14 px above the scene's top, so the spokes end just above y = 0 (the svg overflows on the landing). */
const BADGE_BOTTOM_VB = -12;
const gx = 500, gy = (GATEWAY.y / 100) * 280;
const badge = (id: string) => `${HANGERS.find((x) => x.id === id)!.x * 10} ${BADGE_BOTTOM_VB}`;
const at = (p: Pose) => `${p.x * 10} ${(p.y / 100) * 280}`;
const landingSignal: Partial<Record<MissionPhase, string>> = {
  introducing: `M${gx} ${gy} L${badge("near")} M${gx} ${gy} L${badge("usdc")} M${gx} ${gy} L${badge("tee")} M${gx} ${gy} L${at(landingHomes.quil)}`,
  planning: `M${gx} ${gy} L${badge("near")}`,
  discovering: `M${gx} ${gy} L${badge("usdc")}`,
  investigating: `M${gx} ${gy} L${at(landingHomes.quil)} L${at(landingHomes.pip)} L${at(landingHomes.milo)} L${at(landingHomes.wren)}`,
  reviewing: `M${at(landingHomes.wren)} L${gx} ${gy}`,
  writing: `M${gx} ${gy} L${badge("near")}`,
  complete: `M${gx} ${gy} L${badge("tee")}`,
};
/* which hanging badge the gateway is talking to in each phase */
const activeHanger: Partial<Record<MissionPhase, string>> = { planning: "near", discovering: "usdc", writing: "near", complete: "tee" };

const autoPhases: MissionPhase[] = [
  "idle",
  "introducing",
  "planning",
  "discovering",
  "investigating",
  "reviewing",
  "writing",
  "complete",
];
export default function CrewScene({
  phase,
  onMeet,
  variant = "room",
  highlight,
}: {
  phase?: MissionPhase;
  onMeet?: (id: AgentId) => void;
  variant?: "room" | "landing" | "mini";
  /** Members to light up (e.g. the nodes on a live route). */
  highlight?: AgentId[];
}) {
  const [autoIndex, setAutoIndex] = useState(0);
  useEffect(() => {
    if (phase || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(
      () => setAutoIndex((i) => (i + 1) % autoPhases.length),
      variant === "landing" ? 2100 : 3600,
    );
    return () => clearInterval(timer);
  }, [phase, variant]);
  const current = phase ?? autoPhases[autoIndex];
  const moving =
    current !== "idle" && current !== "paused" && current !== "complete";
  return (
    <div
      className={`crew-scene crew-scene-${variant} phase-${current}`}
      data-phase={current}
      role="group"
      aria-label={variant === "landing" ? "Hedy the gateway coordinates NEAR, USDC, a TEE judge and a pool: Pod the scheduler with Rex, Mika and Nova" : "The pool: Rex, Mika and Nova, with Hedy the gateway, coordinated by Pod"}
    >
      <div className="crew-ground" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <svg
        className={`crew-connections${moving ? " connections-active" : ""}`}
        viewBox="0 0 1000 280"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`crew-line-${variant}`}>
            <stop stopColor="#6fa6e5" stopOpacity="0" />
            <stop offset=".5" stopColor="#94bdf2" stopOpacity=".55" />
            <stop offset="1" stopColor="#6fa6e5" stopOpacity="0" />
          </linearGradient>
        </defs>
        {variant === "landing" ? (
          <>
            {/* gateway spokes: to NEAR, USDC, the TEE judge and to the pool */}
            <path className="crew-spokes" d={`M${gx} ${gy} L${badge("near")} M${gx} ${gy} L${badge("usdc")} M${gx} ${gy} L${badge("tee")} M${gx} ${gy} L${at(landingHomes.quil)} M${at(landingHomes.wren)} L${gx} ${gy} M${at(landingHomes.quil)} L${at(landingHomes.pip)} L${at(landingHomes.milo)} L${at(landingHomes.wren)}`} fill="none" />
            {landingSignal[current] && <path className="crew-signal crew-signal-landing" d={landingSignal[current]} strokeDasharray="3 12" fill="none" />}
          </>
        ) : (
        <>
        <path
          d="M160 190Q310 250 500 158Q670 235 840 190"
          stroke={`url(#crew-line-${variant})`}
          strokeWidth=".7"
          fill="none"
        />
        <path
          className="crew-signal"
          d={
            current === "reviewing"
              ? "M390 205Q430 95 570 142"
              : current === "writing"
                ? "M680 205Q625 95 510 150"
                : "M160 190Q280 105 390 205Q490 255 670 192"
          }
          stroke={`url(#crew-line-${variant})`}
          strokeWidth="1.5"
          strokeDasharray="2 16"
          fill="none"
        />
        </>
        )}
      </svg>
      {crew.map((person, i) => {
        const landing = variant === "landing";
        const pose = landing ? landingPoses[current]?.[person.id] ?? landingHomes[person.id] : poses[current]?.[person.id] ?? homes[person.id],
          say = pose.say;
        const mood =
          current === "complete"
            ? "happy"
            : say
              ? "talking"
              : moving
                ? "walking"
                : "idle";
        const style = {
          "--agent-x": `${pose.x}%`,
          "--agent-y": `${pose.y}%`,
          "--agent-color": person.color,
          "--agent-delay": `${i * -0.8}s`,
        } as CSSProperties;
        return (
          <div
            className={`crew-member crew-member-${person.id}${say ? " is-speaking" : ""}${highlight?.includes(person.id) ? " is-active" : ""}${highlight && !highlight.includes(person.id) ? " is-dim" : ""}`}
            key={person.id}
            style={style}
          >
            {say && (
              <span className="crew-utterance" key={say}>
                {say}
                <i />
              </span>
            )}
            <button
              className="crew-person"
              aria-label={`Meet ${person.name}, ${person.role}`}
              onClick={() => onMeet?.(person.id)}
              disabled={!onMeet}
              tabIndex={onMeet ? 0 : -1}
            >
              <AgentSprite agent={person.id} mood={mood} />
              <span className="crew-person-name">
                {person.name}
                <i />
              </span>
              <span className="crew-person-role">{person.role}</span>
            </button>
          </div>
        );
      })}
      {variant === "landing" && (
        <div className="crew-hangers" aria-hidden="true">
          {HANGERS.map((h, i) => (
            <div key={h.name} className={`crew-hanger crew-hanger-${h.id}${activeHanger[current] === h.id ? " is-active" : ""}`} style={{ ["--hx" as string]: `${h.x}%`, ["--hlen" as string]: `${h.len}px`, ["--hdelay" as string]: `${i * -1.3}s` } as CSSProperties}>
              <i className="crew-hanger-string" />
              <span className="crew-hanger-badge">
                <i className="crew-hanger-logo" style={{ ["--logo" as string]: `url(/brand/${h.id}.svg)` } as CSSProperties} />
                <b>{h.name}</b>
              </span>
            </div>
          ))}
        </div>
      )}
      {variant === "landing" && (
        <div className="crew-scene-caption">
          <span>A LITTLE POOLING, IN MOTION.</span>
          <span>ILLUSTRATIVE PIPELINE</span>
        </div>
      )}
    </div>
  );
}
