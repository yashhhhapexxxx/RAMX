import type { Context } from "hono";
import { randomInt } from "node:crypto";
import { ChatCompletionRequest, REQUEST_ID_HEADER, Usage, type ModelConfig } from "@ramx/shared";
import { redactMessages, restore, restoreSse } from "./redact.ts";
import type { Config } from "./config.ts";
import { errorResponse } from "./errors.ts";
import { estimateInputTokens } from "./ledger.ts";
import { fitContext, marginTokens } from "./context.ts";
import { compactTools, emulatedMessages, rewriteCompletion, toolStream, usesTools, type ToolsMode } from "./tools.ts";
import type { StallTracker } from "./stall.ts";

/** Smallest answer room kept when trimming a prompt (tokens). */
const MIN_OUTPUT = 256;
/** Set when the gateway trimmed the prompt to fit the pool's context: number of messages cut or dropped. */
export const TRIMMED_HEADER = "x-ramx-trimmed";
/** #6: number of personal details the pool saw only as placeholders. */
export const REDACTED_HEADER = "x-ramx-redacted";

/** Why an attempt or a request failed. */
export type FailReason = "pool_error" | "no_usage" | "client_aborted" | "stalled";

/** Called once per request when the answer is complete (or failed). billing.ts settles here. */
export type Completion = {
  reqId: string;
  model: string;
  usage: Usage | null;
  /** The whole answer the client received (all attempts). */
  text: string;
  ok: boolean;
  reason?: FailReason;
  /** Content chunks the LAST attempt sent (about 1 token each). */
  streamedTokens?: number;
  /** Pool that served the final attempt (set by billing for observers). */
  poolId?: string;
};
export type OnComplete = (c: Completion) => void;

/**
 * Post-MVP P5.2 failover hook (billing.ts). Records the failed attempt (reliability failure for its
 * route), picks the next pool and moves the pool slot. null = no pool to try.
 */
export type Failover = (f: { reason: Exclude<FailReason, "client_aborted">; streamedTokens: number }) => Promise<{ coordinatorUrl: string; poolId: string } | null>;

/**
 * Billing step, after the request is parsed and before it is forwarded (billing.ts): session →
 * credit hold; no session → x402 settle. Returns a Response to stop (402/403/…), or extra response
 * headers (x402 PAYMENT-RESPONSE), the pool, `finish` (runs once with the completion) and `failover`.
 */
export type Prepared = { headers: Record<string, string>; coordinatorUrl: string; poolId: string; finish: OnComplete; failover?: Failover; /** Answer cap picked for a credit request (budget.ts); else the asked one. */ maxTokens?: number; /** #6: swap personal data for placeholders before the prompt reaches a laptop pool (src/redact.ts). */ redact?: boolean; /** Extra headers for the upstream request (end-to-end encryption to the enclave). */ upstreamHeaders?: Record<string, string> };
export type Prepare = (c: Context, req: ChatCompletionRequest, model: ModelConfig, maxTokens: number, reqId: string) => Promise<Prepared | Response>;

const withHeaders = (res: Response, headers: Record<string, string>): Response => {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
};

export const logCompletion: OnComplete = (c) => {
  console.log(JSON.stringify({ msg: "completion", reqId: c.reqId, model: c.model, ok: c.ok, reason: c.reason, usage: c.usage, chars: c.text.length }));
};

/** max_tokens, else max_completion_tokens, else the config default (SPEC §5.3 hold). */
export function effectiveMaxTokens(req: ChatCompletionRequest, defaultMax: number): number {
  return req.max_tokens ?? req.max_completion_tokens ?? defaultMax;
}

/**
 * The body sent to Parallax. The request was already parsed by the shared schema, so unknown
 * fields (logprobs, …) are gone. Thinking is off unless the client set it (HANDOFF §2.2).
 */
export function upstreamBody(req: ChatCompletionRequest, maxTokens: number, tools: ToolsMode = "native"): Record<string, unknown> {
  const { max_completion_tokens: _drop, ...rest } = req;
  const body: Record<string, unknown> = {
    ...rest,
    max_tokens: maxTokens,
    chat_template_kwargs: { ...req.chat_template_kwargs, enable_thinking: req.chat_template_kwargs?.enable_thinking ?? false },
  };
  if (req.stream) body.stream_options = { include_usage: true };
  if (tools === "emulate" && usesTools(req)) {
    // Parallax sees plain text only: tools in the system prompt, calls and results as text turns.
    body.messages = emulatedMessages(req, compactTools(req.tools ?? []));
    delete body.tools;
    delete body.tool_choice;
    delete body.parallel_tool_calls;
  }
  return body;
}

/**
 * Post-MVP P5.2: continue a broken answer on another attempt. The partial answer becomes the final
 * assistant message and the model goes on from its last token (vLLM `continue_final_message`; the
 * Parallax nodes serve chat through the vLLM Rust frontend). Output budget = what is left.
 */
export function continuationBody(req: ChatCompletionRequest, maxTokens: number, partial: string, streamedTokens: number, tools: ToolsMode = "native"): Record<string, unknown> {
  const body = upstreamBody(req, Math.max(1, maxTokens - streamedTokens), tools);
  if (!partial) return body;
  body.messages = [...(body.messages as unknown[]), { role: "assistant", content: partial }];
  body.continue_final_message = true;
  body.add_generation_prompt = false;
  return body;
}

type Attempt = { upstream: Response; abort: AbortController };
type OpenError = { message: string; stalled: boolean };
export type PoolFetch = (url: URL, init: RequestInit) => Promise<Response>;

/**
 * Open one upstream request. `headerMs` bounds the time to the response headers only, never the
 * generation: POOL_TIMEOUT_MS for non-streaming (Parallax sends headers after the whole answer),
 * the first-token limit for streaming (Parallax sends stream headers at once; P5.1).
 */
async function openUpstream(url: string, body: Record<string, unknown>, stream: boolean, headerMs: number, clientSignal: AbortSignal, poolFetch: PoolFetch, reqId?: string, extraHeaders?: Record<string, string>): Promise<Attempt | OpenError> {
  // A client that left before we start: do not send the request at all.
  if (clientSignal.aborted) return { message: "client aborted before the pool request", stalled: false };
  // Once sent, the pool request is NOT tied to the client. Parallax 162354a crashes its last stage
  // ("Decode request … must already be admitted") when a running pipeline request is aborted, so a
  // client cancel lets the request finish and discards it (proxyStream drains; billing = 0).
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(new Error("pool timeout")); }, headerMs);
  try {
    const upstream = await poolFetch(new URL("/v1/chat/completions", url), {
      method: "POST",
      // The request id lets the NEAR AI upstream keep the exact bytes for the answer signature (#8).
      headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", ...(reqId ? { [REQUEST_ID_HEADER]: reqId } : {}), ...extraHeaders },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 300);
      return { message: `pool returned HTTP ${upstream.status}${detail ? `: ${detail}` : ""}`, stalled: false };
    }
    return { upstream, abort };
  } catch (e) {
    return timedOut
      ? { message: `pool sent no response headers in ${headerMs} ms`, stalled: true }
      : { message: `pool unreachable: ${(e as Error).message}`, stalled: false };
  } finally {
    clearTimeout(timer);
  }
}

const isOpenError = (a: Attempt | OpenError): a is OpenError => !("upstream" in a);

/** The live pool context for a model; undefined = not reported, use the config value. */
export type ContextFor = (model: ModelConfig) => Promise<number | undefined>;

export function chatHandler(cfg: Config, prepare: Prepare, stall: StallTracker, poolFetch: PoolFetch = (url, init) => fetch(url, init), contextFor?: ContextFor) {
  return async (c: Context): Promise<Response> => {
    const reqId = c.get("reqId") as string;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(c, 400, "bad_request", "body must be JSON");
    }
    const parsed = ChatCompletionRequest.safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return errorResponse(c, 400, "bad_request", msg);
    }
    // P6.1 needs the exact sampling seed later for a Token-DiFR replay. Keep client-provided
    // seeds; assign one when absent and send it to Parallax with every completion request.
    const asked = { ...parsed.data, seed: parsed.data.seed ?? randomInt(0, 2 ** 31) };
    const model: ModelConfig | undefined = cfg.model(asked.model);
    if (!model) return errorResponse(c, 404, "model_not_found", `unknown model ${asked.model}`);

    // Credit requests (session or key): the gateway picks the answer cap (budget.ts), so a large
    // client max_tokens is capped, not refused. x402 prices are per max_tokens tier: refuse above it.
    const credit = !!c.get("accountId");
    const limit = model.x402_prices[model.x402_prices.length - 1]!.max_tokens;
    let maxTokens = effectiveMaxTokens(asked, cfg.net.cost.default_max_tokens);
    if (credit) maxTokens = Math.min(maxTokens, limit);
    else if (maxTokens > limit) return errorResponse(c, 400, "bad_request", `max_tokens ${maxTokens} is above the limit ${limit} for ${asked.model}`);

    // Fit the prompt into the pool's context; the answer gets the room that is left.
    const toolsMode: ToolsMode = cfg.env.TOOLS_MODE;
    const live = contextFor ? await contextFor(model).catch((e: Error) => {
      console.warn(`pool context read failed: ${e.name}; using config ${model.context_length}`);
      return undefined;
    }) : undefined;
    const ctx = live ?? model.context_length;
    const fit = fitContext(asked, ctx, Math.min(maxTokens, MIN_OUTPUT), toolsMode === "emulate" && usesTools(asked));
    if (!fit.ok) {
      return errorResponse(c, 400, "context_length_exceeded",
        `the prompt needs about ${fit.promptTokens} tokens even after trimming; this pool takes ${fit.budget} prompt tokens (context ${ctx}). Start a new session or compact it.`);
    }
    const req = fit.req;
    maxTokens = Math.max(1, Math.min(maxTokens, ctx - fit.promptTokens - marginTokens(ctx)));

    const prep = await prepare(c, req, model, maxTokens, reqId);
    if (prep instanceof Response) return prep;
    if (prep.maxTokens !== undefined) maxTokens = prep.maxTokens;
    // #6: the pool sees placeholders; the client, the receipt hash and the transcript see the real text.
    const red = prep.redact ? redactMessages(req.messages) : null;
    const redacted = red && red.map.size > 0 ? red : null;
    const sendReq: ChatCompletionRequest = redacted ? { ...req, messages: redacted.messages } : req;
    const real = (text: string) => (redacted ? restore(text, redacted.map) : text);
    const extra = { ...prep.headers, ...(fit.trimmed ? { [TRIMMED_HEADER]: String(fit.trimmed) } : {}), ...(redacted ? { [REDACTED_HEADER]: String(redacted.map.size) } : {}) };
    const clientSignal = c.req.raw.signal;
    const complete = (usage: Usage | null, text: string, ok: boolean, reason?: FailReason, streamedTokens = 0) =>
      prep.finish({ reqId, model: req.model, usage, text: real(text), ok, ...(reason ? { reason } : {}), ...(streamedTokens ? { streamedTokens } : {}) });

    // P5.8: with the pool hooks on, the gateway request ID rides along; the scheduler hook logs the
    // route under it and removes the field before the node backend sees it.
    const tag = (b: Record<string, unknown>) => (cfg.env.PARALLAX_ROUTE_LOG ? { ...b, ramx_req_id: reqId } : b);
    let failovers = 0;
    let target = { url: prep.coordinatorUrl, poolId: prep.poolId };
    /** Move to the next pool, if the config and the hook allow it. */
    const nextTarget = async (reason: Exclude<FailReason, "client_aborted">, streamedTokens: number): Promise<boolean> => {
      if (!prep.failover || failovers >= cfg.net.resilience.max_failovers || clientSignal.aborted) return false;
      failovers++;
      const next = await prep.failover({ reason, streamedTokens });
      if (!next) return false;
      console.warn(`failover ${reqId}: ${reason} after ${streamedTokens} tokens; retrying on ${next.poolId}`);
      target = { url: next.coordinatorUrl, poolId: next.poolId };
      return true;
    };

    const emulate = toolsMode === "emulate" && usesTools(req);
    const inputTokens = estimateInputTokens(req.messages, req.tools);
    const headerMs = req.stream ? stall.firstTokenMs(inputTokens) : cfg.env.POOL_TIMEOUT_MS;

    // Before any byte reaches the client, a failed attempt can start again from the beginning.
    let first: Attempt;
    for (;;) {
      const a = await openUpstream(target.url, tag(upstreamBody(sendReq, maxTokens, toolsMode)), !!req.stream, headerMs, clientSignal, poolFetch, reqId, prep.upstreamHeaders);
      if (!isOpenError(a)) { first = a; break; }
      if (clientSignal.aborted) {
        complete(null, "", false, "client_aborted");
        return withHeaders(errorResponse(c, 502, "pool_error", a.message), extra);
      }
      const reason = a.stalled ? "stalled" : "pool_error";
      if (await nextTarget(reason, 0)) continue;
      complete(null, "", false, reason);
      return withHeaders(errorResponse(c, 502, "pool_error", a.message), extra);
    }

    if (!req.stream) {
      let attempt: Attempt = first;
      for (;;) {
        let failure: { reason: "pool_error" | "no_usage"; message: string; text: string };
        try {
          const body = (await attempt.upstream.json()) as Record<string, any>;
          const usage = Usage.safeParse(body.usage);
          const text = String(body.choices?.[0]?.message?.content ?? "");
          if (usage.success && clientSignal.aborted) {
            complete(null, text, false, "client_aborted"); // the pool finished; the client is gone: no charge
            return withHeaders(errorResponse(c, 502, "pool_error", "client closed the request"), extra);
          }
          if (usage.success) {
            complete(usage.data, text, true);
            if (redacted) for (const ch of (body.choices ?? []) as { message?: { content?: unknown } }[]) {
              if (typeof ch.message?.content === "string") ch.message.content = real(ch.message.content);
            }
            // The response id is the gateway req_id (shared ChatCompletionResponse).
            const out = emulate ? rewriteCompletion(body) : body;
            return withHeaders(c.json({ ...out, id: reqId, model: req.model }), extra);
          }
          failure = { reason: "no_usage", message: "pool response has no usage", text };
        } catch (e) {
          failure = { reason: "pool_error", message: `bad pool response: ${(e as Error).message}`, text: "" };
        }
        // Nothing was sent to the client yet: a new attempt starts from the beginning.
        if (await nextTarget(failure.reason, 0)) {
          const a = await openUpstream(target.url, tag(upstreamBody(sendReq, maxTokens, toolsMode)), false, headerMs, clientSignal, poolFetch, reqId, prep.upstreamHeaders);
          if (!isOpenError(a)) { attempt = a; continue; }
          failure = { reason: "pool_error", message: a.message, text: "" };
        }
        complete(null, failure.text, false, clientSignal.aborted ? "client_aborted" : failure.reason);
        return withHeaders(errorResponse(c, 502, "pool_error", failure.message), extra);
      }
    }

    const proxied = proxyStream({
      first, clientSignal, stall, inputTokens,
      poolId: () => target.poolId,
      allowContinuation: cfg.net.resilience.continuation,
      drainMs: cfg.env.POOL_TIMEOUT_MS,
      reopen: async (reason, partial, streamedTokens) => {
        // Retry until an attempt opens or the failover budget is used up.
        while (await nextTarget(reason, streamedTokens)) {
          const a = await openUpstream(target.url, tag(continuationBody(sendReq, maxTokens, partial, streamedTokens, toolsMode)), true, headerMs, clientSignal, poolFetch, reqId, prep.upstreamHeaders);
          if (!isOpenError(a)) return a;
          reason = a.stalled ? "stalled" : "pool_error";
        }
        return null;
      },
      done: complete,
    });
    const restored = redacted ? restoreSse(proxied, redacted.map) : proxied;
    return new Response(emulate ? toolStream(restored) : restored, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...extra,
        [REQUEST_ID_HEADER]: reqId,
      },
    });
  };
}

type StreamOptions = {
  first: Attempt;
  clientSignal: AbortSignal;
  stall: StallTracker;
  inputTokens: number;
  poolId: () => string;
  /** false: never resume after content was sent (only fail fast). */
  allowContinuation: boolean;
  /** Upper bound for draining a pool answer after the client left (then it is aborted). */
  drainMs: number;
  /** Open the next attempt (continuation of `partial`), or null. */
  reopen: (reason: "pool_error" | "no_usage" | "stalled", partial: string, streamedTokens: number) => Promise<Attempt | null>;
  done: (usage: Usage | null, text: string, ok: boolean, reason?: FailReason, streamedTokens?: number) => void;
};

/** Read one chunk, or "stalled" after `ms`. On a stall the caller cancels the reader. */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<ReadableStreamReadResult<Uint8Array> | "stalled"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = reader.read();
  read.catch(() => {});
  try {
    return await Promise.race([read, new Promise<"stalled">((res) => { timer = setTimeout(() => res("stalled"), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forward the upstream SSE events to the client, and read `usage` and `delta.content` on the way.
 * Events are forwarded whole and unchanged; `[DONE]` is sent once, at the real end.
 * Post-MVP P5.1/P5.2: a stall, an error event or an early end of the stream starts the next attempt
 * (comment line `: failover`), which continues the partial answer. After the 200 headers are out,
 * a final failure cannot become a 502: we send one `data: {"error":{"code":"pool_error",…}}` event.
 */
export function proxyStream(o: StreamOptions): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let attempt = o.first;
  let reader = attempt.upstream.body!.getReader();
  let buf = "";
  let text = "";
  let usage: Usage | null = null;
  let attemptTokens = 0;
  let totalTokens = 0;
  let lastChunkAt: number | null = null;
  let finished = false;
  let draining = false;
  const finish = (ok: boolean, reason?: FailReason) => {
    if (finished) return;
    finished = true;
    o.done(usage, text, ok, reason, attemptTokens);
  };
  const stopAttempt = () => {
    attempt.abort.abort();
    reader.cancel().catch(() => {});
  };

  /** Parse complete events; returns the bytes to forward, or a failure seen in the events. */
  const takeEvents = (final: boolean): { out: string; failed: boolean; doneSeen: boolean } => {
    const parts = buf.split(/\r?\n\r?\n/);
    buf = final ? "" : parts.pop()!;
    let out = "";
    let failed = false;
    let doneSeen = false;
    for (const ev of parts) {
      if (!ev.trim()) continue;
      let forward = true;
      for (const line of ev.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { doneSeen = true; forward = false; continue; }
        if (!data) continue;
        try {
          const chunk = JSON.parse(data) as Record<string, any>;
          if (chunk.error) { failed = true; forward = false; continue; }
          const u = Usage.safeParse(chunk.usage);
          if (u.success) usage = u.data;
          const d = chunk.choices?.[0]?.delta;
          const calls = Array.isArray(d?.tool_calls) ? d.tool_calls as { function?: { name?: string; arguments?: string } }[] : [];
          // Native tool calls (TOOLS_MODE=native) carry no content: keep their text for the transcript.
          const delta = typeof d?.content === "string" && d.content ? d.content
            : calls.map((t) => `${t.function?.name ?? ""}${t.function?.arguments ?? ""}`).join("");
          if (delta.length > 0) {
            text += delta;
            attemptTokens++;
            totalTokens++;
            const now = Date.now();
            if (lastChunkAt !== null) o.stall.gap(o.poolId(), now - lastChunkAt);
            lastChunkAt = now;
          }
        } catch {
          // Not JSON: pass through, nothing to read.
        }
      }
      if (failed) break;
      if (forward) out += `${ev}\n\n`;
    }
    return { out, failed, doneSeen };
  };

  /** Failure of the current attempt: try the next one, else end the stream. */
  const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, reason: "pool_error" | "no_usage" | "stalled", message: string): Promise<void> => {
    stopAttempt();
    // usage already received = the answer was complete: settle it (no free inference by dropping late).
    if (usage) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); finish(true); return; }
    if (o.clientSignal.aborted) { controller.close(); finish(false, "client_aborted"); return; }
    const next = o.allowContinuation || totalTokens === 0 ? await o.reopen(reason, text, totalTokens) : null;
    if (next) {
      controller.enqueue(encoder.encode(": failover\n\n"));
      attempt = next;
      reader = next.upstream.body!.getReader();
      buf = "";
      attemptTokens = 0;
      lastChunkAt = null;
      return;
    }
    const msg = JSON.stringify({ error: { code: "pool_error", message } });
    controller.enqueue(encoder.encode(`data: ${msg}\n\n`));
    controller.close();
    finish(false, o.clientSignal.aborted ? "client_aborted" : reason);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Loop until something is forwarded or the stream ends (a failover may yield no bytes).
      for (;;) {
        const limit = totalTokens === 0 ? o.stall.firstTokenMs(o.inputTokens) : o.stall.stallMs(o.poolId());
        let r: ReadableStreamReadResult<Uint8Array> | "stalled";
        try {
          r = await readWithin(reader, limit);
        } catch (e) {
          if (finished || draining) return;
          return fail(controller, "pool_error", `pool stream failed: ${(e as Error).message}`);
        }
        if (finished || draining) return;
        if (r === "stalled") {
          if (o.clientSignal.aborted) { stopAttempt(); controller.close(); finish(false, "client_aborted"); return; }
          await fail(controller, "stalled", `pool stream stalled for ${limit} ms`);
          if (finished) return;
          continue;
        }
        if (r.done) {
          buf += decoder.decode();
          const { out, failed } = takeEvents(true);
          if (out) controller.enqueue(encoder.encode(out));
          if (usage && !failed) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            finish(true);
            return;
          }
          await fail(controller, failed ? "pool_error" : "no_usage", failed ? "pool sent an error event" : "pool stream ended without usage");
          if (finished) return;
          continue;
        }
        buf += decoder.decode(r.value, { stream: true });
        const { out, failed, doneSeen } = takeEvents(false);
        if (out) controller.enqueue(encoder.encode(out));
        if (doneSeen && usage && !failed) {
          stopAttempt();
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          finish(true);
          return;
        }
        if (failed) {
          await fail(controller, "pool_error", "pool sent an error event");
          if (finished) return;
          continue;
        }
        if (out) return;
      }
    },
    cancel() {
      // The client went away. Do NOT abort the pool request (see openUpstream): read the rest of the
      // answer and discard it, then finish, which also frees the pool slot. Only a real stall aborts.
      // The usage chunk comes after the last content chunk: if it is already here, the answer was complete.
      const complete = usage !== null;
      draining = true;
      // Usage already received: Parallax has finished this request, so closing it is safe.
      if (complete) { stopAttempt(); finish(true); return; }
      const deadline = Date.now() + o.drainMs;
      void (async () => {
        try {
          for (;;) {
            const r = await readWithin(reader, Math.max(1, Math.min(o.stall.stallMs(o.poolId()), deadline - Date.now())));
            if (r === "stalled") { stopAttempt(); break; } // a real stall, or the drain cap
            if (r.done) break;
          }
        } catch {
          // The pool stream broke on its own; nothing left to drain.
        }
        if (complete) finish(true);
        else finish(false, "client_aborted");
      })();
    },
  });
}
