import type { RamxConfig, ModelConfig } from "@ramx/shared";
import type { Db } from "./db.ts";
import { costMc } from "./ledger.ts";

/**
 * Per-user answer budget (credit requests). The gateway picks max_tokens itself instead of
 * trusting the client (OpenCode asks for 32k): the hold is built from it, so a user with few
 * credits still gets a shorter answer instead of a 403.
 *
 * max_tokens = min(ceiling, learned need, what the balance can pay)
 * - ceiling: the model's largest output, the room left in the context, and the client's own
 *   max_tokens when it set one;
 * - learned need: p90 of this user's (or this key's) last 50 answers × 1.25, at least 256; an answer
 *   that hit its cap doubles the next cap. Fewer than 5 answers: the client's value, else the default;
 * - balance: the largest answer whose cost (with the estimated prompt) fits the available credits.
 */

/** Below this the answer is useless: 403 insufficient_credits instead. */
export const MIN_ANSWER = 64;
const FLOOR = 256;
const SAMPLES = 50;
const MIN_SAMPLES = 5;

/** Learned answer size for an account (or one of its keys), or null without enough history. */
export function learnedNeed(db: Db, accountId: string, agentId: string | null): number | null {
  const rows = (agentId
    ? db.prepare("SELECT out_tokens, max_tokens FROM requests WHERE account_id = ? AND agent_id = ? AND status = 'ok' AND out_tokens IS NOT NULL ORDER BY ts DESC LIMIT ?").all(accountId, agentId, SAMPLES)
    : db.prepare("SELECT out_tokens, max_tokens FROM requests WHERE account_id = ? AND status = 'ok' AND out_tokens IS NOT NULL ORDER BY ts DESC LIMIT ?").all(accountId, SAMPLES)) as { out_tokens: number; max_tokens: number | null }[];
  if (rows.length < MIN_SAMPLES) return null;
  const last = rows[0]!;
  if (last.max_tokens !== null && last.out_tokens >= last.max_tokens) return last.max_tokens * 2; // cut off: grow
  const sorted = rows.map((r) => r.out_tokens).sort((a, b) => a - b);
  const p90 = sorted[Math.ceil(sorted.length * 0.9) - 1]!;
  return Math.max(FLOOR, Math.ceil(p90 * 1.25));
}

/** Largest answer (tokens) whose cost with `inTokens` of prompt fits `availableMc`. */
export function affordableTokens(cfg: RamxConfig, model: ModelConfig, availableMc: number, inTokens: number, priceMultiplier = 1): number {
  if (costMc(cfg, model, inTokens, 0, priceMultiplier) > availableMc) return 0;
  let lo = 0;
  let hi = 1 << 20;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (costMc(cfg, model, inTokens, mid, priceMultiplier) <= availableMc) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export type Pick = { maxTokens: number } | { maxTokens: null; affordable: number };

export function pickMaxTokens(o: {
  cfg: RamxConfig;
  model: ModelConfig;
  /** Upper bound from the model, the context and the client's own max_tokens. */
  ceiling: number;
  /** The client's max_tokens, or null when it sent none. */
  asked: number | null;
  learned: number | null;
  /** Spendable credits: the account's available balance, within the key's budget. */
  availableMc: number;
  inTokens: number;
  priceMultiplier?: number;
}): Pick {
  const want = Math.min(o.ceiling, o.learned ?? o.asked ?? o.cfg.cost.default_max_tokens);
  const affordable = affordableTokens(o.cfg, o.model, o.availableMc, o.inTokens, o.priceMultiplier ?? 1);
  const pick = Math.min(want, affordable);
  return pick >= Math.min(MIN_ANSWER, want) ? { maxTokens: pick } : { maxTokens: null, affordable };
}
