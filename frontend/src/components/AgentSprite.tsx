import { useId } from "react";
import { crew } from "../data/crew";
import type { AgentId } from "../data/crew";

type Props = {
  agent: AgentId;
  mood?: "idle" | "walking" | "talking" | "working" | "happy";
  className?: string;
};

export default function AgentSprite({
  agent,
  mood = "idle",
  className = "",
}: Props) {
  const id = useId().replaceAll(":", ""),
    person = crew.find((p) => p.id === agent)!;
  return (
    <svg
      className={`agent-sprite sprite-${agent} mood-${mood} ${className}`}
      viewBox="0 0 100 112"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={`${id}body`}
          x1="26"
          y1="22"
          x2="74"
          y2="87"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={person.light} />
          <stop offset=".48" stopColor={person.color} />
          <stop offset="1" stopColor={person.dark} />
        </linearGradient>
        <linearGradient
          id={`${id}face`}
          x1="31"
          y1="43"
          x2="66"
          y2="67"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#1a2940" />
          <stop offset="1" stopColor="#0b1628" />
        </linearGradient>
        <radialGradient
          id={`${id}shine`}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(33 32) rotate(48) scale(42 30)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity=".65" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse
        className="sprite-shadow"
        cx="50"
        cy="101"
        rx="23"
        ry="3"
        fill={person.color}
        opacity=".12"
      />
      <g
        className="sprite-feet"
        fill={person.dark}
        stroke={person.color}
        strokeWidth="1.2"
      >
        <path
          className="sprite-foot left"
          d="M33 85c-1 5-5 9-3 12 2 3 11 1 13-2l1-9"
        />
        <path
          className="sprite-foot right"
          d="M58 85c1 5 5 9 3 12-2 3-10 1-12-2l-1-9"
          transform="translate(7 0)"
        />
      </g>
      <g className="sprite-body">
        <path
          className="sprite-arm left"
          d="M23 58c-11 0-12 10-8 12 4 2 7-4 10-5"
          fill={person.dark}
          stroke={person.color}
          strokeWidth="1.2"
        />
        <path
          className="sprite-arm right"
          d="M77 58c10-1 13 8 9 11-4 3-8-4-11-4"
          fill={person.dark}
          stroke={person.color}
          strokeWidth="1.2"
        />
        <path
          d="M20 72c-5-9-5-22 0-33 3-10 11-18 22-20 3-5 9-8 13-2 17 0 25 12 28 25 3 12 2 25-4 31 2 8-4 13-14 14H36c-11 1-18-4-16-15Z"
          fill={`url(#${id}body)`}
          stroke={person.light}
          strokeOpacity=".6"
          strokeWidth="1.1"
        />
        <path
          d="M20 72c-5-9-5-22 0-33 3-10 11-18 22-20 3-5 9-8 13-2 17 0 25 12 28 25 3 12 2 25-4 31 2 8-4 13-14 14H36c-11 1-18-4-16-15Z"
          fill={`url(#${id}shine)`}
        />
        <path
          d="M27 35c3-7 10-11 16-11"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          opacity=".6"
        />
        <path
          d="M28 47c0-7 6-11 22-11 17 0 23 4 23 11v10c0 8-7 13-23 13-15 0-22-5-22-13V47Z"
          fill={`url(#${id}face)`}
          stroke={person.dark}
          strokeWidth="1.5"
        />
        <path
          d="M34 42c8-3 24-3 32 0"
          stroke="white"
          strokeOpacity=".1"
          strokeLinecap="round"
        />
        <g className="sprite-eyes" fill={person.light}>
          <rect x="37" y="47" width="5" height="9" rx="2.5" />
          <rect x="58" y="47" width="5" height="9" rx="2.5" />
        </g>
        <path
          className="sprite-mouth"
          d={
            mood === "happy"
              ? "M45 59q5 6 10 0"
              : mood === "talking"
                ? "M46 60q4 5 8 0q-4-3-8 0Z"
                : "M47 60q3 2 6 0"
          }
          stroke={person.light}
          strokeWidth="1.3"
          strokeLinecap="round"
          fill={mood === "talking" ? person.light : "none"}
        />
        <ellipse
          cx="32"
          cy="59"
          rx="3"
          ry="1.7"
          fill={person.color}
          opacity=".35"
        />
        <ellipse
          cx="68"
          cy="59"
          rx="3"
          ry="1.7"
          fill={person.color}
          opacity=".35"
        />
        {agent === "quil" && (
          <g stroke="#e5f4ff" strokeWidth="1.3" strokeLinecap="round">
            <path
              d="m51 22 8-17M54 16C47 10 53 2 64 2c1 8-2 12-10 14Z"
              fill="#aecfff"
            />
            <path d="m55 12 5-6" />
          </g>
        )}
        {agent === "pip" && (
          <g className="sprite-tool" stroke="#e5f5ff" strokeWidth="1.8">
            <circle cx="77" cy="69" r="7" fill="#194c70" />
            <path d="m82 75 5 7" strokeWidth="3" />
            <path d="M74 66q3-2 5 0" strokeOpacity=".6" />
          </g>
        )}
        {agent === "milo" && (
          <g className="sprite-tool">
            <path
              d="m30 72 19 3 19-3v15l-19 3-19-3V72Z"
              fill="#625c99"
              stroke="#e6ddff"
              strokeWidth="1.1"
            />
            <path
              d="M49 75v15M35 77l9 1M54 78l9-1M35 81l9 1"
              stroke="#e6ddff"
              strokeWidth="1"
              strokeOpacity=".7"
            />
          </g>
        )}
        {agent === "iris" && (
          <g className="sprite-tool">
            <rect
              x="65"
              y="64"
              width="17"
              height="23"
              rx="3"
              fill="#285847"
              stroke="#dbf6e9"
              strokeWidth="1.2"
              transform="rotate(12 73 76)"
            />
            <path
              d="m68 76 4 4 6-8"
              stroke="#dbf6e9"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="m70 66 7 1"
              stroke="#dbf6e9"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </g>
        )}
        {agent === "wren" && (
          <g
            className="sprite-tool"
            stroke="#ffead8"
            strokeWidth="1.3"
            strokeLinecap="round"
          >
            <path
              d="m72 86 8-22M75 76c-5-5 0-12 10-13 1 7-2 12-10 13Z"
              fill="#e9be97"
            />
            <path d="m77 73 5-7" />
          </g>
        )}
      </g>
    </svg>
  );
}
