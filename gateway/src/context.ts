import { contentText, type ChatCompletionRequest, type ChatMessage } from "@ramx/shared";
import { estimateInputTokens } from "./ledger.ts";
import { compactTools } from "./tools.ts";

/**
 * Fit a request into the pool's context (prompt + answer ≤ context_length). Agent clients such as
 * OpenCode resend the whole session every turn; the pool's context is small. In order:
 * 1. compact the tool definitions (when the gateway emulates tools);
 * 2. cut large tool results to head + tail;
 * 3. drop the oldest turns, keeping the system prompt and the last user turn with its tool chain.
 * Token counts are estimates (chars / 4), so a safety margin is kept free.
 */

/** Room kept free for the chat template and estimate error: 10% of the context + 64 tokens. */
export const marginTokens = (contextLength: number): number => Math.ceil(contextLength * 0.1) + 64;

/** Tool results above these sizes (characters) are cut, largest limit first. */
const TOOL_LIMITS = [8000, 3000, 1200];

export type Fit =
  | { ok: true; req: ChatCompletionRequest; promptTokens: number; trimmed: number }
  | { ok: false; promptTokens: number; budget: number };

/** Keep the start and the end of a long text, with a marker of what was cut. */
export function cutMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  const cut = text.slice(head, text.length - tail);
  const lines = cut.split("\n").length - 1;
  return `${text.slice(0, head)}\n… [${cut.length} characters${lines ? `, ${lines} lines` : ""} cut by the gateway to fit the pool's context] …\n${text.slice(text.length - tail)}`;
}

/**
 * Turns that can be dropped together: a user message, or an assistant message with the tool
 * results that answer its calls (a call is never left without its result, or the reverse).
 */
function units(messages: ChatMessage[]): ChatMessage[][] {
  const out: ChatMessage[][] = [];
  for (const m of messages) {
    if (m.role === "tool" && out.length) out[out.length - 1]!.push(m);
    else out.push([m]);
  }
  return out;
}

/**
 * Fit `req` so that prompt + `minOutput` tokens fit `contextLength` with the margin.
 * `compact` = the gateway emulates tools (their definitions go into the prompt in compact form).
 */
export function fitContext(req: ChatCompletionRequest, contextLength: number, minOutput: number, compact: boolean): Fit {
  const budget = contextLength - minOutput - marginTokens(contextLength);
  let r: ChatCompletionRequest = compact && req.tools?.length ? { ...req, tools: compactTools(req.tools) } : req;
  const size = (x: ChatCompletionRequest) => estimateInputTokens(x.messages, x.tools);
  let tokens = size(r);
  if (tokens <= budget) return { ok: true, req: r, promptTokens: tokens, trimmed: 0 };

  // The stock OpenCode tool set can exceed a 4K pool even on its first turn. Shorten
  // optional descriptions further before cutting history; keep every tool and its schema.
  if (compact && r.tools?.length) {
    r = { ...r, tools: compactTools(r.tools, 80, 0) };
    tokens = size(r);
    if (tokens <= budget) return { ok: true, req: r, promptTokens: tokens, trimmed: 0 };
  }

  // 2. cut tool results, in growing steps
  let trimmed = 0;
  for (const limit of TOOL_LIMITS) {
    let changed = 0;
    const messages = r.messages.map((m): ChatMessage => {
      if (m.role !== "tool") return m;
      const t = contentText(m.content);
      if (t.length <= limit) return m;
      changed++;
      return { ...m, content: cutMiddle(t, limit) };
    });
    if (!changed) continue;
    trimmed += changed;
    r = { ...r, messages };
    tokens = size(r);
    if (tokens <= budget) return { ok: true, req: r, promptTokens: tokens, trimmed };
  }

  // 3. drop the oldest turns between the system prompt and the last user turn
  const lead = r.messages.findIndex((m) => m.role !== "system");
  const system = lead < 0 ? r.messages : r.messages.slice(0, lead);
  const rest = lead < 0 ? [] : r.messages.slice(lead);
  const lastUser = rest.map((m) => m.role).lastIndexOf("user");
  const keepFrom = lastUser < 0 ? Math.max(0, rest.length - 1) : lastUser;
  const middle = units(rest.slice(0, keepFrom));
  const tail = rest.slice(keepFrom);
  while (middle.length && tokens > budget) {
    trimmed += middle.shift()!.length;
    r = { ...r, messages: [...system, ...middle.flat(), ...tail] };
    tokens = size(r);
  }
  return tokens <= budget ? { ok: true, req: r, promptTokens: tokens, trimmed } : { ok: false, promptTokens: tokens, budget };
}
