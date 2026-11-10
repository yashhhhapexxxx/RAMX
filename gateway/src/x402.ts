import type { Context } from "hono";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter, type HTTPRequestContext, type HTTPResponseInstructions } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { createFacilitatorNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/server";
import { ExactNearScheme as ExactNearFacilitatorScheme } from "@x402/near/exact/facilitator";
import { NearAccountId, type ChatCompletionRequest, type RamxConfig } from "@ramx/shared";

/**
 * x402 for /v1/chat/completions requests without a session (SPEC §7), paid in USDC (NEP-141) on NEAR.
 * Uses @x402/core directly, not a framework middleware, because:
 *  - the price depends on the body (model + max_tokens tier), and the request was already parsed;
 *  - SPEC §7.2 settles BEFORE serving, while middleware settles after the handler and buffers
 *    the whole response (no streaming).
 * Flow: no PAYMENT-SIGNATURE → 402 + PAYMENT-REQUIRED header (library-owned body). With it → the
 * facilitator verifies the payer's signed NEP-366 delegate (one `ft_transfer`) → we settle at once
 * (the relayer submits it and pays gas) → serve. If the pool fails after settlement the money stays
 * with the treasury (refunds are out of scope; the request row is marked failed).
 */

export const X402_ROUTE = "POST /v1/chat/completions";
/** API key top-up: the payer picks the amount; USDC only (1 USDC = credits_per_usdc credits for that key). */
export const X402_TOPUP_ROUTE = "POST /v1/credits/topup";

/** SPEC §7.3: first tier with tier.max_tokens >= max_tokens. USDC base units as a decimal string. */
export function priceUnits(cfg: RamxConfig, modelId: string, maxTokens: number): string {
  const m = cfg.models.find((x) => x.model_id === modelId);
  if (!m) throw new Error(`unknown model ${modelId}`);
  const tier = m.x402_prices.find((t) => maxTokens <= t.max_tokens);
  if (!tier) throw new Error(`max_tokens ${maxTokens} is above the last tier for ${modelId}`);
  return tier.price_units;
}

/** `asset` = NEP-141 token contract that was paid (the configured USDC). */
export type X402Paid = { payer: string; tx: string; amountUnits: string; asset: string; headers: Record<string, string> };
export type X402 = {
  charge(c: Context, req: ChatCompletionRequest, maxTokens: number): Promise<X402Paid | Response>;
  /** Charge exactly `units` of USDC for a key top-up (settled before the credits are added). */
  topup(c: Context, units: string): Promise<X402Paid | Response>;
};

/**
 * In-process facilitator: the gateway's own relayer account submits the payer's signed delegate and
 * pays its gas. No third-party facilitator or API key. The relayer needs NEAR for gas only.
 */
export function localNearFacilitator(o: { network: string; relayerId: string; relayerKey: string; rpcUrl?: string }): FacilitatorClient {
  const signer = createFacilitatorNearSigner({
    relayers: [{ accountId: o.relayerId, secretKey: o.relayerKey as `ed25519:${string}` }],
    ...(o.rpcUrl ? { rpcUrls: { [o.network]: o.rpcUrl } } : {}),
  });
  const facilitator = new x402Facilitator().register(o.network as `${string}:${string}`, new ExactNearFacilitatorScheme(signer));
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => facilitator.getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>,
  };
}

/** A remote facilitator over HTTP (tests, or a hosted NEAR facilitator). */
export const httpFacilitator = (url: string): FacilitatorClient => new HTTPFacilitatorClient({ url });

/** Body for the price callback. The handler has already parsed and checked the request. */
type Priced = { model: string; maxTokens: number } | { units: string };

function adapter(c: Context, priced: Priced): HTTPAdapter {
  return {
    getHeader: (n) => c.req.header(n),
    getMethod: () => c.req.method,
    getPath: () => c.req.path,
    getUrl: () => c.req.url,
    getAcceptHeader: () => c.req.header("accept") ?? "",
    getUserAgent: () => c.req.header("user-agent") ?? "",
    getBody: () => priced,
  };
}

const toResponse = (r: HTTPResponseInstructions): Response => {
  const headers = new Headers(r.headers);
  if (r.isHtml) {
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(String(r.body ?? ""), { status: r.status, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers });
};

export function createX402(opts: { cfg: RamxConfig; facilitator: FacilitatorClient; payTo: string }): X402 {
  if (!NearAccountId.safeParse(opts.payTo).success) throw new Error("X402_PAY_TO must be a NEAR account ID (e.g. treasury.ramx.testnet)");
  const { network, asset } = opts.cfg.x402_near;
  const server = new x402ResourceServer(opts.facilitator).register("near:*", new ExactNearScheme());
  const http = new x402HTTPResourceServer(server, {
    [X402_ROUTE]: {
      accepts: [{
        scheme: "exact",
        network,
        payTo: opts.payTo,
        // USDC (NEP-141) in base units. The payTo account must be registered on the token contract (storage_deposit).
        price: async (ctx: HTTPRequestContext) => {
          const p = (await ctx.adapter.getBody?.()) as Extract<Priced, { model: string }>;
          return { asset, amount: priceUnits(opts.cfg, p.model, p.maxTokens) };
        },
        maxTimeoutSeconds: 120,
      }],
      description: "RAMX chat completion (priced by model and max_tokens tier, SPEC §7.3)",
      mimeType: "application/json",
    },
    [X402_TOPUP_ROUTE]: {
      accepts: [{
        scheme: "exact",
        network,
        payTo: opts.payTo,
        price: async (ctx: HTTPRequestContext) => {
          const p = (await ctx.adapter.getBody?.()) as Extract<Priced, { units: string }>;
          return { asset, amount: p.units };
        },
        maxTimeoutSeconds: 120,
      }],
      description: "RAMX API key top-up (USDC on NEAR → credits for one key)",
      mimeType: "application/json",
    },
  });
  // The facilitator's supported kinds are read once, on the first paid request (retried if it fails).
  let init: Promise<void> | null = null;
  const ready = async () => {
    init ??= http.initialize().catch((e) => {
      init = null;
      throw e;
    });
    await init;
  };

  async function pay(c: Context, priced: Priced, route: string): Promise<X402Paid | Response> {
    try {
      await ready();
    } catch (e) {
      return Response.json({ error: { code: "internal", message: `x402 facilitator unreachable: ${(e as Error).message}` } }, { status: 502 });
    }
    const ctx: HTTPRequestContext = {
      adapter: adapter(c, priced),
      path: c.req.path,
      method: c.req.method,
      paymentHeader: c.req.header("payment-signature") ?? c.req.header("x-payment"),
    };
    const result = await http.processHTTPRequest(ctx);
    if (result.type === "no-payment-required") throw new Error(`x402 route config does not match ${route}`);
    if (result.type === "payment-error") return toResponse(result.response);
    if (result.paymentRequirements.asset !== asset) return Response.json({ error: { code: "payment_required", message: `asset ${result.paymentRequirements.asset} is not accepted` } }, { status: 402 });
    // Settle now, before the pool runs (SPEC §7.2 steps 4–5).
    const settled = result.beforeHandlerSettlement?.result
      ? { ...result.beforeHandlerSettlement.result, headers: http.createCompletedSettlementHeaders(result.beforeHandlerSettlement) }
      : await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: ctx });
    if (!settled.success) return "response" in settled ? toResponse(settled.response) : Response.json({ error: { code: "payment_required", message: "settlement failed" } }, { status: 402 });
    if (!settled.payer) return Response.json({ error: { code: "internal", message: "facilitator settled without a payer" } }, { status: 502 });
    return { payer: settled.payer, tx: settled.transaction, amountUnits: settled.amount ?? result.paymentRequirements.amount, asset, headers: settled.headers };
  }

  return {
    charge: (c, req, maxTokens) => pay(c, { model: req.model, maxTokens }, X402_ROUTE),
    async topup(c, units) {
      const paid = await pay(c, { units }, X402_TOPUP_ROUTE);
      if (paid instanceof Response) return paid;
      // Only the exact USDC amount asked buys credits.
      if (paid.amountUnits !== units) return Response.json({ error: { code: "payment_required", message: `top-up must pay exactly ${units} USDC base units` } }, { status: 402 });
      return paid;
    },
  };
}
