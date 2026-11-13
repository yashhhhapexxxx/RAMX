/** Live gateway and NEAR RPC access. Errors never substitute fixtures. */
import type { PriceQuote, Receipt } from "@shared/types";
import { decryptWith, e2eeHeaders, encryptMessages } from "../../lib/e2ee";
import { ModelsResponse, NearNonceResponse, NearTopupResponse, NearVerifyResponse, WorldVerifyResponse, NodeRegisterRequest, NodeRegisterResponse } from "@ramx/shared";
import config from "../../../../shared/config/ramx.config.json";
import { meFromWire, receiptFromWire, networkFromWire, ledgerFromWire, rpFromWire, payoutsFromWire, keysFromWire, newKeyFromWire, keyRequestsFromWire } from "./adapters";
import { env } from "../../config/env";
import { NotImplementedError, PaymentRequired, SessionExpired } from "../api";
import type { ChatChunk, LoginResult, ModelOffer, PoolApi } from "../api";


const base = () => env.gatewayUrl.replace(/\/$/, ""); // "" → same origin (Vite proxies the gateway paths)
const auth = (token?: string | null): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** Pull a readable message out of a gateway error body ({error:{message}} or {error} or {message}). */
async function errorText(res: Response, path: string) {
  try {
    const j = (await res.json()) as { error?: string | { message?: string }; message?: string };
    const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
    if (m) return m;
  } catch {
    /* not JSON */
  }
  return `${path} → HTTP ${res.status}`;
}

async function call<T>(path: string, init: RequestInit & { what?: string } = {}): Promise<T> {
  const res = await fetch(`${base()}${path}`, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (res.status === 404) throw new NotImplementedError(init.what ?? path);
  if (res.status === 402) throw new PaymentRequired();
  if (res.status === 401) throw new SessionExpired();
  if (res.status >= 500) throw new Error(`HTTP ${res.status} from ${path}`);
  if (!res.ok) throw new Error(await errorText(res, path));
  return (await res.json()) as T;
}
const get = <T,>(path: string, token?: string | null) => call<T>(path, { headers: auth(token) });
/** TEMPORARY (staging World simulator gives one nullifier to everyone): random id per browser; the gateway
 *  keys simulator accounts by nullifier + this id when WORLD_SIMULATOR_DEVICE_ACCOUNTS=true. Ignored in production. */
const DEVICE_KEY = "ramx.device.v1";
function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id || !/^[0-9a-f]{32,64}$/.test(id)) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
const post = <T,>(path: string, body: unknown, token?: string | null, what?: string) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body), headers: auth(token), what });

/** /v1/models is OpenAI-shaped. Metadata (factor, size, layers) comes from ramx.model; the
    config table in spec §8.1 fills the gaps for the two MVP models. */
function toOffer(entry: Record<string, unknown>): ModelOffer {
  const id = String(entry.id ?? entry.model_id);
  const known = config.models.find((m) => m.model_id === id);
  return {
    served: entry.served !== false,
    pools: Number(entry.pools ?? 0),
    ...(typeof entry.context_length === "number" ? { context_length: entry.context_length } : {}),
    ...(entry.price ? { price: entry.price as PriceQuote } : {}),
    ...(typeof entry.tee_model === "string" ? { tee_model: entry.tee_model } : {}),
    model: {
      model_id: id,
      mlx_variant: (entry.mlx_variant as string | null | undefined) ?? known?.mlx_variant ?? null,
      size_gb: Number(entry.size_gb ?? known?.size_gb ?? 0),
      model_factor: Number(entry.model_factor ?? known?.model_factor ?? 1),
      license: String(entry.license ?? known?.license ?? "—"),
      params_b: Number(entry.params_b ?? 0),
      total_layers: Number(entry.total_layers ?? known?.num_layers ?? 0),
    },
  };
}

export const liveApi: PoolApi = {
  mode: "live",

  auth: {
    rpContext: async () => rpFromWire(await post("/auth/world/rp-signature", {}, null, "World login")),
    async verify(result) {
      const r = WorldVerifyResponse.parse(await call("/auth/world/verify", { method: "POST", body: JSON.stringify(result), headers: { "x-ramx-device": deviceId() }, what: "World login" }));
      return { token:r.token, created:r.new_account, me:await liveApi.me(r.token) } satisfies LoginResult;
    },
    nearNonce: async () => NearNonceResponse.parse(await post("/auth/near/nonce", {}, null, "NEAR login")),
    async nearVerify(signed) {
      const r = NearVerifyResponse.parse(await post("/auth/near/verify", signed, null, "NEAR login"));
      return { token: r.token, created: r.new_account, me: await liveApi.me(r.token) } satisfies LoginResult;
    },
  },
  me: async (token) => meFromWire(await get("/me", token)),
  async nearTopup(token, t) {
    const r = NearTopupResponse.parse(await post("/v1/credits/near-topup", t, token, "USDC top-up"));
    return { added: r.added_mc / 1000, tx: r.tx_id };
  },
  async registerNode(token, link) {
    NodeRegisterResponse.parse(await post("/nodes/register", NodeRegisterRequest.parse(link), token, "node registration"));
    return liveApi.me(token);
  },

  keys: async (token) => keysFromWire(await get("/agents", token)),
  createKey: async (token, name, cap) => newKeyFromWire(await post("/agents", { name, ...(cap === null ? {} : { budget_mc: Math.round(cap * 1000) }) }, token, "API keys")),
  async revokeKey(token, id) {
    await call(`/agents/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(token), what: "API key" });
  },
  keyRequests: async (token, id) => keyRequestsFromWire(await get(`/agents/${encodeURIComponent(id)}/requests`, token)),

  async models() {
    const r = ModelsResponse.parse(await get("/v1/models"));
    return r.data.map(toOffer);
  },

  async *chat(body, token, signal): AsyncIterable<ChatChunk> {
    const t0 = Date.now();
    // End-to-end encryption: only with the enclave, and never a silent fallback to plain text.
    const e2ee = body.e2ee ?? null;
    if (e2ee && body.privacy !== "tee") throw new Error("End-to-end encryption needs the secure hardware (TEE) mode");
    const messages = e2ee ? encryptMessages(body.messages, e2ee.enclave) : body.messages;
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...auth(token),
        ...(body.pool_id && !body.privacy ? { "x-ramx-pool": body.pool_id } : {}),
        ...(body.privacy ? { "x-ramx-privacy": body.privacy } : {}),
        ...(e2ee ? e2eeHeaders(e2ee.client, e2ee.enclave) : {}),
      },
      body: JSON.stringify({ model: body.model, messages, max_tokens: body.max_tokens, stream: true }),
      signal,
    });
    if (res.status === 402) throw new PaymentRequired();
    if (res.status === 401) throw new SessionExpired();
    if (res.status === 503) throw new Error(body.pool_id ? `Pool ${body.pool_id} cannot serve ${body.model} right now. You paid nothing.` : `No pool is serving ${body.model} right now. You paid nothing.`);
    if (!res.ok || !res.body) throw new Error(await errorText(res, "/v1/chat/completions"));
    const routeHeader = res.headers.get("x-ramx-route");
    let receiptId: string | undefined = res.headers.get("x-ramx-request-id") ?? undefined;
    let first = true;
    let tokens = 0;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { delta: "", done: true, receipt_id: receiptId };
          return;
        }
        const j = JSON.parse(data) as { id?: string; choices?: { delta?: { content?: string } }[] };
        receiptId ??= j.id;
        if ("error" in j) throw new Error(JSON.stringify(j.error));
        const raw = j.choices?.[0]?.delta?.content ?? "";
        // Each streamed chunk is encrypted on its own; decrypt it here, in the browser.
        let delta = raw;
        if (e2ee && raw) {
          try { delta = decryptWith(raw, e2ee.client.secret); }
          catch { throw new Error("Could not decrypt the enclave's answer; nothing was shown"); }
        }
        if (first) {
          first = false;
          yield { delta: "", ttft_ms: Date.now() - t0, route: routeHeader ? JSON.parse(routeHeader) : undefined };
        }
        if (delta) {
          tokens++;
          yield { delta, tok_s: +(tokens / Math.max((Date.now() - t0) / 1000, 0.05)).toFixed(1) };
        }
      }
    }
    throw new Error("Inference stream ended without a completion marker");
  },
  request: async (id) => receiptFromWire(await get(`/requests/${encodeURIComponent(id)}`)),
  async myRequests(token) {
    // No list endpoint in §5.2: find this account's request_settled events, then read each receipt.
    const me = await liveApi.me(token);
    const events = await liveApi.ledger({type:"request_settled",limit:100});
    const ids = events.filter((e) => e.payload.account_id === me.account_id).slice(0, 10).map((e) => String(e.payload.req_id));
    return Promise.all(ids.map((id) => liveApi.request(id) as Promise<Receipt>));
  },

  async network() {
    return networkFromWire(await get("/network"));
  },
  subscribe(cb) {
    let stopped = false;
    const tick = () =>
      liveApi.network().then(
        (s) => !stopped && cb(s),
        () => undefined,
      );
    void tick();
    const id = setInterval(tick, 5_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  },

  ledger(opts) {
    const q = new URLSearchParams();

    q.set("limit", String(Math.min(100, opts?.limit ?? 100)));
    return get(`/ledger/events?${q}`).then(ledgerFromWire).then(rows => opts?.type ? rows.filter(r=>r.type===opts.type) : rows);
  },
  async onChain(contract, seq) {
    // view call: ledger.seq() = last sequence number appended (events are appended in order).
    const res = await fetch(env.nearRpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: contract, method_name: "seq", args_base64: btoa("{}") } }) });
    if (!res.ok) throw new Error(`NEAR RPC → HTTP ${res.status}`);
    const j = (await res.json()) as { result?: { result: number[] }; error?: { message?: string } };
    if (!j.result) throw new Error(`NEAR RPC: ${j.error?.message ?? "no result"}`);
    const last = Number(new TextDecoder().decode(Uint8Array.from(j.result.result)));
    return { found: last >= seq, on_chain_seq: last };
  },

  payouts: async (address) => payoutsFromWire(await get(`/payouts/${encodeURIComponent(address)}`)),
  async claim() {
    throw new Error("In live mode the claim is a transaction from your wallet (payout contract claim; see the command on the Payouts page).");
  },
};
