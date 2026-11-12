/**
 * Client-side privacy checks: everything here runs on the caller's machine and trusts nothing the
 * gateway says without checking it against NEAR or recomputing it.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { canonicalJson } from "@ramx/shared";

/** sha256("<salt>:<data>"), the gateway's salted hash (gateway/src/privacy.ts). */
export const saltedHash = (salt: string, data: string): string => `0x${createHash("sha256").update(`${salt}:${data}`, "utf8").digest("hex")}`;
export const promptHash = (salt: string, messages: unknown): string => saltedHash(salt, canonicalJson(messages));

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** ed25519 signature of a ledger event: `sig` over the canonical JSON of the other fields. */
export function eventSignatureOk(event: Record<string, unknown>, publicKeyHex: string): boolean {
  const { sig, ...rest } = event;
  if (typeof sig !== "string" || !/^0x[0-9a-f]+$/.test(sig)) return false;
  const pub = Buffer.from(publicKeyHex.replace(/^0x/, ""), "hex");
  if (pub.length !== 32) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(canonicalJson(rest), "utf8"), key, Buffer.from(sig.slice(2), "hex"));
}

/** RAMX ledger events emitted in a transaction's logs (NEP-297 `EVENT_JSON:`). */
export function ledgerEvents(logs: string[]): { seq: number; event: Record<string, unknown> }[] {
  return logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)) as { standard: string; event: string; data: unknown })
    .filter((e) => e.standard === "ramx" && e.event === "ledger")
    .flatMap((e) => e.data as { seq: number; event: Record<string, unknown> }[]);
}

/** Words of the prompt (4+ letters) that appear anywhere in the public logs. Empty = no text leaked. */
export function leakedWords(prompt: string, logs: string[]): string[] {
  const all = logs.join("\n").toLowerCase();
  const words = [...new Set(prompt.toLowerCase().match(/[a-z]{4,}/g) ?? [])];
  return words.filter((w) => all.includes(w));
}

/** Minimal NEAR JSON-RPC (no keys needed). */
export function nearRpc(url: string) {
  const call = async (method: string, params: unknown) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json()) as { result?: any; error?: unknown };
    if (j.error || !j.result) throw new Error(`NEAR RPC ${method}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
    return j.result;
  };
  return {
    async view(contract: string, method: string): Promise<string> {
      const res = await call("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: "e30=" });
      return JSON.parse(Buffer.from(res.result).toString());
    },
    async txLogs(hash: string, sender: string): Promise<string[]> {
      const res = await call("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
      return [...(res.transaction_outcome?.outcome.logs ?? []), ...(res.receipts_outcome ?? []).flatMap((o: any) => o.outcome.logs)];
    },
  };
}

/** Our own attestation request to NEAR AI Cloud with a fresh nonce (needs the caller's own NEAR AI key). */
export function checkAttestationReport(report: unknown, nonce: string): { signingAddress: string; hasTdxQuote: boolean } {
  const r = report as { gateway_attestation?: { request_nonce?: string }; model_attestations?: { request_nonce?: string; signing_address?: string; intel_quote?: string }[] };
  if (r.gateway_attestation?.request_nonce !== nonce) throw new Error("NEAR AI gateway attestation does not carry our nonce");
  const m = (r.model_attestations ?? []).find((a) => a.request_nonce === nonce && /^0x[0-9a-fA-F]{40}$/.test(a.signing_address ?? ""));
  if (!m) throw new Error("no model attestation with our nonce");
  return { signingAddress: m.signing_address!.toLowerCase(), hasTdxQuote: !!m.intel_quote };
}
