/**
 * Shared types for the RAMX Network MVP (spec v0.1: §5 gateway, §8 credits,
 * §10 payouts, §11 directory). JSON Schema mirrors live in ../schemas/*.schema.json.
 * Keep both in sync. USDC amounts are base-unit integer strings (6 decimals).
 */

export type HexAddress = `0x${string}`;

/* ── pool and nodes (directory) ─────────────────────────────────────── */

/** ramx.node status, written by the node agent. */
export type NodeStatus = "online" | "loading" | "ready" | "offline";

/** One hop of the pipeline: a node serving a half-open layer range [start, end). */
export type RouteHop = { node_id: string; layers: [number, number] };

/** Directory node record (plus the reliability parts the gateway adds on /me). */
export type NodeListing = {
  /** Node public key (EVM address of ~/.ramx/node.key). */
  node_id: string;
  owner_account: string;
  pool_id: string;
  gpu: string;
  mem_gb: number;
  status: NodeStatus;
  layers: [number, number] | null;
  tok_s: number;
  /** 0.7 × success_rate + 0.3 × uptime_rate, 0.0 to 1.0 (§9.1). */
  reliability: number;
  /** Listing expiry (ms). 120 s, renewed every 30 s. */
  expires_at: number;
  nickname?: string;
  success_rate?: number;
  uptime_rate?: number;
};

/** Directory pool record, built by the gateway from signed heartbeats. */
export type PoolListing = {
  pool_id: string;
  models: string[];
  members: string[];
  status: "ready" | "forming" | "offline";
  layer_map: RouteHop[];
  /** Pool reliability (§9.2): 0.7 × pool success rate + 0.3 × pool uptime, the pool as one identity. */
  reliability: number;
  /** 0.0 to 1.0. Router score = reliability × (1 − load). */
  load: number;
  /** P5.5: a clean restart is running (the router skips the pool). */
  restarting: boolean;
  /** P5.9: node-reported sessions disagree with the scheduler's routes (flag only). */
  route_dispute: boolean;
  expires_at: number;
};

/** Directory model record (gateway config). */
export type ModelEntry = {
  model_id: string;
  mlx_variant: string | null;
  size_gb: number;
  model_factor: number;
  license: string;
  params_b: number;
  total_layers: number;
};

/** Account stats (pseudonymous), computed by the gateway. */
export type AccountStats = {
  account_id: string;
  earned: number;
  spent: number;
  ratio: number;
  reliability: number;
};

/* ── accounts and credits (§8) ────────────────────────────────────────── */

export type Balance = {
  starter: number;
  starter_expires_at: number;
  /** Bought with USDC from a NEAR wallet; never expires. */
  bought: number;
  earned: number;
  held: number;
  earned_total: number;
  spent_total: number;
};

/** GET /me */
export type Me = {
  account_id: string;
  balance: Balance;
  /** SPEC §8.8: vesting, node cap, credential. Credits here stay in millicredits, as on the wire. */
  incentives: { locked_mc: number; next_unlock_at: number | null; node_cap: number; banned: boolean; credential: "orb" | "passport" | "selfie" | null };
  /** earned_total / max(spent_total, 1) */
  ratio: number;
  /** NEAR account that receives payouts. */
  payout_address: string | null;
  nodes: NodeListing[];
};

export type PayType = "credits" | "x402";

/** Division of one request (§8.3). A node owned by the requester gets 0; its share goes to the reserve. */
export type Split = {
  nodes: { node_id: string; layers: number; credits: number; self: boolean }[];
  burn: number;
  reserve: number;
};

/** GET /requests/:id */
export type Receipt = {
  req_id: string;
  /** Requesting account (null for x402). */
  account_id: string | null;
  model: string;
  pay_type: PayType;
  in_tokens: number;
  out_tokens: number;
  /** Credits for pay_type "credits"; 0 for x402 (see x402_amount). */
  cost: number;
  /** x402 price in USDC base units (string), null for credits. */
  x402_amount: string | null;
  route: RouteHop[];
  split: Split | null;
  x402_tx: string | null;
  x402_payer: string | null;
  ledger_seq: number | null;
  prompt_hash: string;
  resp_hash: string;
  status: "pending" | "ok" | "failed";
  ts: number;
  /** Load multiplier locked at request start (credits only; x402 keeps fixed tiers). */
  price_multiplier?: number | null;
  /** TEE spot-check of this answer (NEAR AI Cloud); null/absent = not sampled. */
  tee_check?: TeeCheck | null;
};

export type TeeCheck = {
  status: "queued" | "done" | "error";
  judge_model: string | null;
  verdict: "plausible" | "implausible" | "unknown" | null;
  reason: string | null;
  signing_address: string | null;
  attestation_sha256: string | null;
  nonce: string | null;
  chat_id: string | null;
  signature_ok: boolean | null;
  hashes_match: boolean | null;
  error: string | null;
  judged_at: number | null;
};

/** Credit price quote from /v1/models (shared/src/api.ts PriceQuote). */
export type PriceQuote = { credits_per_1k_in: number; credits_per_1k_out: number; multiplier: number; quoted_at: number };

/* ── ledger (§8.6, §10.2): ledger-v2.ramx.testnet ─────────────────────────── */

/** Every ledger event type the gateway writes. */
export type LedgerType = import("@ramx/shared").LedgerEventType;

export type LedgerEvent = {
  id: string;
  type: LedgerType;
  payload: Record<string, unknown>;
  gateway_sig: string;
  /** null until the async ledger write lands. */
  ledger_seq: number | null;
  ts: number;
};

/* ── epochs and payouts (§10.5) ───────────────────────────────────────── */

export type Epoch = {
  epoch: number;
  start_ts: number;
  end_ts: number;
  total_units: string;
  merkle_root: string | null;
  post_tx: string | null;
  status: "open" | "closed" | "posted";
};

/** One Merkle leaf (payout_address, amount_units) with its proof. */
export type Payout = {
  epoch: number;
  /** NEAR account that receives the payout. */
  payout_address: string;
  amount_units: string;
  proof: string[];
  claimable?: boolean;
  swept?: boolean;
  claimable_at?: number;
  merkle_root?: string;
  post_tx?: string | null;
  claimed: boolean;
  claim_tx: string | null;
};

/** x402 price per request (§7.3). tier512 / tier2048 in USDC. */
export type PriceTier = { max_params_b: number; tier512: string; tier2048: string; asset: "USDC" };
