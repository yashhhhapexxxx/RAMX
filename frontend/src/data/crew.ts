/** Illustrative crew for the landing scene (not live data; the Network page lists real nodes).
    Internal sprite keys (kept from quil: sprites, colors and CSS are keyed on them). Display names are below. */
export type AgentId = "quil" | "pip" | "milo" | "iris" | "wren";
export type MissionPhase =
  | "idle"
  | "introducing"
  | "planning"
  | "discovering"
  | "investigating"
  | "reviewing"
  | "writing"
  | "complete"
  | "paused";

export const crew: {
  id: AgentId;
  name: string;
  role: string;
  color: string;
  light: string;
  dark: string;
  introduction: string;
}[] = [
  {
    id: "pip",
    name: "Rex",
    role: "RTX 4060 · 8 GB",
    color: "#83caff",
    light: "#d9f4ff",
    dark: "#3987c7",
    introduction:
      "I’m Rex, a gaming laptop. I serve the first stage of layers that fit in my 8 GB.",
  },
  {
    id: "milo",
    name: "Mika",
    role: "M4 · 16 GB",
    color: "#b4a0ed",
    light: "#e9e2ff",
    dark: "#7154b5",
    introduction:
      "I’m Mika, a 16 GB MacBook. I hold a bigger slice of layers in MLX.",
  },
  {
    id: "quil",
    name: "Pod",
    role: "Pool scheduler",
    color: "#d8e8ff",
    light: "#f0f7ff",
    dark: "#7298ce",
    introduction:
      "I’m the pool’s Parallax scheduler. The gateway hands me a request and I run it through the laptops in layer order.",
  },
  {
    id: "iris",
    name: "Hedy",
    role: "The gateway",
    color: "#8ecab3",
    light: "#dbf4e9",
    dark: "#438c73",
    introduction:
      "I’m Hedy, the gateway. I talk to everything: NEAR wallet login, the pool directory, routing, x402 payments in USDC, and receipts on the NEAR ledger.",
  },
  {
    id: "wren",
    name: "Nova",
    role: "M5 · 16 GB",
    color: "#dfb69a",
    light: "#ffe9d5",
    dark: "#ad7359",
    introduction:
      "I’m Nova. I serve the last stage and send the answer back.",
  },
];
