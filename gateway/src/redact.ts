import type { ChatMessage } from "@ramx/shared";

/**
 * #6 Personal data never reaches an untrusted laptop. Before a prompt goes to a laptop pool, the
 * gateway swaps emails, phone numbers, card numbers and secrets (API keys, private keys) for
 * placeholders such as `[EMAIL_1]`, and puts the real values back into the answer before it reaches
 * the client. Nothing is stored: the mapping lives only in memory for the one request.
 * Not applied to `tee` and `trusted-all` requests (no untrusted laptop sees them).
 */

export type Redaction = { messages: ChatMessage[]; map: Map<string, string>; counts: Record<string, number> };

const SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|0x[0-9a-fA-F]{64})\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// A number run must not touch more digits on either side (so part of a longer number is never taken),
// but may end a sentence ("call +91 98765 43210.").
const CARD = /(?<![\w.]|\d[\s-])(?:\d[ -]?){12,18}\d(?!\w|[.\s-]\d)/g;
const PHONE = /(?<![\w.+]|\d[\s-])\+?\d(?:[\s().-]?\d){9,14}(?!\w|[.\s-]\d)/g;

/** Luhn checksum: a 13–19 digit run is only a card number if it passes. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Redact one text with a shared mapping (the same value always gets the same placeholder). */
function redactText(text: string, byValue: Map<string, string>, counts: Record<string, number>): string {
  const swap = (kind: string) => (value: string) => {
    let ph = byValue.get(value);
    if (!ph) {
      counts[kind] = (counts[kind] ?? 0) + 1;
      ph = `[${kind}_${counts[kind]}]`;
      byValue.set(value, ph);
    }
    return ph;
  };
  return text
    .replace(SECRET, swap("SECRET"))
    .replace(EMAIL, swap("EMAIL"))
    .replace(CARD, (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? swap("CARD")(m) : m;
    })
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 15 ? swap("PHONE")(m) : m;
    });
}

/** Redact every message. `map` goes placeholder → original value. */
export function redactMessages(messages: ChatMessage[]): Redaction {
  const byValue = new Map<string, string>();
  const counts: Record<string, number> = {};
  const one = (c: unknown): unknown => (typeof c === "string" ? redactText(c, byValue, counts)
    : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? { ...p, text: redactText((p as { text: string }).text, byValue, counts) } : p))
    : c);
  const out = messages.map((m) => ("content" in m && m.content != null ? { ...m, content: one(m.content) } : m)) as ChatMessage[];
  const map = new Map([...byValue].map(([value, ph]) => [ph, value] as const));
  return { messages: out, map, counts };
}

export const redactedTotal = (r: Redaction): number => r.map.size;

/** Put the real values back into a whole text. */
export function restore(text: string, map: Map<string, string>): string {
  if (map.size === 0) return text;
  return text.replace(/\[(?:SECRET|EMAIL|CARD|PHONE)_\d+\]/g, (ph) => map.get(ph) ?? ph);
}

/**
 * Streaming restore: placeholders can be split across chunks ("[EMA" + "IL_1]"), so the tail that
 * could still become a placeholder is held back until the next chunk or the end.
 */
export function streamRestorer(map: Map<string, string>) {
  let held = "";
  return {
    push(chunk: string): string {
      const text = held + chunk;
      const open = text.lastIndexOf("[");
      if (open >= 0 && !text.includes("]", open) && text.length - open <= 16 && /^\[[A-Z_0-9]*$/.test(text.slice(open))) {
        held = text.slice(open);
        return restore(text.slice(0, open), map);
      }
      held = "";
      return restore(text, map);
    },
    flush(): string {
      const out = restore(held, map);
      held = "";
      return out;
    },
  };
}

/**
 * Restore placeholders in an OpenAI SSE stream: rewrites `choices[].delta.content` of each event and
 * releases any held-back text in a final content event before `[DONE]` (or at the end).
 */
export function restoreSse(stream: ReadableStream<Uint8Array>, map: Map<string, string>): ReadableStream<Uint8Array> {
  if (map.size === 0) return stream;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const r = streamRestorer(map);
  let buf = "";
  let last: Record<string, unknown> | null = null;
  const tailEvent = (): string => {
    const rest = r.flush();
    if (!rest) return "";
    const ev = { ...(last ?? {}), choices: [{ index: 0, delta: { content: rest }, finish_reason: null }] };
    delete (ev as { usage?: unknown }).usage;
    return `data: ${JSON.stringify(ev)}\n\n`;
  };
  const rewrite = (event: string): string => {
    const line = event.split("\n").find((l) => l.startsWith("data: "));
    if (!line) return `${event}\n\n`;
    const data = line.slice(6).trim();
    if (data === "[DONE]") return `${tailEvent()}${event}\n\n`;
    let j: { choices?: { delta?: { content?: unknown } }[] };
    try { j = JSON.parse(data); } catch { return `${event}\n\n`; }
    const d = j.choices?.[0]?.delta;
    if (d && typeof d.content === "string") {
      d.content = r.push(d.content);
      last = { ...(j as Record<string, unknown>) };
    }
    return `${event.replace(line, `data: ${JSON.stringify(j)}`)}\n\n`;
  };
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      buf += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, i);
        buf = buf.slice(i + 2);
        ctl.enqueue(encoder.encode(rewrite(event)));
      }
    },
    flush(ctl) {
      buf += decoder.decode();
      if (buf.trim()) ctl.enqueue(encoder.encode(rewrite(buf.replace(/\n+$/, ""))));
      const tail = tailEvent();
      if (tail) ctl.enqueue(encoder.encode(tail));
    },
  }));
}
