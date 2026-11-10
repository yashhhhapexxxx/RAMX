/** Typed access to public build-time config. Never put secrets in VITE_* vars. */
// `?? {}` so plain node (npm test) can import modules that read config.
const raw: Record<string, unknown> = import.meta.env ?? {};

export const env = {
  dataMode: "live" as "mock" | "live",
  gatewayUrl: (raw.VITE_GATEWAY_URL as string | undefined) || "",
  /** NEAR testnet JSON-RPC (read-only checks from the browser). */
  nearRpc: (raw.VITE_NEAR_RPC as string | undefined) || "https://rpc.testnet.fastnear.com",
  /** NEAR ledger contract (signed balance-change events). */
  ledgerContract: (raw.VITE_LEDGER_CONTRACT as string | undefined) || "ledger.ramx.testnet",
  worldAppId: (raw.VITE_WORLD_APP_ID as string | undefined) || "",
  /** World ID action for login (spec §6.1). */
  worldAction: (raw.VITE_WORLD_ACTION as string | undefined) || "ramx-account",
  /** NEAR payout contract (contracts-near/payout). */
  payoutAddr: (raw.VITE_PAYOUT_CONTRACT as string | undefined) || "payout.ramx.testnet",
  /** Treasury that receives USDC top-ups, and the testnet USDC (NEP-141) contract. */
  treasury: (raw.VITE_TREASURY as string | undefined) || "treasury.ramx.testnet",
  usdc: (raw.VITE_USDC_CONTRACT as string | undefined) || "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
} as const;
