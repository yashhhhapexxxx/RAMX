import { contentText, Usage, type ChatCompletionRequest, type ChatMessage, type Tool, type ToolCall } from "@ramx/shared";

/**
 * Tool calling for OpenAI clients (OpenCode) on pools without native support.
 *
 * "emulate": the tools go into the system prompt in Qwen3's own (hermes) format, earlier tool calls
 * and results become text turns, and the model's `<tool_call>{…}</tool_call>` text is parsed back
 * into OpenAI `tool_calls`. "native": the request goes to Parallax unchanged.
 */
export type ToolsMode = "emulate" | "native";

type UpMessage = { role: "system" | "user" | "assistant"; content: string };

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";

/** True when the request needs tool emulation (tools offered, or tool turns in the history). */
export function usesTools(req: ChatCompletionRequest): boolean {
  return !!req.tools?.length || req.messages.some((m) => m.role === "tool" || (m.role === "assistant" && !!m.tool_calls?.length));
}

const MAX_DESC = 200;
const shortDesc = (d: string, limit = MAX_DESC): string => {
  const first = d.split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim();
  return first.length > limit ? `${first.slice(0, limit - 1)}…` : first;
};

/** JSON Schema without noise: no examples/$schema/titles, short descriptions. Keeps names, types, required. */
function compactSchema(v: unknown, descriptionLimit: number): unknown {
  if (Array.isArray(v)) return v.map(x => compactSchema(x, descriptionLimit));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "examples" || k === "$schema" || k === "title" || k === "additionalProperties" || k === "default") continue;
    if (k === "description" && descriptionLimit === 0) continue;
    out[k] = k === "description" && typeof x === "string" ? shortDesc(x, descriptionLimit) : k === "properties" && x && typeof x === "object"
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([p, s]) => [p, compactSchema(s, descriptionLimit)]))
      : compactSchema(x, descriptionLimit);
  }
  return out;
}

/** Smaller tool definitions for the prompt (OpenCode's descriptions are long). */
export function compactTools(tools: Tool[], descriptionLimit = MAX_DESC, parameterDescriptionLimit = descriptionLimit): Tool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.function.name,
      ...(t.function.description ? { description: shortDesc(t.function.description, descriptionLimit) } : {}),
      ...(t.function.parameters ? { parameters: compactSchema(t.function.parameters, parameterDescriptionLimit) as Record<string, unknown> } : {}),
    },
  }));
}

/** The tools block Qwen3's chat template renders (same words), appended to the system prompt. */
export function toolsPrompt(tools: Tool[], choice: ChatCompletionRequest["tool_choice"]): string {
  const lines = tools.map((t) => JSON.stringify(t)).join("\n");
  let s =
    "# Tools\n\nYou may call one or more functions to assist with the user query.\n\n" +
    "You are provided with function signatures within <tools></tools> XML tags:\n<tools>\n" + lines + "\n</tools>\n\n" +
    "For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n" +
    '<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>';
  if (choice === "required") s += "\n\nYou must call at least one function.";
  else if (choice && typeof choice === "object") s += `\n\nYou must call the function ${choice.function.name}.`;
  return s;
}

const parseArgs = (a: string): unknown => {
  try {
    return JSON.parse(a);
  } catch {
    return a;
  }
};
const callText = (c: ToolCall): string => `${OPEN}\n${JSON.stringify({ name: c.function.name, arguments: parseArgs(c.function.arguments) })}\n${CLOSE}`;

/**
 * Messages for Parallax: plain strings only. Tools go into the system prompt; assistant tool calls
 * become `<tool_call>` text; consecutive tool results become one user turn of `<tool_response>`s
 * (how Qwen3's template shows them).
 */
export function emulatedMessages(req: ChatCompletionRequest, tools: Tool[] = req.tools ?? []): UpMessage[] {
  const choice = req.tool_choice;
  const offered = choice === "none" ? [] : choice && typeof choice === "object" ? tools.filter((t) => t.function.name === choice.function.name) : tools;
  const out: UpMessage[] = [];
  for (const m of req.messages as ChatMessage[]) {
    if (m.role === "tool") {
      const block = `<tool_response>\n${contentText(m.content)}\n</tool_response>`;
      const prev = out[out.length - 1];
      if (prev?.role === "user" && prev.content.startsWith("<tool_response>")) prev.content += `\n${block}`;
      else out.push({ role: "user", content: block });
    } else if (m.role === "assistant") {
      const text = contentText(m.content);
      const calls = (m.tool_calls ?? []).map(callText).join("\n");
      out.push({ role: "assistant", content: [text, calls].filter(Boolean).join("\n") });
    } else {
      out.push({ role: m.role, content: contentText(m.content) });
    }
  }
  if (offered.length) {
    const block = toolsPrompt(offered, choice);
    if (out[0]?.role === "system") out[0] = { role: "system", content: `${out[0].content}\n\n${block}` };
    else out.unshift({ role: "system", content: block });
  }
  return out;
}

/** Parse one `<tool_call>` body. Repairs code fences and missing closing braces; null = not a call. */
export function parseCall(body: string, index: number): ToolCall | null {
  let s = body.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  for (let i = 0; i <= 3; i++) {
    try {
      const j = JSON.parse(s) as { name?: unknown; arguments?: unknown };
      if (typeof j?.name !== "string" || !j.name) return null;
      const args = j.arguments === undefined ? {} : j.arguments;
      return { id: `call_${index}`, type: "function", function: { name: j.name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
    } catch {
      s += "}";
    }
  }
  return null;
}

export type ToolEvent = { type: "text"; text: string } | { type: "call"; call: ToolCall };

/**
 * Streaming parser: model text in, plain text and finished tool calls out. Holds back only what
 * could be the start of `<tool_call>`, so normal text streams without delay. A call that does not
 * parse is given back as text, never dropped.
 */
export class ToolCallParser {
  private buf = "";
  private inCall = false;
  calls = 0;

  feed(delta: string): ToolEvent[] {
    this.buf += delta;
    const out: ToolEvent[] = [];
    for (;;) {
      if (!this.inCall) {
        const at = this.buf.indexOf(OPEN);
        if (at >= 0) {
          if (at > 0) out.push({ type: "text", text: this.buf.slice(0, at) });
          this.buf = this.buf.slice(at + OPEN.length);
          this.inCall = true;
          continue;
        }
        // keep a tail that could still become "<tool_call>"
        let keep = 0;
        for (let k = Math.min(OPEN.length - 1, this.buf.length); k > 0; k--) {
          if (OPEN.startsWith(this.buf.slice(-k))) { keep = k; break; }
        }
        const emit = this.buf.slice(0, this.buf.length - keep);
        if (emit) out.push({ type: "text", text: emit });
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      const end = this.buf.indexOf(CLOSE);
      if (end < 0) return out;
      out.push(this.close(this.buf.slice(0, end)));
      this.buf = this.buf.slice(end + CLOSE.length);
      this.inCall = false;
    }
  }

  /** End of the answer: flush held text; an unclosed call is parsed if it is complete JSON. */
  end(): ToolEvent[] {
    const rest = this.buf;
    this.buf = "";
    if (!this.inCall) return rest ? [{ type: "text", text: rest }] : [];
    this.inCall = false;
    return [this.close(rest, false)];
  }

  private close(body: string, closed = true): ToolEvent {
    const call = parseCall(body, this.calls);
    if (call) {
      this.calls++;
      return { type: "call", call };
    }
    return { type: "text", text: `${OPEN}${body}${closed ? CLOSE : ""}` };
  }
}

/** Whole answer (non-streaming): content without the calls, and the calls. */
export function splitAnswer(text: string): { content: string | null; tool_calls: ToolCall[] } {
  const p = new ToolCallParser();
  const evs = [...p.feed(text), ...p.end()];
  const content = evs.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("").trim();
  const tool_calls = evs.flatMap((e) => (e.type === "call" ? [e.call] : []));
  return { content: content || (tool_calls.length ? null : ""), tool_calls };
}

/** Non-streaming upstream body → OpenAI response with `tool_calls` and finish_reason "tool_calls". */
export function rewriteCompletion(body: Record<string, any>): Record<string, any> {
  const choice = body.choices?.[0];
  if (!choice?.message) return body;
  const { content, tool_calls } = splitAnswer(String(choice.message.content ?? ""));
  const message = tool_calls.length ? { role: "assistant", content, tool_calls } : { role: "assistant", content: content ?? "" };
  return { ...body, choices: [{ ...choice, message, finish_reason: tool_calls.length ? "tool_calls" : choice.finish_reason ?? "stop" }] };
}

/**
 * Streaming: rewrite the SSE events the gateway sends (already proxied by proxyStream) so text
 * deltas carry plain text and `<tool_call>` blocks become `delta.tool_calls`. Other events
 * (usage, comments, errors, [DONE]) pass through; held text is flushed before the finish.
 */
export function toolStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const parser = new ToolCallParser();
  let buf = "";
  let flushed = false;
  let finished = false;
  let completed = false;
  let failed = false;
  let base: Record<string, any> = { object: "chat.completion.chunk", choices: [] };

  // the index of a call is fixed when it is emitted: count as we go
  const emit = (evs: ToolEvent[]): string => {
    let s = "";
    let seen = parser.calls - evs.filter((e) => e.type === "call").length;
    for (const e of evs) {
      if (e.type === "call") seen++;
      const idx = seen - 1;
      s += e.type === "text"
        ? `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: e.text }, finish_reason: null }] })}\n\n`
        : `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: e.call.id, type: "function", function: e.call.function }] }, finish_reason: null }] })}\n\n`;
    }
    return s;
  };
  /** Successful turns must finish explicitly, including the plain answer after a tool result.
      Otherwise OpenCode treats the finish as unknown and keeps requesting another turn. */
  const flush = (closeTurn = true): string => {
    if (failed) return "";
    let s = "";
    if (!flushed) { flushed = true; s = emit(parser.end()); }
    if (closeTurn && !finished) {
      finished = true;
      s += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: parser.calls > 0 ? "tool_calls" : "stop" }] })}\n\n`;
    }
    return s;
  };

  const rewrite = (ev: string): string => {
    const lines = ev.split(/\r?\n/);
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (!dataLine) return `${ev}\n\n`;
    const data = dataLine.slice(5).trim();
    // proxyStream emits DONE only after validated usage; error streams have no DONE.
    if (data === "[DONE]") { completed = true; return `${flush()}${ev}\n\n`; }
    let chunk: Record<string, any>;
    try {
      chunk = JSON.parse(data);
    } catch {
      return `${ev}\n\n`;
    }
    if (chunk.error) { failed = true; return `${ev}\n\n`; }
    const hasUsage = Usage.safeParse(chunk.usage).success;
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) {
      if (hasUsage) completed = true;
      return `${hasUsage ? flush() : ""}${ev}\n\n`;
    }
    const { choices: _c, usage: _u, ...rest } = chunk;
    base = { ...rest };
    const choice = chunk.choices[0];
    let out = "";
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) out += emit(parser.feed(delta.content));
    else if (delta.role && !out) out += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: delta.role, content: "" }, finish_reason: null }] })}\n\n`;
    if (choice.finish_reason) {
      out += flush(false);
      finished = true;
      const finish = parser.calls > 0 ? "tool_calls" : choice.finish_reason;
      out += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(chunk.usage ? { usage: chunk.usage } : {}) })}\n\n`;
    } else if (hasUsage) {
      completed = true;
      out += flush();
      out += `data: ${JSON.stringify({ ...base, choices: [], usage: chunk.usage })}\n\n`;
    }
    return out;
  };

  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const r = await reader.read();
        if (r.done) {
          buf += dec.decode();
          let out = buf.trim() ? buf.split(/\r?\n\r?\n/).filter((e) => e.trim()).map(rewrite).join("") : "";
          buf = "";
          // Never repair an incomplete/error stream into a successful tool execution.
          if (completed || finished) out += flush(completed);
          if (out) controller.enqueue(enc.encode(out));
          controller.close();
          return;
        }
        buf += dec.decode(r.value, { stream: true });
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop()!;
        const out = parts.filter((e) => e.trim()).map(rewrite).join("");
        if (out) { controller.enqueue(enc.encode(out)); return; }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
