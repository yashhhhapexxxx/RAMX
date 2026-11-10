import { z } from "zod";
import { ModelId, NearAccountId, TokenUnits } from "./common.ts";

/**
 * Static network config: `shared/config/ramx.config.json`.
 * Values that are already env keys (STARTER_CREDITS, STARTER_EXPIRY_DAYS, EPOCH_SECONDS,
 * HEARTBEAT_SECONDS) are NOT repeated here.
 * Shares are basis points (10000 = 100%) so the money math stays integer.
 */

export const X402PriceTier = z.object({
  /** Tier applies when request max_tokens <= this value. Tiers are sorted ascending. */
  max_tokens: z.number().int().positive(),
  /** Price in base units of the x402 asset (USDC on NEAR, 6 decimals). */
  price_units: TokenUnits,
});
export type X402PriceTier = z.infer<typeof X402PriceTier>;

export const ModelConfig = z.object({
  model_id: ModelId,
  /** Variant that Mac (MLX) nodes load. */
  mlx_variant: ModelId,
  size_gb: z.number().positive(),
  /** Transformer layers (HF config num_hidden_layers). A route must cover [0, num_layers) exactly once (SPEC §5.5). */
  num_layers: z.number().int().positive(),
  /** Cost multiplier (SPEC §8.1). 1.0 = 8B at 8 bits. */
  model_factor: z.number().positive(),
  license: z.string().min(1),
  /** SPEC §7.3. A request with max_tokens above the last tier is rejected. */
  x402_prices: z.array(X402PriceTier).min(1),
  /**
   * Prompt + answer tokens a pool takes when its nodes report no `max_seq` (Mac nodes run
   * --max-sequence-length 4096). The gateway trims prompts to fit (gateway/src/context.ts).
   */
  context_length: z.number().int().positive(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

const Bps = z.number().int().min(0).max(10000);

export const RamxConfig = z.object({
  models: z.array(ModelConfig).min(1),
  /** Hold = model_factor × (max_tokens + input_token_weight × input_tokens). */
  cost: z.object({
    input_token_weight: z.number().nonnegative(),
    /** Used for the hold when the request has no max_tokens. */
    default_max_tokens: z.number().int().positive(),
  }),
  /** SPEC §8.3: 90 / 5 / 5. */
  credit_split_bps: z
    .object({ nodes: Bps, burn: Bps, reserve: Bps })
    .refine((s) => s.nodes + s.burn + s.reserve === 10000, "credit split must sum to 10000"),
  /** SPEC §10.5: 80 / 10 / 10. */
  x402_split_bps: z
    .object({ providers: Bps, reserve: Bps, operations: Bps })
    .refine((s) => s.providers + s.reserve + s.operations === 10000, "x402 split must sum to 10000"),
  /** SPEC §9.1. */
  reliability: z.object({
    success_weight: z.number().min(0).max(1),
    uptime_weight: z.number().min(0).max(1),
    initial_score: z.number().min(0).max(1),
    window_days: z.number().int().positive(),
  }),
  /** SPEC §5.4. */
  router: z.object({
    pool_heartbeat_max_age_s: z.number().int().positive(),
    retry_after_s: z.number().int().positive(),
    /** SPEC §16.1 batching: requests that run at once per pool (MVP = 1). Parallax batches them (--max-batch-size). */
    max_concurrent_per_pool: z.number().int().positive(),
  }),
  /**
   * SPEC §16.1 batching: Parallax flags for every node of a managed (website) pool. Sent to the
   * helpers in /provider/helper/config; applied at the next pool start (Retry setup).
   * micro batch = max_batch_size / micro_batch_ratio; scheduler_wait_ms = time to gather a batch.
   */
  node_batching: z.object({
    max_batch_size: z.number().int().positive(),
    micro_batch_ratio: z.number().int().positive(),
    scheduler_wait_ms: z.number().int().min(0),
  }),
  /** SPEC §16.1 automatic pool formation: nodes registered in pool "auto" are grouped by measured delay. */
  pool_formation: z.object({
    max_rtt_ms: z.number().positive(),
    min_nodes: z.number().int().positive(),
    /** Ask nodes to measure delay to each other at most this often. */
    probe_every_s: z.number().int().positive(),
  }),
  /**
   * Post-MVP P5.1/P5.2 (docs/POST_MVP_PLAN.md): stream stall detection and gateway failover.
   * Stall limit after the first token = max(stall_min_ms, stall_p95_factor × p95 gap between
   * tokens of the pool). Before the first token: first_token_base_ms + ms_per_input_token × input.
   * continuation = resume a broken stream with the partial answer as the final assistant message
   * (vLLM `continue_final_message`); false = no mid-stream failover.
   */
  resilience: z.object({
    stall_min_ms: z.number().int().positive(),
    stall_p95_factor: z.number().positive(),
    first_token_base_ms: z.number().int().positive(),
    first_token_ms_per_input_token: z.number().nonnegative(),
    max_failovers: z.number().int().nonnegative(),
    continuation: z.boolean(),
    /** P5.5: at most one ordered pool restart per this many seconds (cool-down before re-placing again). */
    restart_cooldown_s: z.number().int().positive(),
    /** P5.5: a restart not acknowledged by every member within this time stops blocking the router. */
    restart_timeout_s: z.number().int().positive(),
    /** P5.9 cross-check window and tolerance: dispute if |reported − routed| / routed > ratio with ≥ min routed. */
    route_check_window_s: z.number().int().positive(),
    route_dispute_ratio: z.number().positive(),
    route_check_min_requests: z.number().int().positive(),
  }),
  /** x402 on NEAR: network (CAIP-2) and the NEP-141 token paid (Circle USDC). Prices are x402_prices[].price_units. */
  x402_near: z.object({
    network: z.enum(["near:testnet", "near:mainnet"]),
    asset: NearAccountId,
    decimals: z.number().int().min(0).max(24),
  }),
  /** API key top-ups: USDC on NEAR via x402 buys credits that only that key can spend. */
  topup: z.object({
    /** Credits per 1 USDC (1 USDC = 10^decimals base units). */
    credits_per_usdc: z.number().int().positive(),
    min_usdc: z.number().positive(),
    max_usdc: z.number().positive(),
  }),
  /** SPEC §16.3 incentives. */
  incentives: z.object({
    /** Earned credits stay locked (can be taken back for fraud) this long before they can be spent. */
    vesting_s: z.number().int().nonnegative(),
    /** Unlocked earned credits expire after this many days (oldest first). */
    earned_expiry_days: z.number().int().positive(),
    /** A final fraud verdict penalizes only route nodes whose group-test risk is at least this. */
    penalty_min_risk: z.number().min(0).max(1),
    /** Node cap after the account is proven (start cap = max_nodes_per_account). */
    node_cap_proven: z.number().int().positive(),
    proven_after_days: z.number().int().nonnegative(),
    proven_min_reliability: z.number().min(0).max(1),
    proven_min_requests: z.number().int().nonnegative(),
    /** Credentials that may reach the proven cap (World). */
    proven_credentials: z.array(z.enum(["orb", "passport", "selfie"])).min(1),
    collusion: z.object({
      window_days: z.number().int().positive(),
      /** Flag when one requester gives more than this share of an owner's earnings. */
      max_pair_share: z.number().min(0).max(1),
      /** Ignore pairs below this many mc. */
      min_pair_mc: z.number().int().nonnegative(),
      /** Accounts created this close together that only trade with each other. */
      twin_window_s: z.number().int().positive(),
    }),
    availability: z.object({
      epoch_s: z.number().int().positive(),
      /** A pool "needs capacity" when a request waited at least this long in its queue in the epoch. */
      min_wait_ms: z.number().int().nonnegative(),
      reward_mc_per_min: z.number().int().nonnegative(),
      /** At most this much per epoch, and never more than the network reserve holds. */
      max_per_epoch_mc: z.number().int().nonnegative(),
    }),
  }),
  /** SPEC §6.3. */
  max_nodes_per_account: z.number().int().positive(),
  /** SPEC §6.2: JWT lifetime. */
  session_ttl_s: z.number().int().positive(),
  /** SPEC §14: transcripts kept for this many days. */
  transcript_retention_days: z.number().int().positive(),
});
export type RamxConfig = z.infer<typeof RamxConfig>;
