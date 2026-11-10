import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RamxConfig, type ModelConfig } from "@ramx/shared";

/**
 * Gateway env (see gateway/.env.example, HANDOFF §8).
 * Required by the schema: POOL_COORDINATOR_URL, DATABASE_PATH. main.ts also needs GATEWAY_SIGNING_KEY.
 * Feature keys (World + JWT, NEAR gateway account + ledger contract, x402) switch their feature on; payouts require treasury/settler keys and the contract address.
 */
const opt = z.string().min(1).optional();
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

export const GatewayEnv = z.preprocess(
  (raw) => Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, emptyToUndefined(v)])),
  z.object({
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    /** The gateway is the only public service: bind all interfaces. Parallax stays on 127.0.0.1. */
    HOST: z.string().default("0.0.0.0"),
    PUBLIC_URL: z.url().optional(),
    POOL_COORDINATOR_URL: z.url(),
    DATABASE_PATH: z.string().min(1),
    /** Dev phase: a database with another schema version is moved aside (never deleted) and recreated. false = refuse to start. */
    DB_RESET_ON_MISMATCH: z.enum(["true", "false"]).default("true"),
    /** Comma-separated frontend origins. Empty = no cross-origin access. */
    CORS_ORIGINS: z.string().default(""),
    /** Time to the pool's response headers of NON-streaming requests, ms. Non-streaming Parallax answers send
     *  headers only after the whole generation (2048 tokens at ~5 tok/s ≈ 6 min), so keep this long. Streaming
     *  requests use the first-token limit (shared config `resilience`, post-MVP P5.1). */
    POOL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),

    HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(10),

    JWT_SECRET: opt,
    GATEWAY_SIGNING_KEY: opt,
    WORLD_APP_ID: opt,
    WORLD_RP_ID: opt,
    WORLD_RP_SIGNING_KEY: opt,
    WORLD_ACTION: opt,
    WORLD_ENVIRONMENT: opt,
    WORLD_SIMULATOR_DEVICE_ACCOUNTS: opt,
    STARTER_CREDITS: z.coerce.number().int().nonnegative().optional(),
    STARTER_EXPIRY_DAYS: z.coerce.number().int().positive().optional(),
    /** Gateway's own NEAR account (ed25519 key): writes the ledger contract. Testnet only. */
    NEAR_GATEWAY_ACCOUNT_ID: opt,
    NEAR_GATEWAY_KEY: opt,
    /** NEAR ledger contract (contracts-near/ledger) that receives every signed balance-change event. */
    LEDGER_CONTRACT_ID: opt,
    X402_FACILITATOR_URL: opt,
    /** NEAR account that receives x402 USDC (the treasury). Must be registered on the USDC contract. */
    X402_PAY_TO: opt,
    /** In-process x402 facilitator: relayer account that submits payers' signed delegates and pays gas. */
    X402_RELAYER_ID: opt,
    X402_RELAYER_KEY: opt,
    /** NEAR JSON-RPC (default: the @x402/near testnet RPC). */
    NEAR_RPC_URL: z.url().optional(),
    /** contracts-near/payout: epoch Merkle roots funded in USDC; providers claim. Setting it turns epoch settlement on. */
    PAYOUT_CONTRACT_ID: opt,
    /** Account that funds and posts epochs (the x402 treasury: X402_PAY_TO), with its ed25519 key. */
    SETTLER_ACCOUNT_ID: opt,
    SETTLER_KEY: opt,
    ERC8004_IDENTITY_REGISTRY: opt,
    ERC8004_REPUTATION_REGISTRY: opt,
    ERC8004_AGENT_ID: z.string().regex(/^\d+$/).optional(),
    ERC8004_IMAGE_URL: z.url().optional(),
    /** Counsel opinion reference (docs/LEGAL_CHECK.md). Only logged: the build stays testnet-only. */
    LEGAL_CLEARANCE_REF: opt,
    /** SPEC §16.4 Swarm: a Bee node and a usable postage batch; each epoch bundle is uploaded before the epoch closes. */
    BEE_API_URL: opt,
    BEE_POSTAGE_BATCH_ID: opt,
    EPOCH_SECONDS: z.coerce.number().int().positive().optional(),
    /** Post-MVP P5.4: the gateway writes the admission allow-list here (absolute path, scheduler host). */
    PARALLAX_ALLOWED_PEERS_FILE: opt,
    /** Post-MVP P5.8/P5.9: the hook's route log (absolute path). Set only when the pool runs pool/hooks. */
    PARALLAX_ROUTE_LOG: opt,
    /** Tool calling: "emulate" = tools in the prompt, `<tool_call>` text parsed back (Qwen3); "native" = pass through. */
    TOOLS_MODE: z.enum(["emulate", "native"]).default("emulate"),
    /** SPEC §16.1 many pools: JSON {"pool-id": "http://127.0.0.1:3002", ...}; other pools use POOL_COORDINATOR_URL. */
    POOL_COORDINATORS: opt,
    /** Same map as a file (pool/pools-up.sh writes it for "auto" pools); read on each routing decision. */
    POOL_COORDINATORS_FILE: opt,
    /** SPEC §16.1 privacy: accounts trusted to hold the first and last layers (comma-separated acc_ IDs). */
    TRUSTED_ACCOUNTS: opt,
    /** SPEC §16.3 private pools: JSON {"pool-id": ["acc_…", …]}; only these accounts (and the pool's node owners) may use the pool. */
    PRIVATE_POOLS: opt,
    /** Privacy: AES-256-GCM key for transcripts at rest (64 hex chars). Empty = plain text (MVP). */
    TRANSCRIPT_KEY: opt,
    /** Privacy: serve HTTPS with this certificate + key (PEM files). Both empty = HTTP (MVP). */
    TLS_CERT_FILE: opt,
    TLS_KEY_FILE: opt,
    /** SPEC §16.2 output verification: planned, NOT active. "false" (default) turns off sampled checks,
     *  canaries, capability challenges, penalties and the /verifications routes. To be designed later. */
    VERIFICATION_ENABLED: z.enum(["true", "false"]).default("false"),
    /** P6.2 output sampling (only with VERIFICATION_ENABLED=true and a trusted verifier). */
    VERIFIER_URL: opt,
    VERIFIER_SECONDARY_URL: opt,
    VERIFIER_OWNER_ACCOUNT: opt,
    VERIFIER_SECONDARY_OWNER_ACCOUNT: opt,
    VERIFICATION_MAX_RATE: z.coerce.number().min(0.005).max(1).default(0.2),
    VERIFICATION_MIN_RATE: z.coerce.number().min(0.001).max(0.2).default(0.005),
    VERIFICATION_COST_MC: z.coerce.number().positive().default(1),
    VERIFICATION_APPEAL_HOURS: z.coerce.number().int().positive().max(168).default(24),
  }),
);
export type GatewayEnv = z.infer<typeof GatewayEnv>;

export type Config = {
  env: GatewayEnv;
  net: RamxConfig;
  corsOrigins: string[];
  model(id: string): ModelConfig | undefined;
};

export function loadNetworkConfig(): RamxConfig {
  const path = fileURLToPath(import.meta.resolve("@ramx/shared/config.json"));
  return RamxConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Throws one clear message listing every bad or missing key. */
export function loadConfig(rawEnv: Record<string, string | undefined> = process.env): Config {
  // Values pasted into a hosting dashboard often carry a trailing newline; keys and URLs never contain edge whitespace.
  const trimmed = Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
  const r = GatewayEnv.safeParse(trimmed);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid gateway env (see gateway/.env.example):\n${lines.join("\n")}`);
  }
  const net = loadNetworkConfig();
  return {
    env: r.data,
    net,
    corsOrigins: r.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    model: (id) => net.models.find((m) => m.model_id === id),
  };
}
