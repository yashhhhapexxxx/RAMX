import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { NearAccountId, LedgerEventsResponse, ModelsResponse, NetworkResponse, PoolAvailability, PayoutsResponse, PoolId, Receipt, REQUEST_ID_HEADER, RequestId, PRICE_HEADER } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { chatHandler, logCompletion, type OnComplete } from "./chat.ts";
import { errorResponse } from "./errors.ts";
import type { Signer } from "./events.ts";
import { session } from "./auth.ts";
import { makePrepare } from "./billing.ts";
import { me } from "./accounts.ts";
import { heartbeatHandler, registerHandler } from "./nodes.ts";
import { poolState } from "./route.ts";
import { rpSignatureHandler, verifyHandler, type WorldFetch } from "./world.ts";
import type { X402 } from "./x402.ts";
import { ChainCheckError, escrowPayment, rpcTxLookup, walletTransfer, type NearTxLookup } from "./chain-credits.ts";
import { nearNonceHandler, nearVerifyHandler, rpcKeyLookup, type NearKeyLookup } from "./near-auth.ts";
import { teeCheckOf } from "./tee-judge.ts";
import { marketRoutes } from "./market.ts";
import { payoutsFor } from "./settlement.ts";
import { createPoolQueue, type PoolQueue } from "./queue.ts";
import { createRouter, type Directory, type Router } from "./router.ts";
import { gatewayDirectory } from "./directory.ts";
import { createStallTracker } from "./stall.ts";
import { HASH_SALT_HEADER } from "./privacy.ts";
import { AgentKeyCreateRequest, AgentKeyCreateResponse, AgentKeyListResponse, AgentRequestsResponse, CollusionFlagsResponse, CreditTopupRequest, CreditTopupResponse, EscrowCreditRequest, KeyCreditsResponse, NearTopupRequest, NearTopupResponse } from "@ramx/shared";
import { agentFromToken, agentRequests, collusionFlags, createAgentKey, creditAccountTopup, creditTopup, isBanned, keyCredits, listAgentKeys, revokeAgentKey } from "./incentives.ts";
import { getConnInfo } from "@hono/node-server/conninfo";
import { PoolPlanResponse } from "@ramx/shared";
import { poolPlan } from "./formation.ts";
import { verificationAppealHandler, verificationReadHandler } from "./verification.ts";
import { agentRegistration } from "./erc8004.ts";
import { providerRoutes } from "./providers.ts";
import { ProviderRelay } from "./provider-relay.ts";
import { providerAvailable } from "./provider-state.ts";

export type Deps = {
  cfg: Config;
  db: Db;
  signer: Signer;
  /** null = x402 not configured: requests without a session get 402 payment_required. */
  x402?: X402 | null;
  worldFetch?: WorldFetch;
  directory?: Directory;
  router?: Router;
  queue?: PoolQueue;
  /** Observer, runs after billing for every completion. */
  onComplete?: OnComplete;
  providerRelay?: ProviderRelay;
  /** NEAR RPC lookups (tests inject fakes). Default: the configured RPC. */
  nearTx?: NearTxLookup;
  nearKeys?: NearKeyLookup;
};

export const newReqId = (): string => `req_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;

export type AppEnv = { Variables: { reqId: string; accountId: string | null; agentId: string | null } };

type RequestRow = {
  req_id: string; model: string; pay_type: "credits" | "x402"; status: "pending" | "ok" | "failed"; account_id: string | null;
  x402_payer: string | null; x402_tx: string | null; x402_amount: string | null; x402_asset: string | null; in_tokens: number | null; out_tokens: number | null;
  cost_mc: number | null; split: string | null; route: string | null; prompt_hash: string; resp_hash: string | null; ledger_seq: number | null; ledger_tx: string | null; attempts: string | null; route_source: "heartbeat" | "scheduler" | null; privacy: "trusted-ends" | "trusted-all" | null; ts: number;
};

export function createApp({ cfg, db, signer, x402 = null, worldFetch, directory, router: injectedRouter, queue: injectedQueue, onComplete = logCompletion, providerRelay = new ProviderRelay(), nearTx, nearKeys }: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const secret = cfg.env.JWT_SECRET;
  const queue = injectedQueue ?? createPoolQueue(cfg.net.router.max_concurrent_per_pool);
  const dir = directory ?? gatewayDirectory(cfg, db);
  const router = injectedRouter ?? createRouter(cfg, db, dir, queue);
  const stall = createStallTracker(cfg.net);

  if (cfg.corsOrigins.length > 0) {
    app.use("*", cors({ origin: cfg.corsOrigins, exposeHeaders: [REQUEST_ID_HEADER, "PAYMENT-REQUIRED", "PAYMENT-RESPONSE", HASH_SALT_HEADER, PRICE_HEADER] }));
  }

  // Every /v1/chat/completions response carries the request id, errors included.
  app.use("/v1/chat/completions", async (c, next) => {
    const reqId = newReqId();
    c.set("reqId", reqId);
    await next();
    c.res.headers.set(REQUEST_ID_HEADER, reqId);
  });

  app.get("/healthz", (c) => c.json({ ok: true as const }));
  app.get("/.well-known/agent-registration.json", (c) => cfg.env.PUBLIC_URL
    ? c.json(agentRegistration(cfg)) : errorResponse(c, 503, "internal", "agent registration needs PUBLIC_URL"));

  // Session if an Authorization header is present (invalid → 401), else x402 (SPEC §5.3 step 2).
  app.post("/v1/chat/completions", session(secret, false, (t) => agentFromToken(db, t)), chatHandler(cfg, makePrepare({ cfg, db, signer, x402, router, queue, observe: onComplete }), stall, (url, init) => {
    if (url.protocol !== "provider:") return fetch(url, init);
    if (!providerAvailable(db, url.hostname)) return Promise.reject(new Error("Provider coordinator is offline"));
    return providerRelay.forward(url.hostname, "/v1/chat/completions", JSON.parse(String(init.body)), init.signal ?? undefined);
  }, (m) => router.contextLength(m)));
  app.route("/provider", providerRoutes(db, cfg, signer, providerRelay, dir));

  app.post("/auth/world/rp-signature", rpSignatureHandler(cfg));
  app.post("/auth/world/verify", verifyHandler(db, cfg, signer, worldFetch));
  app.post("/auth/near/nonce", nearNonceHandler(db));
  // Phase 7 capacity market (swarm-sim/RULES.md).
  const market = marketRoutes(db, cfg, nearKeys ?? rpcKeyLookup(cfg.env.NEAR_RPC_URL));
  app.post("/swarm/commit", market.commit);
  app.post("/swarm/reveal", market.reveal);
  app.get("/swarm/rounds", market.rounds);
  app.get("/swarm/rounds/:id", market.round);
  app.post("/auth/near/verify", nearVerifyHandler(db, cfg, signer, nearKeys ?? rpcKeyLookup(cfg.env.NEAR_RPC_URL)));

  app.get("/me", session(secret, true), (c) => {
    const body = me(db, cfg, c.get("accountId")!);
    return body ? c.json(body) : errorResponse(c, 404, "not_found", "account not found");
  });

  // SPEC §16.3 Agent Pass (MVP form): human-backed agent keys with a credit budget.
  app.post("/agents", session(secret, true), async (c) => {
    const body = AgentKeyCreateRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return errorResponse(c, 400, "bad_request", body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    const acc = c.get("accountId")!;
    if (isBanned(db, acc)) return errorResponse(c, 403, "unauthorized", "this account is banned");
    return c.json(AgentKeyCreateResponse.parse(createAgentKey(db, signer, acc, body.data.name, body.data.budget_mc ?? null)));
  });
  // API key credits: the key's own bought credits plus what it may spend from the account.
  // Key tokens only (Bearer gpa_…); a World session gets 403 here.
  const keyOnly = session(secret, true, (t) => agentFromToken(db, t));
  app.get("/v1/credits", keyOnly, (c) => {
    const agentId = c.get("agentId");
    if (!agentId) return errorResponse(c, 403, "unauthorized", "use an API key: Authorization: Bearer gpa_…");
    return c.json(KeyCreditsResponse.parse(keyCredits(db, cfg.net, agentId)));
  });
  // Top-up: x402 testnet USDC → credits only this key can spend (1 USDC = topup.credits_per_usdc).
  app.post("/v1/credits/topup", keyOnly, async (c) => {
    const agentId = c.get("agentId");
    if (!agentId) return errorResponse(c, 403, "unauthorized", "use an API key: Authorization: Bearer gpa_…");
    if (isBanned(db, c.get("accountId")!)) return errorResponse(c, 403, "unauthorized", "this account is banned");
    const body = CreditTopupRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return errorResponse(c, 400, "bad_request", body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    const { min_usdc, max_usdc } = cfg.net.topup;
    if (body.data.usdc < min_usdc || body.data.usdc > max_usdc) return errorResponse(c, 400, "bad_request", `usdc must be from ${min_usdc} to ${max_usdc}`);
    if (!x402) return errorResponse(c, 402, "payment_required", "x402 is not configured on this gateway");
    const units = BigInt(Math.round(body.data.usdc * 10 ** cfg.net.x402_near.decimals)).toString();
    const paid = await x402.topup(c, units);
    if (paid instanceof Response) return paid;
    const credited = creditTopup(db, cfg.net, signer, { agentId, payer: paid.payer, tx: paid.tx, units });
    console.log(JSON.stringify({ msg: "key_topup", agentId, payer: paid.payer, tx: paid.tx, units, added_mc: credited?.added ?? 0 }));
    if (!credited) return errorResponse(c, 400, "bad_request", `payment ${paid.tx} was already credited`);
    for (const [k, v] of Object.entries(paid.headers)) c.header(k, v);
    return c.json(CreditTopupResponse.parse({ agent_id: agentId, payer: paid.payer, tx_id: paid.tx, amount_units: units, added_mc: credited.added, credits: keyCredits(db, cfg.net, agentId) }));
  });
  // Guarded agent: it paid the treasury through the escrow contract (memo = this key's id).
  const txLookup = nearTx ?? rpcTxLookup(cfg.env.NEAR_RPC_URL);
  const lookupTx = async (hash: string, sender: string) => {
    try {
      return await txLookup(hash, sender);
    } catch (e) {
      throw new ChainCheckError(`transaction ${hash} from ${sender} not found on NEAR: ${(e as Error).message}`);
    }
  };
  app.post("/v1/credits/escrow", keyOnly, async (c) => {
    const agentId = c.get("agentId");
    if (!agentId) return errorResponse(c, 403, "unauthorized", "use an API key: Authorization: Bearer gpa_…");
    if (isBanned(db, c.get("accountId")!)) return errorResponse(c, 403, "unauthorized", "this account is banned");
    const { ESCROW_CONTRACT_ID: escrow, X402_PAY_TO: treasury } = cfg.env;
    if (!escrow || !treasury) return errorResponse(c, 400, "bad_request", "escrow is not configured on this gateway (ESCROW_CONTRACT_ID, X402_PAY_TO)");
    const body = EscrowCreditRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return errorResponse(c, 400, "bad_request", body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    let units: string;
    try {
      units = escrowPayment(await lookupTx(body.data.tx_hash, body.data.agent_account), { escrow, agent: body.data.agent_account, payee: treasury, memo: agentId });
    } catch (e) {
      if (e instanceof ChainCheckError) return errorResponse(c, 400, "bad_request", e.message);
      throw e;
    }
    const credited = creditTopup(db, cfg.net, signer, { agentId, payer: body.data.agent_account, tx: body.data.tx_hash, units, via: "escrow" });
    console.log(JSON.stringify({ msg: "escrow_credit", agentId, payer: body.data.agent_account, tx: body.data.tx_hash, units, added_mc: credited?.added ?? 0 }));
    if (!credited) return errorResponse(c, 400, "bad_request", `payment ${body.data.tx_hash} was already credited`);
    return c.json(CreditTopupResponse.parse({ agent_id: agentId, payer: body.data.agent_account, tx_id: body.data.tx_hash, amount_units: units, added_mc: credited.added, credits: keyCredits(db, cfg.net, agentId) }));
  });
  // Human top-up: USDC ft_transfer from a NEAR wallet to the treasury (memo = account id) → account credits.
  app.post("/v1/credits/near-topup", session(secret, true), async (c) => {
    const accountId = c.get("accountId")!;
    if (isBanned(db, accountId)) return errorResponse(c, 403, "unauthorized", "this account is banned");
    const treasury = cfg.env.X402_PAY_TO;
    if (!treasury) return errorResponse(c, 400, "bad_request", "no treasury configured on this gateway (X402_PAY_TO)");
    const body = NearTopupRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return errorResponse(c, 400, "bad_request", body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    let units: string;
    try {
      units = walletTransfer(await lookupTx(body.data.tx_hash, body.data.sender), { usdc: cfg.net.x402_near.asset, sender: body.data.sender, treasury, memo: accountId });
    } catch (e) {
      if (e instanceof ChainCheckError) return errorResponse(c, 400, "bad_request", e.message);
      throw e;
    }
    const credited = creditAccountTopup(db, cfg.net, signer, { accountId, payer: body.data.sender, tx: body.data.tx_hash, units });
    console.log(JSON.stringify({ msg: "wallet_topup", accountId, payer: body.data.sender, tx: body.data.tx_hash, units, added_mc: credited?.added ?? 0 }));
    if (!credited) return errorResponse(c, 400, "bad_request", `payment ${body.data.tx_hash} was already credited`);
    return c.json(NearTopupResponse.parse({ account_id: accountId, payer: body.data.sender, tx_id: body.data.tx_hash, amount_units: units, added_mc: credited.added }));
  });
  app.get("/agents", session(secret, true), (c) => c.json(AgentKeyListResponse.parse({ agents: listAgentKeys(db, c.get("accountId")!) })));
  app.get("/agents/:id/requests", session(secret, true), (c) => {
    const rows = agentRequests(db, c.get("accountId")!, c.req.param("id"));
    return rows ? c.json(AgentRequestsResponse.parse({ requests: rows })) : errorResponse(c, 404, "not_found", "no such API key");
  });
  app.delete("/agents/:id", session(secret, true), (c) =>
    revokeAgentKey(db, c.get("accountId")!, c.req.param("id")) ? c.json({ ok: true as const }) : errorResponse(c, 404, "not_found", "no such active agent key"));

  /**
   * Operator-only routes. A reverse proxy or tunnel on this host (Cloudflare Tunnel, nginx) also
   * connects from loopback, so a request that carries proxy headers came from outside: refuse it.
   */
  const localOperator = (c: Context): boolean => {
    let addr = "";
    try { addr = getConnInfo(c).remote.address ?? ""; } catch { addr = ""; }
    const proxied = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip", "forwarded"].some((h) => c.req.header(h) !== undefined);
    return !proxied && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr);
  };

  // SPEC §16.3 collusion flags (operator, loopback only). Flags only.
  app.get("/incentives/flags", (c) => {
    if (!localOperator(c)) return errorResponse(c, 403, "unauthorized", "loopback only");
    return c.json(CollusionFlagsResponse.parse(collusionFlags(db, cfg.net)));
  });

  app.post("/nodes/register", session(secret, true), registerHandler(db, cfg, signer));
  app.post("/nodes/heartbeat", heartbeatHandler(db, cfg, signer, (poolId) => queue.isIdle(poolId)));

  // SPEC §16.1 formation: pools formed from "auto" nodes, with their private DHT names. Only for
  // pool/pools-up.sh on this host (loopback), because the names keep strangers out of the pools.
  app.get("/pools/plan", (c) => {
    if (!localOperator(c)) return errorResponse(c, 403, "unauthorized", "loopback only");
    return c.json(PoolPlanResponse.parse(poolPlan(db, cfg)));
  });

  app.get("/pools/:pool_id", (c) => {
    const id = PoolId.safeParse(c.req.param("pool_id"));
    if (!id.success) return errorResponse(c, 400, "bad_request", "bad pool_id");
    return c.json(poolState(db, cfg, id.data));
  });

  app.get("/pools/:pool_id/availability", async (c) => {
    const id = PoolId.safeParse(c.req.param("pool_id"));
    const model = c.req.query("model");
    if (!id.success || !model) return errorResponse(c, 400, "bad_request", "pool_id and model are required");
    try { return c.json(PoolAvailability.parse(await router.availability(id.data, model))); }
    catch { c.header("Retry-After", String(cfg.net.router.retry_after_s)); return errorResponse(c, 503, "no_pool_available", "Marketplace directory unavailable; check again."); }
  });

  app.get("/network", async (c) => {
    try { return c.json(NetworkResponse.parse(await router.network())); }
    catch (e) {
      console.warn(`directory read failed: ${(e as Error).name}`);
      c.header("Retry-After", String(cfg.net.router.retry_after_s));
      return errorResponse(c, 503, "no_pool_available", "Directory unavailable");
    }
  });

  app.get("/ledger/events", (c) => {
    const limits = c.req.queries("limit") ?? [];
    const raw = limits[0] ?? "50";
    if (limits.length > 1 || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > 100) return errorResponse(c, 400, "bad_request", "limit must be an integer from 1 to 100");
    const rows = db.prepare("SELECT id, payload, ledger_seq, ledger_tx FROM ledger_events ORDER BY id DESC LIMIT ?").all(Number(raw)) as { id: number; payload: string; ledger_seq: number | null; ledger_tx: string | null }[];
    return c.json(LedgerEventsResponse.parse({ events: rows.map((r) => ({ id: r.id, event: JSON.parse(r.payload), ledger_seq: r.ledger_seq, ledger_tx: r.ledger_tx })) }));
  });

  app.get("/payouts/:address", (c) => {
    const address = NearAccountId.safeParse(c.req.param("address"));
    if (!address.success) return errorResponse(c, 400, "bad_request", "invalid payout account (a NEAR account ID)");
    return c.json(PayoutsResponse.parse(payoutsFor(db, address.data)));
  });

  if (cfg.env.VERIFICATION_ENABLED === "true") { // SPEC §16.2: planned, off by default
    app.get("/verifications/:id", session(secret, true), verificationReadHandler(db));
    app.post("/verifications/:id/appeal", session(secret, true), verificationAppealHandler(db, cfg, signer));
  }

  app.get("/requests/:id", (c) => {
    const id = RequestId.safeParse(c.req.param("id"));
    if (!id.success) return errorResponse(c, 400, "bad_request", "bad request id");
    const r = db.prepare("SELECT * FROM requests WHERE req_id = ?").get(id.data) as RequestRow | undefined;
    if (!r) return errorResponse(c, 404, "not_found", `no request ${id.data}`);
    const receipt = {
      ...r,
      split: r.split ? JSON.parse(r.split) : null,
      route: r.route ? JSON.parse(r.route) : null,
      attempts: r.attempts ? JSON.parse(r.attempts) : null,
      tee_check: teeCheckOf(db, id.data),
    };
    return c.json(Receipt.parse(receipt));
  });

  app.get("/v1/models", async (c) => {
    try {
      return c.json(ModelsResponse.parse(await router.models()));
    } catch (e) {
      console.warn(`directory read failed: ${(e as Error).name}`);
      c.header("Retry-After", String(cfg.net.router.retry_after_s));
      return errorResponse(c, 503, "no_pool_available", "Directory unavailable");
    }
  });

  app.notFound((c) => errorResponse(c, 404, "not_found", `no route ${c.req.method} ${c.req.path}`));
  app.onError((e, c) => {
    console.error(e);
    return errorResponse(c, 500, "internal", "internal error");
  });
  return app;
}
