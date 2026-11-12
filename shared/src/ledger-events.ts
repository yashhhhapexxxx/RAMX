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
  Millicredits,
  ModelId,
  RequestId,
  Route,
  TokenUnits,
  TimestampMs,
} from "./common.ts";

/**
 * Ledger events (SPEC §8.6, §10.2), appended to the NEAR ledger contract. One entry per event, < 1 KB.
 * `sig` = ed25519 signature (GATEWAY_SIGNING_KEY) over the canonical JSON of the event
 * without `sig`: keys sorted recursively, no whitespace, UTF-8.
 * The same JSON (with sig) is stored in `ledger_events.payload`.
 */

/** #7: privacy mode the request was served under (header x-ramx-privacy); absent = normal. Signed, so provable. */
const RequestPrivacy = z.enum(["trusted-ends", "trusted-all", "tee"]);

const base = {
  v: z.literal(1),
  ts: TimestampMs,
  sig: HexSig,
};

export const AccountCreatedEvent = z.object({
  ...base,
  type: z.literal("account_created"),
  account_id: AccountId,
});

export const StarterGrantEvent = z.object({
  ...base,
  type: z.literal("starter_grant"),
  account_id: AccountId,
  amount_mc: Millicredits,
  expires_at: TimestampMs,
});

/** A credit-paid request was settled. Failed requests cost nothing and write no event. */
export const RequestSettledEvent = z.object({
  ...base,
  type: z.literal("request_settled"),
  price_multiplier: z.number().min(0.5).max(2).optional(),
  req_id: RequestId,
  account_id: AccountId,
  model: ModelId,
  in_tokens: z.number().int().nonnegative(),
  out_tokens: z.number().int().nonnegative(),
  cost_mc: Millicredits,
  split: CreditSplit,
  pay: z.literal("credits"),
  /** Part of cost_mc paid from the API key's bought credits; the rest came from the account. */
  key_mc: Millicredits.optional(),
  prompt_hash: Hex32,
  resp_hash: Hex32,
  privacy: RequestPrivacy.optional(),
  /** The prompt and answer were end-to-end encrypted to the enclave: RAMX only relayed ciphertext. */
  e2ee: z.literal(true).optional(),
});

/** An x402-paid request was served. Providers are paid in USDC at epoch close, from `route`. */
export const X402PaymentEvent = z.object({
  ...base,
  type: z.literal("x402_payment"),
  req_id: RequestId,
  payer: NearAccountId,
  tx_id: NearTxHash,
  /** Paid amount in base units of `asset`. */
  amount_units: TokenUnits,
  /** NEP-141 token contract paid (USDC on NEAR). */
  asset: NearAccountId,
  model: ModelId,
  in_tokens: z.number().int().nonnegative(),
  out_tokens: z.number().int().nonnegative(),
  /** Null = route unknown (SPEC §5.5); the provider share of this request stays in the treasury. */
  route: Route.nullable(),
  pay: z.literal("x402"),
  prompt_hash: Hex32,
  resp_hash: Hex32,
  privacy: RequestPrivacy.optional(),
  /** The prompt and answer were end-to-end encrypted to the enclave: RAMX only relayed ciphertext. */
  e2ee: z.literal(true).optional(),
});

export const CreditsExpiredEvent = z.object({
  ...base,
  type: z.literal("credits_expired"),
  account_id: AccountId,
  amount_mc: Millicredits,
  /** SPEC §8.2 starter credits (MVP) or §16.3 earned credits older than earned_expiry_days. */
  kind: z.enum(["starter", "earned"]).default("starter"),
});

export const PayoutAddressSetEvent = z.object({
  ...base,
  type: z.literal("payout_address_set"),
  account_id: AccountId,
  payout_address: NearAccountId,
});

export const EpochClosedEvent = z.object({
  ...base,
  type: z.literal("epoch_closed"),
  epoch: EpochNumber,
  start_ts: TimestampMs,
  end_ts: TimestampMs,
  total_units: TokenUnits,
  merkle_root: Hex32,
  /** sha256 of the canonical JSON of the full payout list. */
  payouts_hash: Hex32,
  /** Full list if the message stays < 1 KB; otherwise null and the gateway keeps it. */
  payouts: z.array(z.object({ payout_address: NearAccountId, amount_units: TokenUnits })).nullable(),
});

export const PayoutClaimedEvent = z.object({
  ...base,
  type: z.literal("payout_claimed"),
  epoch: EpochNumber,
  payout_address: NearAccountId,
  amount_units: TokenUnits,
  /** NEAR transaction of the `claim` call; null when the gateway saw the claim on the contract state only. */
  claim_tx: NearTxHash.nullable(),
});

/** Model verification audit record. It never changes billing, provider earnings, or reliability. */
export const VerificationResultEvent = z.object({
  ...base,
  type: z.literal("verification_result"),
  verification_id: z.string().min(1).max(80),
  req_id: RequestId,
  pool_id: z.string().min(1).max(80),
  route_hash: Hex32,
  score: z.number().finite().nonnegative(),
  threshold: z.number().finite().nonnegative(),
  verdict: z.enum(["pass", "flag"]),
});

export const VerificationAppealEvent = z.object({
  ...base,
  type: z.literal("verification_appeal"),
  verification_id: z.string().min(1).max(80),
  appeal_id: z.string().min(1).max(80),
  account_id: AccountId,
});

export const VerificationFinalEvent = z.object({
  ...base,
  type: z.literal("verification_final"),
  verification_id: z.string().min(1).max(80),
  req_id: RequestId,
  verdict: z.enum(["pass", "flag"]),
});

export const HardwareChallengeEvent = z.object({
  ...base,
  type: z.literal("hardware_challenge"),
  challenge_id: z.string().min(1).max(80),
  node_id: EvmAddress,
  result: z.enum(["passed", "failed", "expired"]),
  backend: z.enum(["cuda", "mlx", "cpu", "unavailable"]).nullable(),
  memory_gb: z.number().nonnegative().nullable(),
  elapsed_ms: z.number().int().nonnegative().nullable(),
});

export const VerificationCanaryEvent = z.object({
  ...base,
  type: z.literal("verification_canary"),
  canary_id: z.string().min(1).max(80),
  pool_id: z.string().min(1).max(80),
  model: ModelId,
  route_hash: Hex32,
  score: z.number().finite().nonnegative(),
  threshold: z.number().finite().nonnegative(),
  verdict: z.enum(["pass", "flag"]),
});

// ---------- SPEC §16.3 incentives ----------

/** Locked (unvested) credits taken back after a final fraud verdict; they go to the network reserve. */
export const CreditsClawedBackEvent = z.object({
  ...base,
  type: z.literal("credits_clawed_back"),
  account_id: AccountId,
  amount_mc: Millicredits,
  /** The final verification that proves the fraud. */
  evidence_id: z.string().min(1).max(80),
});

/** The World nullifier of this account may no longer run nodes. */
export const AccountBannedEvent = z.object({
  ...base,
  type: z.literal("account_banned"),
  account_id: AccountId,
  evidence_id: z.string().min(1).max(80),
});

/** Standby credits from the network reserve for a node that was online while its pool had a queue. */
export const AvailabilityRewardEvent = z.object({
  ...base,
  type: z.literal("availability_reward"),
  account_id: AccountId,
  node_id: EvmAddress,
  amount_mc: Millicredits,
  epoch_start: z.number().int().nonnegative(),
});

/** A human-backed agent key (World Agent Pass, MVP form): the human's credits, with a budget. */
export const AgentKeyCreatedEvent = z.object({
  ...base,
  type: z.literal("agent_key_created"),
  account_id: AccountId,
  agent_id: z.string().regex(/^agt_[A-Za-z0-9]+$/),
  /** null = no cap (the key may spend the whole balance). */
  budget_mc: Millicredits.nullable(),
});

/**
 * Testnet USDC paid to the treasury bought credits: for one API key (x402 top-up, or a guarded
 * agent's escrow payment) or for an account (a wallet ft_transfer). The USDC stays in the treasury.
 */
export const CreditsPurchasedEvent = z.object({
  ...base,
  type: z.literal("credits_purchased"),
  account_id: AccountId,
  /** null = account credits (wallet top-up). */
  agent_id: z.string().regex(/^agt_[A-Za-z0-9]+$/).nullable(),
  via: z.enum(["x402", "escrow", "wallet"]),
  payer: NearAccountId,
  tx_id: NearTxHash,
  amount_units: TokenUnits,
  amount_mc: Millicredits,
});

/**
 * Phase 6.2: a sampled answer was judged by a model in NEAR AI Cloud's secure hardware (TEE). A
 * plausibility check, not proof of correct execution. `signing_address` is the TEE key attested
 * with a fresh nonce; `signature_ok` = the judge's response signature recovers to it.
 */
export const TeeCheckEvent = z.object({
  ...base,
  type: z.literal("tee_check"),
  req_id: RequestId,
  judge_model: z.string(),
  verdict: z.enum(["plausible", "implausible", "unknown"]),
  signing_address: z.string().regex(/^0x[0-9a-f]{40}$/),
  attestation_sha256: Hex32,
  signature_ok: z.boolean(),
});

/**
 * #8: an answer served by NEAR AI Cloud was signed inside a TEE. `signature_ok` = NEAR AI's per-chat
 * signature recovers to a key attested with a fresh nonce (the model's, or NEAR AI's gateway's);
 * `hashes_match` = the signed text is sha256(request bytes):sha256(response bytes) of this exact exchange.
 */
export const TeeAnswerSignedEvent = z.object({
  ...base,
  type: z.literal("tee_answer_signed"),
  req_id: RequestId,
  model: z.string(),
  chat_id: z.string(),
  signing_address: z.string().regex(/^0x[0-9a-f]{40}$/),
  /** Which attested TEE key signed: the model instance, or NEAR AI's own gateway (streamed answers). */
  signed_by: z.enum(["model", "nearai_gateway"]),
  attestation_sha256: Hex32,
  signature_ok: z.boolean(),
  hashes_match: z.boolean(),
});

/**
 * Phase 7: one capacity-market round cleared for one model (swarm-sim/RULES.md). The full commit and
 * allocation lists are at GET /swarm/rounds/:id; their sha256 hashes are here.
 */
export const SwarmClearedEvent = z.object({
  ...base,
  type: z.literal("swarm_cleared"),
  round_id: z.number().int().nonnegative(),
  model: z.string(),
  price_mc: Millicredits,
  units: z.number().int().positive(),
  buyers: z.number().int().nonnegative(),
  sellers: z.number().int().nonnegative(),
  allocations_sha256: Hex32,
  commits_sha256: Hex32,
});

export const LedgerEvent = z.discriminatedUnion("type", [
  AccountCreatedEvent,
  StarterGrantEvent,
  RequestSettledEvent,
  X402PaymentEvent,
  CreditsExpiredEvent,
  PayoutAddressSetEvent,
  EpochClosedEvent,
  PayoutClaimedEvent,
  VerificationResultEvent,
  VerificationAppealEvent,
  VerificationFinalEvent,
  HardwareChallengeEvent,
  VerificationCanaryEvent,
  CreditsClawedBackEvent,
  AccountBannedEvent,
  AvailabilityRewardEvent,
  AgentKeyCreatedEvent,
  CreditsPurchasedEvent,
  TeeCheckEvent,
  SwarmClearedEvent,
  TeeAnswerSignedEvent,
]);
export type LedgerEvent = z.infer<typeof LedgerEvent>;
export type LedgerEventType = LedgerEvent["type"];
export const LEDGER_EVENT_TYPES = LedgerEvent.options.map((o) => o.shape.type.value);
