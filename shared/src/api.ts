import { z } from "zod";
import {
  AccountId,
  CreditSplit,
  EpochNumber,
  EvmAddress,
  Hex32,
  NearAccountId,
  NearTxHash,
  HexSig,
  LayerRange,
  Millicredits,
  ModelId,
  PayType,
  PoolId,
  RequestId,
  Route,
  TimestampMs,
  TokenUnits,
} from "./common.ts";
import { DirectoryNode, DirectoryPool, AccountStats } from "./directory.ts";
import { LedgerEvent } from "./ledger-events.ts";

/** Gateway HTTP API (SPEC §5.2). */

// ---------- headers ----------

/** Set on every /v1/chat/completions response (streaming too). Use it with GET /requests/:id. */
export const REQUEST_ID_HEADER = "x-ramx-request-id";
/** EIP-191 personal_sign by the node key over the raw request body (POST /nodes/heartbeat). */
export const NODE_SIGNATURE_HEADER = "x-ramx-node-signature";

// ---------- errors ----------

export const ErrorCode = z.enum([
  "bad_request",
  "unauthorized",
  "insufficient_credits",
  "payment_required",
  "model_not_found",
  "no_pool_available",
  "node_limit_reached",
  "not_found",
  "pool_error",
  "internal",
  /** The prompt does not fit the pool's context even after the gateway trimmed it. */
  "context_length_exceeded",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Every non-2xx response has this body (except the x402 402 body, which the x402 library owns). */
export const ErrorResponse = z.object({
  error: z.object({ code: ErrorCode, message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// ---------- POST /v1/chat/completions (OpenAI-compatible subset) ----------

/** Text content part (OpenAI array content). Image and audio parts are not supported. */
export const TextPart = z.object({ type: z.literal("text"), text: z.string() });
export type TextPart = z.infer<typeof TextPart>;
/** Message content: a string or text parts. */
export const MessageContent = z.union([z.string(), z.array(TextPart)]);
export type MessageContent = z.infer<typeof MessageContent>;

/** An OpenAI function tool call (assistant messages, responses). `arguments` is a JSON string. */
export const ToolCall = z.object({
  id: z.string().min(1).max(128),
  type: z.literal("function"),
  function: z.object({ name: z.string().min(1).max(128), arguments: z.string() }),
});
export type ToolCall = z.infer<typeof ToolCall>;

/** A function tool the client offers (OpenCode, OpenAI SDKs). `parameters` is a JSON Schema. */
export const Tool = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1).max(128),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().nullable().optional(),
  }),
});
export type Tool = z.infer<typeof Tool>;

export const ToolChoice = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({ type: z.literal("function"), function: z.object({ name: z.string().min(1).max(128) }) }),
]);
export type ToolChoice = z.infer<typeof ToolChoice>;

export const ChatMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: MessageContent }),
  z.object({ role: z.literal("user"), content: MessageContent }),
  z.object({
    role: z.literal("assistant"),
    /** Null or absent when the turn is only tool calls. */
    content: MessageContent.nullable().optional(),
    tool_calls: z.array(ToolCall).optional(),
  }),
  z.object({ role: z.literal("tool"), tool_call_id: z.string().min(1).max(128), content: MessageContent }),
]);
export type ChatMessage = z.infer<typeof ChatMessage>;

/** The plain text of a message's content (parts joined; null → ""). */
export const contentText = (c: MessageContent | null | undefined): string =>
  c == null ? "" : typeof c === "string" ? c : c.map((p) => p.text).join("");

/**
 * Unknown fields are stripped (zod default), so `logprobs` never reaches Parallax.
 * When forwarding, the gateway:
 * - sets chat_template_kwargs.enable_thinking = false unless the client sets it;
 * - sets stream_options.include_usage = true on streaming requests (needed to settle, SPEC §5.3);
 * - uses max_tokens, else max_completion_tokens, else config default_max_tokens for the hold.
 */
export const ChatCompletionRequest = z.object({
  model: ModelId,
  messages: z.array(ChatMessage).min(1),
  max_tokens: z.number().int().positive().optional(),
  /** Newer OpenAI SDKs send this instead of max_tokens. */
  max_completion_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  chat_template_kwargs: z.object({ enable_thinking: z.boolean().optional() }).optional(),
  /** Function tools. The gateway emulates tool calling when the pool has no native support. */
  tools: z.array(Tool).optional(),
  tool_choice: ToolChoice.optional(),
  parallel_tool_calls: z.boolean().optional(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

export const Usage = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

/** Non-streaming response. `id` is the gateway req_id. Streaming uses OpenAI SSE chunks. */
export const ChatCompletionResponse = z.object({
  id: RequestId,
  object: z.literal("chat.completion"),
  created: z.number().int(),
  model: ModelId,
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        message: z.object({
          role: z.literal("assistant"),
          /** Null when the answer is only tool calls. */
          content: z.string().nullable(),
          tool_calls: z.array(ToolCall).optional(),
        }),
        finish_reason: z.string().nullable(),
      }),
    )
    .min(1),
  usage: Usage,
});
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponse>;

// ---------- price (1 credit is not 1 token; the multiplier floats with pool load) ----------

/** Credits per 1,000 tokens, quoted when a request starts and locked for that request. */
export const PriceQuote = z.object({
  credits_per_1k_in: z.number().nonnegative(),
  credits_per_1k_out: z.number().nonnegative(),
  /** Load multiplier on the model's base price (1 = base). */
  multiplier: z.number().positive(),
  quoted_at: TimestampMs,
});
export type PriceQuote = z.infer<typeof PriceQuote>;

/** Picked max_tokens for a request (per-user budget), set on /v1/chat/completions responses. */
export const MAX_TOKENS_HEADER = "x-ramx-max-tokens";
/** JSON PriceQuote locked for the request, set on /v1/chat/completions responses. */
export const PRICE_HEADER = "x-ramx-price";

// ---------- GET /v1/models ----------

export const ModelsResponse = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      id: ModelId,
      object: z.literal("model"),
      created: z.number().int(),
      owned_by: z.literal("ramx"),
      model_factor: z.number().positive(),
      /** Number of ready pools that serve the model now. */
      pools: z.number().int().nonnegative(),
      /** "gateway" = laptop pools serve it; "near-ai-cloud" = no pool is ready, a NEAR AI Cloud TEE model serves it (judge mode). */
      source: z.enum(["gateway", "near-ai-cloud"]),
      /** Largest prompt + answer the serving pools take, tokens (minimum over their nodes). */
      context_length: z.number().int().positive().optional(),
      /** Current price; requests lock their own quote. */
      price: PriceQuote.optional(),
    }),
  ),
});
export type ModelsResponse = z.infer<typeof ModelsResponse>;

// ---------- World login ----------

/**
 * POST /auth/world/rp-signature response (IDKit v4 RP signature, https://docs.world.org/world-id/idkit/signatures).
 * The gateway signs with `signRequest` from `@worldcoin/idkit-core/signing` (secp256k1, EIP-191 over
 * version ‖ nonce ‖ created_at ‖ expires_at ‖ hash_to_field(action)). The frontend builds IDKit's
 * `rp_context` = { rp_id, nonce, created_at, expires_at, signature: sig } and passes app_id, action,
 * environment to the widget. Times are unix SECONDS (IDKit's format). Valid for 300 s.
 */
export const RpSignatureResponse = z.object({
  sig: HexSig,
  nonce: Hex32,
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  rp_id: z.string().regex(/^rp_[0-9a-f]+$/),
  app_id: z.string().regex(/^app_[0-9a-f]+$/),
  action: z.string().min(1),
  environment: z.enum(["production", "staging"]),
});
export type RpSignatureResponse = z.infer<typeof RpSignatureResponse>;
/** POST /auth/world/verify request = the IDKit v4 result, unchanged (the gateway forwards it as is). */
export const WorldVerifyRequest = z.record(z.string(), z.unknown());
export type WorldVerifyRequest = z.infer<typeof WorldVerifyRequest>;

/** `new_account: false` = the human already has an account (UI shows "already registered"). */
export const WorldVerifyResponse = z.object({
  token: z.string().min(1),
  account_id: AccountId,
  new_account: z.boolean(),
  /** 0 when new_account is false. */
  starter_granted_mc: Millicredits,
});
export type WorldVerifyResponse = z.infer<typeof WorldVerifyResponse>;

// ---------- GET /me ----------

export const Balance = z.object({
  starter_mc: Millicredits,
  starter_expires_at: TimestampMs.nullable(),
  /** Bought with USDC from a NEAR wallet (POST /v1/credits/near-topup). Never expires. */
  bought_mc: Millicredits,
  earned_mc: Millicredits,
  held_mc: Millicredits,
  earned_total_mc: Millicredits,
  spent_total_mc: Millicredits,
});
export type Balance = z.infer<typeof Balance>;

export const MeResponse = z.object({
  account_id: AccountId,
  payout_address: NearAccountId.nullable(),
  balance: Balance,
  /** earned_total / max(spent_total, 1). */
  ratio: z.number().nonnegative(),
  /** SPEC §16.3. */
  incentives: z.object({
    /** Earned credits still vesting (not spendable; can be taken back after a final fraud verdict). */
    locked_mc: Millicredits,
    /** When the next locked credits unlock (null = none locked). */
    next_unlock_at: TimestampMs.nullable(),
    /** Strongest World credential used to log in. */
    credential: z.enum(["orb", "passport", "selfie"]).nullable(),
    /** Nodes this account may register now (reputation-based cap). */
    node_cap: z.number().int().nonnegative(),
    banned: z.boolean(),
  }),
  nodes: z.array(
    z.object({
      node_id: EvmAddress,
      pool_id: PoolId,
      gpu: z.string(),
      mem_gb: z.number().positive(),
      reliability: z.number().min(0).max(1),
      online: z.boolean(),
    }),
  ),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ---------- /agents (SPEC §16.3 World Agent Pass, MVP form; session auth) ----------

/**
 * A human-backed API key (OpenCode, scripts, agents): requests use the human's credits and ratio,
 * up to `budget_mc` (null = no cap: the whole balance).
 */
export const AgentKey = z.object({
  agent_id: z.string().regex(/^agt_[A-Za-z0-9]+$/),
  name: z.string().min(1).max(64),
  budget_mc: Millicredits.nullable(),
  spent_mc: Millicredits,
  revoked: z.boolean(),
  created_at: TimestampMs,
  /** Last settled request with this key; null = never used. */
  last_used_at: TimestampMs.nullable(),
  /** Credits bought for this key with USDC (x402 top-ups or escrow payments) and not spent yet. Only this key can spend them. */
  key_credits_mc: Millicredits,
  /** All credits ever bought for this key. */
  bought_total_mc: Millicredits,
});
export type AgentKey = z.infer<typeof AgentKey>;
export const AgentKeyCreateRequest = z.object({ name: z.string().min(1).max(64), budget_mc: Millicredits.nullable().optional() });
export type AgentKeyCreateRequest = z.infer<typeof AgentKeyCreateRequest>;
/** `token` is shown once: `Authorization: Bearer <token>` on /v1/chat/completions. */
export const AgentKeyCreateResponse = AgentKey.extend({ token: z.string().regex(/^gpa_agt_[A-Za-z0-9]+_[0-9a-f]{64}$/) });
export type AgentKeyCreateResponse = z.infer<typeof AgentKeyCreateResponse>;
export const AgentKeyListResponse = z.object({ agents: z.array(AgentKey) });
export type AgentKeyListResponse = z.infer<typeof AgentKeyListResponse>;

/**
 * GET /v1/credits (Bearer gpa_ key only): what this key can spend now. A key spends its own bought
 * credits first, then the account's credits (starter, then earned) within its cap.
 */
export const KeyCreditsResponse = z.object({
  agent_id: z.string().regex(/^agt_[A-Za-z0-9]+$/),
  name: z.string().min(1).max(64),
  /** Bought credits not spent or held. */
  key_credits_mc: Millicredits,
  bought_total_mc: Millicredits,
  /** Account credits available now (starter + earned − held). */
  account_available_mc: Millicredits,
  /** null = no cap on the account credits this key may spend. */
  cap_mc: Millicredits.nullable(),
  cap_left_mc: Millicredits.nullable(),
  /** key_credits + min(account_available, cap_left). */
  spendable_mc: Millicredits,
  spent_mc: Millicredits,
  topup: z.object({ credits_per_usdc: z.number().int().positive(), min_usdc: z.number().positive(), max_usdc: z.number().positive() }),
});
export type KeyCreditsResponse = z.infer<typeof KeyCreditsResponse>;

/** POST /v1/credits/topup (Bearer gpa_ key + x402 USDC payment on NEAR). */
export const CreditTopupRequest = z.object({ usdc: z.number().positive().multipleOf(1e-6) });
export type CreditTopupRequest = z.infer<typeof CreditTopupRequest>;
export const CreditTopupResponse = z.object({
  agent_id: z.string().regex(/^agt_[A-Za-z0-9]+$/),
  payer: NearAccountId,
  tx_id: NearTxHash,
  amount_units: TokenUnits,
  added_mc: Millicredits,
  credits: KeyCreditsResponse,
});
export type CreditTopupResponse = z.infer<typeof CreditTopupResponse>;

/**
 * POST /v1/credits/escrow (API key): a guarded agent paid the treasury through the escrow contract
 * (`escrow.pay(treasury, amount, memo = <agent key id>)`); credit that key once per transaction.
 */
export const EscrowCreditRequest = z.object({ tx_hash: NearTxHash, agent_account: NearAccountId });
export type EscrowCreditRequest = z.infer<typeof EscrowCreditRequest>;

/**
 * POST /v1/credits/near-topup (session): the user sent USDC to the treasury from a NEAR wallet with
 * `ft_transfer(treasury, amount, memo = <account id>)`; credit the account once per transaction.
 */
export const NearTopupRequest = z.object({ tx_hash: NearTxHash, sender: NearAccountId });
export type NearTopupRequest = z.infer<typeof NearTopupRequest>;
export const NearTopupResponse = z.object({
  account_id: AccountId,
  payer: NearAccountId,
  tx_id: NearTxHash,
  amount_units: TokenUnits,
  added_mc: Millicredits,
});
export type NearTopupResponse = z.infer<typeof NearTopupResponse>;

// ---------- NEAR wallet login (NEP-413) ----------

/** POST /auth/near/nonce: sign `{message, nonce, recipient}` with the wallet's signMessage. */
export const NearNonceResponse = z.object({
  message: z.string(),
  /** 32 bytes, base64. Single use, expires after a few minutes. */
  nonce: z.string(),
  recipient: z.string(),
  expires_at: TimestampMs,
});
export type NearNonceResponse = z.infer<typeof NearNonceResponse>;
/** The wallet's signMessage result plus the nonce it signed. */
export const NearVerifyRequest = z.object({
  account_id: NearAccountId,
  public_key: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/),
  /** base64 ed25519 signature (64 bytes). */
  signature: z.string().min(80).max(100),
  nonce: z.string(),
  /** Set when the wallet signed with a callbackUrl (redirect wallets such as MyNearWallet): part of the NEP-413 payload. */
  callback_url: z.url().max(500).optional(),
});
export type NearVerifyRequest = z.infer<typeof NearVerifyRequest>;
export const NearVerifyResponse = z.object({
  token: z.string(),
  account_id: AccountId,
  near_account: NearAccountId,
  new_account: z.boolean(),
  /** Starter credits granted to a new account (0 for an existing one, or when the daily cap is reached). */
  starter_granted_mc: Millicredits,
});
export type NearVerifyResponse = z.infer<typeof NearVerifyResponse>;

/** GET /agents/:id/requests (session; own keys only): the key's latest requests, newest first. */
export const AgentRequest = z.object({
  req_id: RequestId,
  model: ModelId,
  status: z.enum(["pending", "ok", "failed"]),
  in_tokens: z.number().int().nonnegative().nullable(),
  out_tokens: z.number().int().nonnegative().nullable(),
  /** Answer cap the gateway picked for the request. */
  max_tokens: z.number().int().positive().nullable(),
  cost_mc: Millicredits.nullable(),
  /** Sequence number on the NEAR ledger contract; null until the write is final. */
  ledger_seq: z.number().int().nonnegative().nullable(),
  ts: TimestampMs,
});
export type AgentRequest = z.infer<typeof AgentRequest>;
export const AgentRequestsResponse = z.object({ requests: z.array(AgentRequest) });
export type AgentRequestsResponse = z.infer<typeof AgentRequestsResponse>;

/** GET /incentives/flags (loopback; operator): collusion flags. Flags only — no automatic penalty. */
export const CollusionFlagsResponse = z.object({
  window_days: z.number().int().positive(),
  flags: z.array(z.object({
    kind: z.enum(["dominant_requester", "mutual_flow", "twin_accounts"]),
    accounts: z.array(AccountId).min(2),
    amount_mc: Millicredits,
    detail: z.string(),
  })),
});
export type CollusionFlagsResponse = z.infer<typeof CollusionFlagsResponse>;

// ---------- POST /nodes/register (session auth) ----------

/**
 * `ramx-node init` prints a link with these fields. The owner opens it, logs in, and the
 * frontend posts it. `node_sig` = EIP-191 personal_sign by the node key over the string
 * `ramx-register:<node_id>:<pool_id>:<ts>` (no JSON, so Python and TS agree byte-for-byte).
 * `ts` must be < 24 hours old.
 */
export const NodeRegisterRequest = z.object({
  node_id: EvmAddress,
  pool_id: PoolId,
  gpu: z.string().min(1),
  mem_gb: z.number().positive(),
  ts: TimestampMs,
  node_sig: HexSig,
  /** SPEC §10.4. Required if the account has no payout address yet. */
  payout_address: NearAccountId.optional(),
});
export type NodeRegisterRequest = z.infer<typeof NodeRegisterRequest>;

export const NodeRegisterResponse = z.object({
  node_id: EvmAddress,
  account_id: AccountId,
  pool_id: PoolId,
});
export type NodeRegisterResponse = z.infer<typeof NodeRegisterResponse>;

// ---------- POST /nodes/heartbeat (node signature in NODE_SIGNATURE_HEADER) ----------

/** Every HEARTBEAT_SECONDS. `ts` must be within 60 s of gateway time (replay guard). */
export const NodeHeartbeat = z.object({
  node_id: EvmAddress,
  pool_id: PoolId,
  ts: TimestampMs,
  online: z.boolean(),
  model: ModelId.nullable(),
  layers: LayerRange.nullable(),
  tok_s: z.number().nonnegative().nullable(),
  // ---- post-MVP P5 (docs/POST_MVP_PLAN.md); null = not known ----
  /** Parallax (Lattica) peer ID of this node's current process. P5.4 admission, P5.8/P5.9 route mapping. */
  peer_id: z.string().min(1).max(128).nullable().default(null),
  /** Current LAN IPv4 of the node. P5.6: the agent restarts Parallax when it changes. */
  lan_ip: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/).nullable().default(null),
  /** P5.7: "swap_growing" = the machine swaps while serving; the router skips the pool. */
  mem_pressure: z.enum(["ok", "swap_growing"]).nullable().default(null),
  /** P5.7: memory the node can use for the model after the OS budget, GB. */
  usable_mem_gb: z.number().nonnegative().nullable().default(null),
  /** P5.9: distinct Parallax sessions this node processed since its previous heartbeat (--notify-url). */
  served_sessions: z.number().int().nonnegative().nullable().default(null),
  /** P5.5: the last pool restart ID this node executed. */
  restart_ack: z.number().int().nonnegative().nullable().default(null),
  /** Largest sequence (prompt + answer, tokens) this node's Parallax process accepts. */
  max_seq: z.number().int().positive().nullable().default(null),
  // ---- SPEC §16.1 automatic pool formation ----
  /** Parallax TCP port of this node (other nodes measure delay to lan_ip:p2p_port). */
  p2p_port: z.number().int().min(1).max(65535).nullable().default(null),
  /** Measured round-trip delay to other nodes, ms (node_id → ms). */
  rtt_ms: z.record(EvmAddress, z.number().nonnegative()).nullable().default(null),
  /** P6.4: result of the signed, bounded hardware benchmark challenge. */
  challenge_result: z.object({
    challenge_id: z.string().min(1).max(80),
    backend: z.enum(["cuda", "mlx", "cpu", "unavailable"]),
    memory_gb: z.number().nonnegative(),
    elapsed_ms: z.number().int().nonnegative(),
    output_hash: Hex32,
    result_hash: Hex32,
  }).nullable().default(null),
});
export type NodeHeartbeat = z.infer<typeof NodeHeartbeat>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

/** POST /nodes/heartbeat response. The node agent copies these into its ramx.node listing. */
export const HeartbeatResponse = z.object({
  ok: z.literal(true),
  owner_account: AccountId,
  reliability: z.number().min(0).max(1),
  /**
   * P5.5 clean restart: the pool's current restart ID (0 = none ordered). The agent restarts its
   * Parallax process group once when this is greater than its `restart_ack`.
   */
  restart_id: z.number().int().nonnegative(),
  /** SPEC §16.1 automatic pool formation: the pool the gateway put this "auto" node in (null = none yet). */
  assigned_pool: z.object({ pool_id: PoolId, dht_prefix: z.string().min(1), model: ModelId }).nullable(),
  /** Nodes to measure delay to (empty most of the time). */
  probe: z.array(z.object({ node_id: EvmAddress, lan_ip: z.string(), port: z.number().int() })),
  /** P6.4: challenge delivered to the agent; it returns a signed result on the next heartbeat. */
  challenge: z.object({ challenge_id: z.string().min(1).max(80), seed: Hex32, expires_at: TimestampMs }).nullable().default(null),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// ---------- GET /pools/:pool_id (no auth; the coordinator writes ramx.pool from it) ----------

/**
 * The gateway's view of a pool, built from the latest fresh heartbeats of the pool's registered
 * nodes (SPEC §5.5). `layer_map` is null unless the reported ranges cover [0, num_layers) of one
 * config model exactly once; `status` is "ready" only then.
 */
export const PoolStateResponse = z.object({
  pool_id: PoolId,
  /** Config model IDs (not MLX variants): the mapped model, else the models the fresh nodes report. */
  models: z.array(ModelId),
  /** Registered nodes of the pool with a fresh heartbeat (online). */
  members: z.array(EvmAddress),
  status: z.enum(["ready", "loading", "offline"]),
  layer_map: Route.nullable(),
  /** P5.5: a clean restart is running (not every member has acknowledged it yet). */
  restarting: z.boolean(),
  /** SPEC §9.2 pool reliability (the pool writer publishes it in the ramx.pool listing). */
  reliability: z.number().min(0).max(1),
  /** Minimum max_seq of the members (tokens); absent until nodes report it. */
  context_length: z.number().int().positive().optional(),
});
export type PoolStateResponse = z.infer<typeof PoolStateResponse>;

// ---------- GET /pools/plan (loopback only; pool/pools-up.sh on the gateway host) ----------

/** SPEC §16.1 automatic pool formation: pools formed from "auto" nodes, for starting their schedulers. */
export const PoolPlanResponse = z.object({
  pools: z.array(z.object({
    pool_id: PoolId,
    model: ModelId,
    members: z.array(EvmAddress),
    /** Private network name for this pool's Parallax DHT. */
    dht_prefix: z.string().min(1),
  })),
  /** "auto" nodes not in any pool yet (no low-delay group with enough memory). */
  waiting: z.array(EvmAddress),
});
export type PoolPlanResponse = z.infer<typeof PoolPlanResponse>;

// ---------- GET /requests/:id (receipt) ----------

/**
 * One try to serve a request (post-MVP P5.2 failover). The last attempt is the one that answered
 * (or failed). Earlier attempts failed: their nodes get a failure outcome and no share.
 */
export const RequestAttempt = z.object({
  pool_id: PoolId,
  /** Heartbeat layer map used for this attempt; null = unknown. */
  route: Route.nullable(),
  outcome: z.enum(["ok", "stalled", "pool_error", "client_aborted", "no_usage"]),
  /** Content chunks already sent to the client by this attempt (about 1 token each). */
  streamed_tokens: z.number().int().nonnegative(),
  /** Route nodes whose last heartbeat was late when the attempt failed (stall suspects). */
  late_nodes: z.array(EvmAddress),
});
export type RequestAttempt = z.infer<typeof RequestAttempt>;

/** Phase J: attestation (fresh nonce) of the NEAR AI Cloud TEE model that served the request. */
export const TeeAttestation = z.object({
  model: z.string(),
  nonce: z.string(),
  signing_address: z.string(),
  attestation_sha256: z.string(),
  attested_at: TimestampMs,
});
export type TeeAttestation = z.infer<typeof TeeAttestation>;

export const TeeCheck = z.object({
  status: z.enum(["queued", "done", "error"]),
  judge_model: z.string().nullable(),
  verdict: z.enum(["plausible", "implausible", "unknown"]).nullable(),
  reason: z.string().nullable(),
  /** TEE signing key of the judge model, attested with a fresh nonce. */
  signing_address: z.string().nullable(),
  /** sha256 of the full attestation report (Intel TDX + NVIDIA). */
  attestation_sha256: z.string().nullable(),
  nonce: z.string().nullable(),
  chat_id: z.string().nullable(),
  /** The judge's response signature recovers to the attested signing address. */
  signature_ok: z.boolean().nullable(),
  /** The signed text is sha256(our request):sha256(the response we got). */
  hashes_match: z.boolean().nullable(),
  error: z.string().nullable(),
  judged_at: TimestampMs.nullable(),
});
export type TeeCheck = z.infer<typeof TeeCheck>;

export const Receipt = z.object({
  req_id: RequestId,
  model: ModelId,
  pay_type: PayType,
  status: z.enum(["pending", "ok", "failed"]),
  account_id: AccountId.nullable(),
  x402_payer: NearAccountId.nullable(),
  x402_tx: NearTxHash.nullable(),
  x402_amount: TokenUnits.nullable(),
  /** NEP-141 token contract of the x402 payment (null for credit requests). */
  x402_asset: NearAccountId.nullable(),
  in_tokens: z.number().int().nonnegative().nullable(),
  out_tokens: z.number().int().nonnegative().nullable(),
  /** Credit requests only; null for x402 and failed requests. */
  cost_mc: Millicredits.nullable(),
  split: CreditSplit.nullable(),
  /** Null = route unknown (no valid layer map at request time, SPEC §5.5); node shares went to reserve. */
  route: Route.nullable(),
  /** P5.8: "scheduler" = the pipeline Parallax really used (hook route log); "heartbeat" = pool layer map. */
  route_source: z.enum(["heartbeat", "scheduler"]).nullable(),
  /** Privacy mode of the request (header x-ramx-privacy); null = normal. Privacy requests store no transcript. */
  privacy: z.enum(["trusted-ends", "trusted-all", "tee"]).nullable(),
  /** "pool" = laptop pool; "near-ai-cloud" = served by a NEAR AI Cloud TEE model (judge mode / privacy "tee"). */
  backend: z.enum(["pool", "near-ai-cloud"]).nullable().optional(),
  prompt_hash: Hex32,
  resp_hash: Hex32.nullable(),
  /** Sequence number of this request's settle event on the NEAR ledger contract; null until final. */
  ledger_seq: z.number().int().nonnegative().nullable(),
  /** NEAR transaction that appended that event (base58); null until final. */
  ledger_tx: NearTxHash.nullable(),
  /** Null = served by the first attempt with no failover record (post-MVP P5.2). */
  attempts: z.array(RequestAttempt).nullable(),
  /** Price multiplier locked for this request; absent on requests before floating prices. */
  price_multiplier: z.number().positive().nullable().optional(),
  /** Phase 6.2 TEE spot-check of this answer (null = not sampled). A plausibility check, not proof. */
  tee_check: TeeCheck.nullable().optional(),
  /** Phase J: attestation of the NEAR AI model that served this request (null = served by a pool). */
  tee_attestation: TeeAttestation.nullable().optional(),
  ts: TimestampMs,
});
export type Receipt = z.infer<typeof Receipt>;

// Gateway routing eligibility for one advertised pool and model.
export const PoolAvailability = z.object({
  available: z.boolean(),
  reason: z.string(),
  action: z.string(),
  checked_at: TimestampMs,
});
export type PoolAvailability = z.infer<typeof PoolAvailability>;

// ---------- GET /network ----------

export const NetworkResponse = z.object({
  pools: z.array(
    DirectoryPool.extend({
      /** Lowest node reliability in the pool (SPEC §9.2). */
      reliability: z.number().min(0).max(1),
      /** 0..1, from the gateway queue. */
      load: z.number().min(0).max(1),
      /** P5.9: node-reported served sessions disagree with the scheduler's routes (last hour). */
      route_dispute: z.boolean(),
      /** P5.5: a clean restart is running. */
      restarting: z.boolean(),
    }),
  ),
  nodes: z.array(DirectoryNode),
  stats: z.array(AccountStats).default([]),
  source: z.literal("gateway"),
});
export type NetworkResponse = z.infer<typeof NetworkResponse>;

// ---------- GET /ledger/events?limit=N ----------

export const LedgerEventsResponse = z.object({
  events: z.array(
    z.object({
      id: z.number().int().positive(),
      /** Sequence number on the NEAR ledger contract; null until the write is final. */
      ledger_seq: z.number().int().nonnegative().nullable(),
      /** NEAR transaction that appended the event; null until final. */
      ledger_tx: NearTxHash.nullable(),
      event: LedgerEvent,
    }),
  ),
});
export type LedgerEventsResponse = z.infer<typeof LedgerEventsResponse>;

// ---------- GET /payouts/:address ----------

export const PayoutsResponse = z.object({
  payout_address: NearAccountId,
  payouts: z.array(
    z.object({
      epoch: EpochNumber,
      amount_units: TokenUnits,
      merkle_root: Hex32,
      proof: z.array(Hex32),
      claimed: z.boolean(),
      claim_tx: NearTxHash.nullable(),
      /** NEAR transaction that funded and posted the epoch (ft_transfer_call). */
      post_tx: NearTxHash.nullable(),
      claimable_at: TimestampMs,
      claimable: z.boolean(),
      swept: z.boolean(),
    }),
  ),
});
export type PayoutsResponse = z.infer<typeof PayoutsResponse>;

// ---------- Phase 7: capacity market (swarm-sim/RULES.md) ----------

export const SwarmRole = z.enum(["buyer", "seller"]);
export type SwarmRole = z.infer<typeof SwarmRole>;
/** A sealed bid: buyers pay at most price_mc per unit; sellers want at least price_mc per unit. */
export const SwarmBid = z.object({ role: SwarmRole, model: ModelId, units: z.number().int().min(1).max(100), price_mc: z.number().int().min(1).max(10_000_000) });
export type SwarmBid = z.infer<typeof SwarmBid>;
const SwarmSigned = {
  round_id: z.number().int().nonnegative(),
  agent: NearAccountId,
  public_key: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/),
  /** NEP-413 signature (base64) by the agent's full-access key; recipient "ramx-swarm". */
  signature: z.string().min(80).max(100),
};
export const SwarmCommitRequest = z.object({ ...SwarmSigned, role: SwarmRole, commit: z.string().regex(/^[0-9a-f]{64}$/) });
export type SwarmCommitRequest = z.infer<typeof SwarmCommitRequest>;
export const SwarmRevealRequest = z.object({ ...SwarmSigned, bid: SwarmBid, salt: z.string().regex(/^[0-9a-f]{32,64}$/) });
export type SwarmRevealRequest = z.infer<typeof SwarmRevealRequest>;

export const SwarmAllocation = z.object({ agent: NearAccountId, role: SwarmRole, units: z.number().int().positive(), price_mc: Millicredits, amount_mc: Millicredits, payment: z.enum(["due", "paid"]) });
export const SwarmGroupOrder = z.object({
  model: ModelId,
  price_mc: Millicredits,
  units: z.number().int().positive(),
  allocations: z.array(SwarmAllocation),
  allocations_sha256: z.string(),
  /** Ledger event id and NEAR tx once written. */
  ledger_seq: z.number().int().nullable(),
  ledger_tx: z.string().nullable(),
});
export const SwarmRoundResponse = z.object({
  round_id: z.number().int().nonnegative(),
  phase: z.enum(["commit", "reveal", "cleared", "open"]),
  commit_ends_at: TimestampMs,
  reveal_ends_at: TimestampMs,
  commits: z.array(z.object({ agent: NearAccountId, role: SwarmRole, commit: z.string(), revealed: z.boolean() })),
  bids: z.array(SwarmBid.extend({ agent: NearAccountId })),
  commits_sha256: z.string().nullable(),
  orders: z.array(SwarmGroupOrder),
});
export type SwarmRoundResponse = z.infer<typeof SwarmRoundResponse>;
export const SwarmRoundsResponse = z.object({ round_ms: z.number().int().positive(), current: z.number().int(), rounds: z.array(SwarmRoundResponse) });
export type SwarmRoundsResponse = z.infer<typeof SwarmRoundsResponse>;
