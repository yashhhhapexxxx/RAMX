import type { ClientKey, EnclaveKey } from "../lib/e2ee";
import type {
  PriceQuote,
  AccountStats,
  Epoch,
  LedgerEvent,
  LedgerType,
  Me,
  ModelEntry,
  NodeListing,
  Payout,
  PoolListing,
  Receipt,
  RouteHop,
} from "@shared/types";

/** One streamed chunk of a playground reply. */
export type ChatChunk = {
  delta: string;
  tok_s?: number;
  ttft_ms?: number;
  route?: RouteHop[];
  done?: boolean;
  receipt_id?: string;
};

export type ChatBody = {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  max_tokens: number;
  /** Pin one pool (header x-ramx-pool, SPEC §8.8 routing preferences). Unset = the router picks. */
  pool_id?: string;
  /** Privacy mode (header x-ramx-privacy). Unset = normal routing. */
  privacy?: PrivacyMode;
  /** End-to-end encryption to the attested enclave (only with privacy "tee"). */
  e2ee?: { client: ClientKey; enclave: EnclaveKey };
};

/** "trusted-all": only the requester's own or trusted laptops, else the enclave. "tee": only the enclave. */
export type PrivacyMode = "trusted-all" | "tee";

/** World ID 4 RP context, signed by the gateway (/auth/world/rp-signature). The signing key never reaches the client. */
export type WorldRpContext = { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string; app_id: `app_${string}`; action: string; environment: "staging" | "production" };

/** POST /auth/near/nonce. `nonce` is 32 bytes, base64. */
export type NearNonce = { message: string; nonce: string; recipient: string; expires_at: number };
/** A wallet's NEP-413 signMessage result plus what it signed. */
export type NearSigned = { account_id: string; public_key: string; signature: string; nonce: string; callback_url?: string };

/** /auth/world/verify. `created: false` = this human already has an account (no new starter credits). */
export type LoginResult = { token: string; me: Me; created: boolean };

/** `pools` = ready pools serving the model now (from /v1/models). */
/** `context_length` = smallest live pool context; `price` = current credit quote (floats 0.5×–2× with load). Both absent until the pools report them. */
export type ModelOffer = { model: ModelEntry; served: boolean; pools: number; context_length?: number; price?: PriceQuote; /** NEAR AI Cloud model that serves this id in the enclave (attest it to encrypt end to end). */ tee_model?: string };

export type NetworkSnapshot = { pools: PoolListing[]; nodes: NodeListing[]; stats: AccountStats[]; updated_at: number };

export type NodeLink = { node_id: string; pool_id: string; node_sig: string; ts: number; gpu: string; mem_gb: number; payout_address?: string };

/** Is ledger event #seq on the ledger contract? `on_chain_seq` = the contract's last sequence number. */
export type ChainCheck = { found: boolean; on_chain_seq?: number };

/** An API key (gateway agent key): spends this account's credits, up to `cap` (null = whole balance). Credits, not mc. */
/** `bought` = credits bought for this key with testnet USDC, not spent yet; only this key spends them, before the account's. */
export type ApiKey = { id: string; name: string; cap: number | null; spent: number; revoked: boolean; created_at: number; last_used_at: number | null; bought: number; boughtTotal: number };
/** Returned once, at creation: `Authorization: Bearer <token>`. */
export type NewApiKey = ApiKey & { token: string };
/** One request made with a key (newest first). `max_tokens` = the answer cap the gateway picked. */
export type KeyRequest = { req_id: string; model: string; status: "pending" | "ok" | "failed"; in_tokens: number | null; out_tokens: number | null; max_tokens: number | null; cost: number | null; ledger_seq: number | null; ts: number };

export interface PoolApi {
  readonly mode: "mock" | "live";

  auth: {
    /** Signed RP context for an IDKit request. `null` = no RP configured (demo: simulate instead). */
    rpContext(): Promise<WorldRpContext | null>;
    /** Sends the IDKit result to the gateway without changes. */
    verify(result: unknown): Promise<LoginResult>;
    /** NEAR wallet login (NEP-413): the message, nonce and recipient the wallet must sign. */
    nearNonce(): Promise<NearNonce>;
    /** The wallet's signMessage result → session. A new account gets starter credits (daily cap). */
    nearVerify(signed: NearSigned): Promise<LoginResult>;
  };
  me(token: string): Promise<Me>;
  /** POST /nodes/register: link a node key to the account (up to `/me.incentives.node_cap`). */
  registerNode(token: string, link: NodeLink): Promise<Me>;

  /** GET /v1/models: every known model and whether a live pool serves it now. */
  models(): Promise<ModelOffer[]>;
  /** Credits with a session token. Without one the gateway answers 402 (x402). */
  chat(body: ChatBody, token: string | null, signal: AbortSignal): AsyncIterable<ChatChunk>;
  request(id: string): Promise<Receipt | null>;
  /** The account's recent receipts (for /account). */
  myRequests(token: string): Promise<Receipt[]>;

  network(): Promise<NetworkSnapshot>;
  /** Live pool updates (gateway poll, or the mock ticker). Returns unsubscribe. */
  subscribe(cb: (s: NetworkSnapshot) => void): () => void;

  /** GET /ledger/events, newest first. */
  ledger(opts?: { type?: LedgerType; limit?: number }): Promise<LedgerEvent[]>;
  /** NEAR RPC: check that ledger event #seq is on the ledger contract (seq() >= seq). */
  onChain(topic: string, seq: number): Promise<ChainCheck>;

  /** GET /agents: this account's API keys. */
  keys(token: string): Promise<ApiKey[]>;
  /** POST /agents. `cap` in credits; null = no cap. The token comes back once. */
  createKey(token: string, name: string, cap: number | null): Promise<NewApiKey>;
  /** DELETE /agents/:id. */
  revokeKey(token: string, id: string): Promise<void>;
  /** GET /agents/:id/requests. */
  keyRequests(token: string, id: string): Promise<KeyRequest[]>;

  /** POST /v1/credits/near-topup: credit a USDC ft_transfer to the treasury (memo = account id). */
  nearTopup(token: string, t: { tx_hash: string; sender: string }): Promise<{ added: number; tx: string }>;
  /** GET /payouts/:address: all epochs and this address's Merkle leaves. */
  payouts(address: string): Promise<{ epochs: Epoch[]; payouts: Payout[] }>;
  /** Demo only. In live mode the claim is a wallet transaction (payout contract claim). */
  claim(payout: Payout): Promise<{ tx: string }>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not available from the live backend yet`);
    this.name = "NotImplementedError";
  }
}

/** HTTP 402 from the gateway: no session and no x402 payment. */
export class PaymentRequired extends Error {
  constructor() {
    super("Log in with World ID to use credits. AI agents pay per request with x402.");
    this.name = "PaymentRequired";
  }
}

/** HTTP 401 / unknown token: the session is gone, log in again. */
export class SessionExpired extends Error {
  constructor() {
    super("Your session expired. Log in again.");
    this.name = "SessionExpired";
  }
}
