import { createHash } from "node:crypto";
import type { Context } from "hono";
import { canonicalJson, MAX_TOKENS_HEADER, PRICE_HEADER, type ChatCompletionRequest, type ModelConfig, type PayoutRoute, type RequestAttempt, type Route } from "@ramx/shared";
import { takeSlot } from "./market.ts";
import type { Completion, Failover, OnComplete, Prepare, Prepared } from "./chat.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errorResponse } from "./errors.ts";
import { recordEvent, type Signer } from "./events.ts";
import { availableMc, countedOutput, estimateInputTokens, observedOutputTokens, holdMc, keyAvailableMc, releaseHold, releaseKeyHold, settle, tryHold, tryHoldForKey } from "./ledger.ts";
import { contributionRatio } from "./accounts.ts";
import { countPool, countRouted } from "./reliability.ts";
import { agentBudgetLeft, chargeAgent, recordPoolWait } from "./incentives.ts";
import { exactRoute } from "./pools.ts";
import { learnedNeed, MIN_ANSWER, pickMaxTokens } from "./budget.ts";
import type { PoolQueue } from "./queue.ts";
import type { Router, SelectedPool, SelectOptions } from "./router.ts";
import { e2eeRequest, HASH_SALT_HEADER, isPrivacyMode, newSalt, PRIVACY_HEADER, PRIVACY_MODES, promptHashOf, saltedHash, seal, trustedAccounts } from "./privacy.ts";
import { usesTools } from "./tools.ts";
import type { X402 } from "./x402.ts";
import { NEARAI_POOL_ID } from "./nearai-upstream.ts";

/**
 * Billing for /v1/chat/completions (SPEC §5.3, §7):
 *  - session → hold credits, settle from `usage` at the end, split to the route's node owners;
 *  - no session → x402: settle the USDC payment before serving.
 * Hashes (shared/README.md): sha256, 0x hex. prompt_hash = sha256(canonical JSON of `messages`),
 * resp_hash = sha256(UTF-8 response text).
 */

export const sha256Hex = (s: string): string => `0x${createHash("sha256").update(s, "utf8").digest("hex")}`;
export const promptHash = (req: ChatCompletionRequest): string => sha256Hex(canonicalJson(req.messages));

export type BillingDeps = { cfg: Config; db: Db; signer: Signer; x402: X402 | null; router: Router; queue: PoolQueue; observe?: OnComplete };

/** x402 provider attribution, frozen with the route that serves the request (SPEC §10.5). */
function payoutSnapshot(db: Db, route: Route | null): PayoutRoute | null {
  return route?.map((hop) => {
    const owner = db.prepare(`SELECT n.account_id, a.payout_address FROM nodes n
      JOIN accounts a ON a.id = n.account_id WHERE n.node_id = ?`).get(hop.node_id) as { account_id: `acc_${string}`; payout_address: `0x${string}` | null };
    return { ...hop, owner_account: owner.account_id, payout_address: owner.payout_address };
  }) ?? null;
}

/** #6: swap personal data for placeholders when untrusted laptops will see the prompt (src/redact.ts). */
export const redactFor = (cfg: Config, poolId: string, privacy: string | undefined): boolean =>
  cfg.env.PII_REDACTION !== "false" && poolId !== NEARAI_POOL_ID && privacy !== "tee" && privacy !== "trusted-all";

function insertRequest(db: Db, cfg: Config, row: { reqId: string; accountId: string | null; payer?: string; tx?: string; amount?: string; asset?: string; model: string; payType: "credits" | "x402"; route: Route | null; promptHash: string; prompt: string; seed: number; settings: string; salt: string; privacy: string | null; maxTokens: number; priceMultiplier: number | null }, now: number) {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO requests (req_id, account_id, x402_payer, x402_tx, x402_amount, x402_asset, model, pay_type, route, status, prompt_hash, sampling_seed, sampling_settings, max_tokens, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    ).run(row.reqId, row.accountId, row.payer ?? null, row.tx ?? null, row.amount ?? null, row.asset ?? null, row.model, row.payType, row.route ? JSON.stringify(row.route) : null, row.promptHash, row.seed, row.settings, row.maxTokens, now);
    if (row.payType === "x402") {
      const snapshot = payoutSnapshot(db, row.route);
      db.prepare("UPDATE requests SET payout_snapshot = ? WHERE req_id = ?").run(snapshot ? JSON.stringify(snapshot) : null, row.reqId);
    }
    db.prepare("UPDATE requests SET hash_salt = ?, privacy = ?, price_multiplier = ? WHERE req_id = ?").run(row.salt, row.privacy, row.priceMultiplier, row.reqId);
    // Privacy requests keep only hashes; other transcripts are encrypted when TRANSCRIPT_KEY is set.
    if (!row.privacy) {
      db.prepare("INSERT INTO transcripts (req_id, prompt, response, expires_at) VALUES (?, ?, NULL, ?)").run(row.reqId, seal(cfg, row.prompt), now + cfg.net.transcript_retention_days * 86_400_000);
    }
  })();
}

/**
 * SPEC §16.3 stage-level blame: when the stalled stage is known (route nodes whose heartbeat was
 * late), only those nodes get the reliability failure; otherwise every node (MVP rule).
 */
export function blameRoute(route: Route | null, late: string[]): Route | null {
  if (!route || late.length === 0) return route;
  const blamed = route.filter((h) => late.includes(h.node_id));
  return blamed.length ? blamed : route;
}

/** Route nodes whose last heartbeat is older than two intervals (stall suspects, P5.1). */
function lateNodes(db: Db, cfg: Config, route: Route | null, now = Date.now()): `0x${string}`[] {
  const limit = now - 2 * cfg.env.HEARTBEAT_SECONDS * 1000;
  return [...new Set((route ?? []).map((h) => h.node_id))].filter((id) => {
    const n = db.prepare("SELECT hb_ts FROM nodes WHERE node_id = ?").get(id) as { hb_ts: number | null } | undefined;
    return !n || n.hb_ts === null || n.hb_ts < limit;
  }) as `0x${string}`[];
}

/**
 * A failed request costs nothing; the nodes on the route get a reliability penalty unless the client
 * aborted. `counted` = the failover hook already recorded this route's failure.
 */
function markFailed(db: Db, cfg: Config, reqId: string, poolId: string, route: Route | null, comp: Completion, counted = false) {
  db.transaction(() => {
    db.prepare("UPDATE requests SET status = 'failed' WHERE req_id = ?").run(reqId);
    if (comp.reason !== "client_aborted" && !counted) {
      countRouted(db, cfg, route, false);
      countPool(db, cfg, poolId, false); // SPEC §9.2: the pool failed, whatever its route
    }
  })();
}

export function makePrepare(d: BillingDeps): Prepare {
  const { cfg, db, signer } = d;
  return async (c: Context, req: ChatCompletionRequest, model: ModelConfig, askedMax: number, reqId: string): Promise<Prepared | Response> => {
    let maxTokens = askedMax;
    const accountId = (c.get("accountId") as string | null | undefined) ?? null;
    let now = Date.now();
    // Salted hashes: the public ledger cannot be searched for short prompts (src/privacy.ts).
    const salt = newSalt();
    const pHash = promptHashOf(salt, req.messages);
    const respHashOf = (text: string) => saltedHash(salt, text);
    const prompt = canonicalJson(req.messages);
    const samplingSettings = canonicalJson({ temperature: req.temperature ?? 1, top_p: req.top_p ?? 1, stop: req.stop ?? null, chat_template_kwargs: req.chat_template_kwargs ?? null });

    if (!accountId && !d.x402) return errorResponse(c, 402, "payment_required", "no session token, and x402 is not configured on this gateway");
    // Privacy (src/privacy.ts): route only to trusted nodes; store no transcript.
    const privacy = c.req.header(PRIVACY_HEADER);
    if (privacy !== undefined && !isPrivacyMode(privacy)) return errorResponse(c, 400, "bad_request", `${PRIVACY_HEADER} must be one of ${PRIVACY_MODES.join(", ")}`);
    // End-to-end encryption: only to the enclave (tee); laptops cannot decrypt, so ciphertext never goes to a pool.
    const e2ee = e2eeRequest((name) => c.req.header(name));
    if (e2ee && "error" in e2ee) return errorResponse(c, 400, "bad_request", e2ee.error);
    if (e2ee && privacy !== "tee") return errorResponse(c, 400, "bad_request", `end-to-end encryption needs ${PRIVACY_HEADER}: tee`);
    if (e2ee && cfg.env.TOOLS_MODE === "emulate" && usesTools(req)) return errorResponse(c, 400, "bad_request", "end-to-end encryption cannot be combined with emulated tool calls");
    const upstreamHeaders = e2ee ? e2ee.headers : undefined;
    const opts: SelectOptions = { accountId, ...(privacy ? { privacy: { mode: privacy, accounts: trustedAccounts(cfg, accountId) } } : {}) };
    // SPEC §16.3 routing preferences: pin a pool; require a minimum pool reliability.
    const pin = c.req.header("x-ramx-pool");
    if (pin !== undefined) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(pin)) return errorResponse(c, 400, "bad_request", "x-ramx-pool must be a pool ID");
      opts.pin = pin;
    }
    const minRel = c.req.header("x-ramx-min-reliability");
    if (minRel !== undefined) {
      const v = Number(minRel);
      if (!Number.isFinite(v) || v < 0 || v > 1) return errorResponse(c, 400, "bad_request", "x-ramx-min-reliability must be a number from 0 to 1");
      opts.minReliability = v;
    }
    // SPEC §16.3 Agent Pass (MVP form): an agent key spends its human's credits within a budget.
    const agentId = (c.get("agentId") as string | null | undefined) ?? null;
    let selected: SelectedPool | null;
    try {
      selected = await d.router.select(model, undefined, undefined, opts);
    } catch (e) {
      console.warn(`routing failed: ${(e as Error).name}`);
      c.header("Retry-After", String(cfg.net.router.retry_after_s));
      return errorResponse(c, 503, "no_pool_available", "Directory unavailable");
    }
    if (!selected) {
      c.header("Retry-After", String(cfg.net.router.retry_after_s));
      return errorResponse(c, 503, "no_pool_available", `no ready pool for ${model.model_id}`);
    }
    // Lock before queueing: queue/load changes and failover never reprice this request. Credits
    // only: x402 keeps its fixed USDC tiers, so its receipts carry no multiplier.
    const price = d.router.pricing.quote(model);
    const priceHeader = JSON.stringify(price);
    const ratioRow = accountId ? db.prepare("SELECT earned_total_mc, spent_total_mc FROM balances WHERE account_id = ?").get(accountId) as { earned_total_mc: number; spent_total_mc: number } | undefined : undefined;
    // Phase 7: a slot won in the capacity market puts this request at the front of the pool queue.
    const nearAccount = accountId ? ((db.prepare("SELECT near_account FROM accounts WHERE id = ?").get(accountId) as { near_account: string | null } | undefined)?.near_account ?? null) : null;
    const slot = takeSlot(db, nearAccount, model.model_id);
    if (slot) c.header("x-ramx-swarm-slot", "1");
    const ratio = slot ? Number.MAX_SAFE_INTEGER : accountId ? contributionRatio(ratioRow?.earned_total_mc ?? 0, ratioRow?.spent_total_mc ?? 0) : 1;
    let releaseQueue: () => void;
    try {
      const waitStart = Date.now();
      releaseQueue = await d.queue.acquire(selected.poolId, ratio, c.req.raw.signal);
      // SPEC §16.3 availability: remember that this pool needed capacity.
      recordPoolWait(db, selected.poolId, Date.now() - waitStart);
    } catch (e) {
      if ((e as Error).name !== "AbortError") throw e;
      return errorResponse(c, 408, "bad_request", "request cancelled while waiting");
    }
    let prepared = false;
    try {
      // Recheck the chosen pool after waiting: listings and signed layer ranges can change.
      try {
        selected = await d.router.select(model, selected.poolId, undefined, opts);
      } catch (e) {
        console.warn(`admission failed: ${(e as Error).name}`);
        c.header("Retry-After", String(cfg.net.router.retry_after_s));
        return errorResponse(c, 503, "no_pool_available", "Directory unavailable");
      }
      if (!selected) {
        c.header("Retry-After", String(cfg.net.router.retry_after_s));
        return errorResponse(c, 503, "no_pool_available", `pool no longer ready for ${model.model_id}`);
      }
      if (c.req.raw.signal.aborted) return errorResponse(c, 408, "bad_request", "request cancelled while waiting");
      now = Date.now();
      // The current attempt (post-MVP P5.2: failover can move the request to another pool).
      let cur = { poolId: selected.poolId, route: selected.route, coordinatorUrl: selected.coordinatorUrl };
      const attempts: RequestAttempt[] = [];
      let failureCounted = false;
      let releaseActive: () => void = () => {};
      const payType = accountId ? "credits" : "x402";

      const failover: Failover = async ({ reason, streamedTokens }) => {
        attempts.push({ pool_id: cur.poolId, route: cur.route, outcome: reason, streamed_tokens: streamedTokens, late_nodes: lateNodes(db, cfg, cur.route) });
        countRouted(db, cfg, blameRoute(cur.route, lateNodes(db, cfg, cur.route)), false);
        countPool(db, cfg, cur.poolId, false);
        failureCounted = true;
        let next: SelectedPool | null = null;
        try {
          next = (await d.router.select(model, undefined, cur.poolId, opts)) ?? (await d.router.select(model, cur.poolId, undefined, opts));
        } catch (e) {
          console.warn(`failover ${reqId}: routing failed: ${(e as Error).name}`);
        }
        if (!next) return null;
        if (next.poolId !== cur.poolId) {
          // Move the pool slot: free the failed pool, wait for a slot in the next one.
          releaseActive();
          releaseQueue();
          releaseQueue = () => {};
          try {
            releaseQueue = await d.queue.acquire(next.poolId, ratio, c.req.raw.signal);
          } catch {
            return null;
          }
          releaseActive = d.router.start(next.poolId);
        }
        cur = { poolId: next.poolId, route: next.route, coordinatorUrl: next.coordinatorUrl };
        failureCounted = false;
        db.prepare("UPDATE requests SET route = ?, payout_snapshot = ?, attempts = ? WHERE req_id = ?").run(
          cur.route ? JSON.stringify(cur.route) : null,
          payType === "x402" && cur.route ? JSON.stringify(payoutSnapshot(db, cur.route)) : null,
          JSON.stringify(attempts), reqId);
        return { coordinatorUrl: cur.coordinatorUrl, poolId: cur.poolId };
      };
      /** Save the attempt list with the final attempt (only when a failover happened). */
      const saveAttempts = (comp: Completion) => {
        if (attempts.length === 0) return;
        const outcome = comp.ok ? "ok" : (comp.reason ?? "pool_error");
        attempts.push({ pool_id: cur.poolId, route: cur.route, outcome, streamed_tokens: comp.streamedTokens ?? 0, late_nodes: comp.ok ? [] : lateNodes(db, cfg, cur.route) });
        db.prepare("UPDATE requests SET attempts = ? WHERE req_id = ?").run(JSON.stringify(attempts), reqId);
      };
      /**
       * P5.8: at completion, use the pipeline Parallax really used (hook route log), if every hop maps
       * to a registered node with a layer range; else keep the heartbeat layer map. Saved on the request.
       */
      const resolveRoute = (): Route | null => {
        const exact = cfg.env.PARALLAX_ROUTE_LOG ? exactRoute(db, cfg, reqId, model) : null;
        if (exact) cur.route = exact;
        const nearAi = cur.poolId === NEARAI_POOL_ID;
        db.prepare("UPDATE requests SET route = ?, route_source = ?, payout_snapshot = coalesce(?, payout_snapshot), backend = ? WHERE req_id = ?").run(
          cur.route ? JSON.stringify(cur.route) : null, nearAi ? null : exact ? "scheduler" : "heartbeat",
          exact && payType === "x402" ? JSON.stringify(payoutSnapshot(db, exact)) : null, nearAi ? "near-ai-cloud" : "pool", reqId);
        return cur.route;
      };
      /** Billed output tokens (Phase 6.1); an over-count is logged and costs the pool reliability. */
      const outputOf = (comp: Completion) => {
        const reported = comp.usage!.completion_tokens;
        const observed = observedOutputTokens(comp.text, comp.streamedTokens ?? 0);
        const r = countedOutput(reported, observed);
        if (r.overcount) console.warn(JSON.stringify({ msg: "output_overcount", reqId, pool: cur.poolId, reported, observed, billed: r.billed }));
        return r;
      };
      const trackedFinish = (finish: OnComplete): OnComplete => {
        releaseActive = d.router.start(cur.poolId);
        prepared = true;
        let finished = false;
        return (comp) => {
          if (finished) return;
          finished = true;
          try { finish(comp); } finally { releaseActive(); releaseQueue(); }
        };
      };

      if (accountId) {
        // Answer cap for this user (budget.ts): never more than the balance (and key budget) can pay.
        const inTokens = estimateInputTokens(req.messages, req.tools);
        // A key spends its own bought credits first, then the account's credits within its cap.
        const keyMc = agentId ? keyAvailableMc(db, agentId) : 0;
        const fromAccount = Math.max(0, Math.min(availableMc(db, accountId, now), agentId ? agentBudgetLeft(db, agentId) : Infinity));
        const spendable = keyMc + fromAccount;
        const asked = req.max_tokens ?? req.max_completion_tokens ?? null;
        const pick = pickMaxTokens({ cfg: cfg.net, model, ceiling: maxTokens, asked, learned: learnedNeed(db, accountId, agentId), availableMc: spendable, inTokens, priceMultiplier: price.multiplier });
        if (pick.maxTokens === null) {
          return errorResponse(c, 403, "insufficient_credits", `available ${spendable} mc pays for ${pick.affordable} answer tokens; at least ${MIN_ANSWER} are needed`);
        }
        maxTokens = pick.maxTokens;
        const hold = holdMc(cfg.net, model, maxTokens, inTokens, price.multiplier);
        if (agentId && hold - keyMc > agentBudgetLeft(db, agentId)) {
          return errorResponse(c, 403, "insufficient_credits", `key credits ${keyMc} mc + cap left ${agentBudgetLeft(db, agentId)} mc; this request needs a hold of ${hold} mc`);
        }
        let keyHeld = 0;
        if (agentId) {
          const held = tryHoldForKey(db, accountId, agentId, hold, now);
          if (held === null) return errorResponse(c, 403, "insufficient_credits", `this request needs a hold of ${hold} mc; key credits ${keyAvailableMc(db, agentId)} mc + account ${availableMc(db, accountId, now)} mc`);
          keyHeld = held;
        } else if (!tryHold(db, accountId, hold, now)) {
          return errorResponse(c, 403, "insufficient_credits", `this request needs a hold of ${hold} mc; available ${availableMc(db, accountId, now)} mc`);
        }
        const release = () => (agentId ? releaseKeyHold(db, accountId, agentId, hold, keyHeld) : releaseHold(db, accountId, hold));
        try {
          insertRequest(db, cfg, { reqId, accountId, model: model.model_id, payType: "credits", route: cur.route, promptHash: pHash, prompt, seed: req.seed!, settings: samplingSettings, salt, privacy: privacy ?? null, maxTokens, priceMultiplier: price.multiplier }, now);
        } catch (e) {
          release();
          throw e;
        }
        return {
          maxTokens,
          headers: { [HASH_SALT_HEADER]: salt, [MAX_TOKENS_HEADER]: String(maxTokens), [PRICE_HEADER]: priceHeader },
          coordinatorUrl: cur.coordinatorUrl,
          poolId: cur.poolId,
          redact: redactFor(cfg, cur.poolId, privacy),
          ...(upstreamHeaders ? { upstreamHeaders } : {}),
          failover,
          finish: trackedFinish((comp) => {
            const route = resolveRoute();
            try {
              saveAttempts(comp);
              if (comp.ok && comp.usage) {
                const out = outputOf(comp);
                // Commit billing, the transcript and its reliability outcome together. A later
                // database failure must not leave a charged request marked as failed.
                db.transaction(() => {
                  const settled = settle(db, cfg.net, signer, { reqId, accountId, model, hold, inTokens: comp.usage!.prompt_tokens, outTokens: out.billed, route, promptHash: pHash, respHash: respHashOf(comp.text), priceMultiplier: price.multiplier, ...(agentId ? { key: { agentId, held: keyHeld } } : {}), ...(privacy ? { privacy } : {}), ...(e2ee ? { e2ee: true } : {}) });
                  if (agentId) chargeAgent(db, agentId, reqId, settled.cost);
                  db.prepare("UPDATE transcripts SET response = ? WHERE req_id = ?").run(seal(cfg, comp.text), reqId);
                  countRouted(db, cfg, route, true);
                  countPool(db, cfg, cur.poolId, !out.overcount);
                })();
              } else {
                db.transaction(() => {
                  release();
                  markFailed(db, cfg, reqId, cur.poolId, blameRoute(route, comp.ok ? [] : lateNodes(db, cfg, route)), comp, failureCounted);
                })();
              }
            } catch (e) {
              // The settle transaction rolled back: give the hold back so credits are not stuck.
              console.error(`billing ${reqId}: settle failed, hold released, request marked failed: ${(e as Error).message}`);
              release();
              db.prepare("UPDATE requests SET status = 'failed' WHERE req_id = ?").run(reqId);
            }
            d.observe?.({ ...comp, poolId: cur.poolId });
          }),
        };
      }

      if (!d.x402) return errorResponse(c, 402, "payment_required", "no session token, and x402 is not configured on this gateway");
      const paid = await d.x402.charge(c, req, maxTokens);
      if (paid instanceof Response) return paid;
      insertRequest(db, cfg, { reqId, accountId: null, payer: paid.payer, tx: paid.tx, amount: paid.amountUnits, asset: paid.asset, model: model.model_id, payType: "x402", route: cur.route, promptHash: pHash, prompt, seed: req.seed!, settings: samplingSettings, salt, privacy: privacy ?? null, maxTokens, priceMultiplier: null }, Date.now());
      console.log(JSON.stringify({ msg: "x402_settled", reqId, payer: paid.payer, tx: paid.tx, amount_units: paid.amountUnits }));
      return {
        headers: { ...paid.headers, [HASH_SALT_HEADER]: salt },
        coordinatorUrl: cur.coordinatorUrl,
        poolId: cur.poolId,
        redact: redactFor(cfg, cur.poolId, privacy),
        ...(upstreamHeaders ? { upstreamHeaders } : {}),
        failover,
        finish: trackedFinish((comp) => {
          const route = resolveRoute();
          try {
            saveAttempts(comp);
            if (comp.ok && comp.usage) {
              const respHash = respHashOf(comp.text);
              const out = outputOf(comp);
              db.transaction(() => {
                db.prepare("UPDATE requests SET status = 'ok', in_tokens = ?, out_tokens = ?, resp_hash = ? WHERE req_id = ?").run(comp.usage!.prompt_tokens, out.billed, respHash, reqId);
                db.prepare("UPDATE transcripts SET response = ? WHERE req_id = ?").run(seal(cfg, comp.text), reqId);
                countRouted(db, cfg, route, true);
                countPool(db, cfg, cur.poolId, !out.overcount);
                recordEvent(db, signer, {
                  type: "x402_payment",
                  req_id: reqId as `req_${string}`,
                  payer: paid.payer,
                  tx_id: paid.tx,
                  amount_units: paid.amountUnits,
                  asset: paid.asset,
                  model: model.model_id,
                  in_tokens: comp.usage!.prompt_tokens,
                  out_tokens: out.billed,
                  route,
                  pay: "x402",
                  prompt_hash: pHash as `0x${string}`,
                  resp_hash: respHash as `0x${string}`,
                  ...(privacy ? { privacy } : {}),
                  ...(e2ee ? { e2ee: true as const } : {}),
                });
              })();
            } else {
              // Paid but not served: the payment stays in the treasury (refunds are out of scope).
              console.warn(`x402 ${reqId}: paid (${paid.tx}) but the pool failed (${comp.reason}); recorded as failed, no refund`);
              markFailed(db, cfg, reqId, cur.poolId, blameRoute(route, comp.ok ? [] : lateNodes(db, cfg, route)), comp, failureCounted);
            }
          } catch (e) {
            console.error(`billing ${reqId}: x402 record failed: ${(e as Error).message}`);
          }
          d.observe?.({ ...comp, poolId: cur.poolId });
        }),
      };
    } finally {
      if (!prepared) releaseQueue();
    }
  };
}
