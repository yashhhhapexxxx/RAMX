/**
 * How a swarm agent chooses its bid each round.
 *
 * Every agent has a private profile (what a slot is worth to a buyer, what it costs a seller, how many
 * units it wants or offers) and sees the clearing prices of past rounds. With SWARM_LLM_API_KEY set, each
 * agent asks an OpenAI-compatible model (default NEAR AI Cloud) for its bid and the model explains its
 * choice in one line. The answer is checked against the bid schema and clamped to the agent's profile:
 * a buyer never bids above its value, a seller never asks below its cost. Without a key, or when the
 * model fails or times out, the agent falls back to a random bid inside the same limits.
 */
import { randomInt } from "node:crypto";
import { SwarmBid, type SwarmRole } from "@ramx/shared";

export type Profile = {
  role: SwarmRole;
  /** buyer: most it will pay per slot; seller: least it accepts per slot (mc). */
  limit_mc: number;
  /** buyer: slots it wants; seller: slots it can serve. */
  units: number;
  /** model the agent cares about most */
  model: string;
};

/** Recent clearing prices per model, newest last. */
export type Market = Record<string, number[]>;

export type LlmConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number };

export type Decision = { bid: SwarmBid; source: "llm" | "random"; why?: string };

export function newProfile(role: SwarmRole, models: string[]): Profile {
  const model = models[randomInt(models.length)]!;
  return role === "buyer"
    ? { role, model, limit_mc: randomInt(300, 1501), units: randomInt(1, 6) }
    : { role, model, limit_mc: randomInt(200, 901), units: randomInt(3, 11) };
}

/** Random bid inside the profile: buyers shade below their value, sellers mark up above their cost. */
export function randomBid(p: Profile): SwarmBid {
  return p.role === "buyer"
    ? { role: "buyer", model: p.model, units: p.units, price_mc: Math.max(1, Math.round(p.limit_mc * (0.6 + Math.random() * 0.4))) }
    : { role: "seller", model: p.model, units: p.units, price_mc: Math.round(p.limit_mc * (1 + Math.random() * 0.4)) };
}

export function promptFor(agentId: string, p: Profile, market: Market, models: string[]): { system: string; user: string } {
  const history = models.map((m) => `${m}: ${(market[m] ?? []).slice(-5).join(", ") || "no trades yet"}`).join("\n");
  const system =
    "You are an autonomous trading agent in a sealed-bid market for priority AI inference slots. " +
    "Each round has one uniform clearing price per model. Buyers win if their price is at or above it; sellers sell if their price is at or below it. " +
    "Bid to maximise your own surplus. Reply with JSON only: " +
    '{"model": "<model id>", "units": <integer>, "price_mc": <integer>, "why": "<one short sentence>"}';
  const goal = p.role === "buyer"
    ? `You are buyer ${agentId}. You need ${p.units} slots, preferably for ${p.model}. A slot is worth at most ${p.limit_mc} mc to you; never bid above that.`
    : `You are seller ${agentId}. You can serve up to ${p.units} slots, preferably of ${p.model}. Each slot costs you ${p.limit_mc} mc; never ask below that.`;
  return { system, user: `${goal}\nModels: ${models.join(", ")}\nRecent clearing prices (mc per slot):\n${history}\nYour bid for this round:` };
}

/** First JSON object in the model's answer, checked against the bid schema and clamped to the profile. */
export function parseDecision(text: string, p: Profile, models: string[]): { bid: SwarmBid; why?: string } | null {
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let j: { model?: unknown; units?: unknown; price_mc?: unknown; why?: unknown };
  try { j = JSON.parse(m[0]); } catch { return null; }
  const model = typeof j.model === "string" && models.includes(j.model) ? j.model : p.model;
  const units = Math.min(p.units, Math.max(1, Math.round(Number(j.units))));
  let price = Math.round(Number(j.price_mc));
  if (!Number.isFinite(units) || !Number.isFinite(price)) return null;
  price = p.role === "buyer" ? Math.min(price, p.limit_mc) : Math.max(price, p.limit_mc);
  const bid = SwarmBid.safeParse({ role: p.role, model, units, price_mc: Math.max(1, price) });
  if (!bid.success) return null;
  return { bid: bid.data, why: typeof j.why === "string" ? j.why.slice(0, 160) : undefined };
}

type Fetch = typeof fetch;

/** One agent's decision for one round. Never throws: any failure becomes a random bid. */
export async function decide(agentId: string, p: Profile, market: Market, models: string[], llm: LlmConfig | null, f: Fetch = fetch): Promise<Decision> {
  if (!llm) return { bid: randomBid(p), source: "random" };
  try {
    const { system, user } = promptFor(agentId, p, market, models);
    const r = await f(`${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({ model: llm.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 200, temperature: 0.7 }),
      signal: AbortSignal.timeout(llm.timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const d = parseDecision(body.choices?.[0]?.message?.content ?? "", p, models);
    if (!d) throw new Error("no valid bid in the answer");
    return { ...d, source: "llm" };
  } catch {
    return { bid: randomBid(p), source: "random" };
  }
}

/** LLM settings from the environment, or null (random strategy). */
export function llmFromEnv(env: NodeJS.ProcessEnv): LlmConfig | null {
  if (env.SWARM_STRATEGY === "random" || !env.SWARM_LLM_API_KEY) return null;
  return {
    baseUrl: env.SWARM_LLM_BASE_URL ?? "https://cloud-api.near.ai/v1",
    apiKey: env.SWARM_LLM_API_KEY,
    model: env.SWARM_LLM_MODEL ?? "Qwen/Qwen3.8-27B",
    timeoutMs: Number(env.SWARM_LLM_TIMEOUT_MS ?? 8000),
  };
}
