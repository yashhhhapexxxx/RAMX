import { Account } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import type { KeyPairString } from "@near-js/crypto";
import type { FinalExecutionOutcome } from "@near-js/types";

/**
 * Guarded agent: it holds only a FUNCTION-CALL key that may call `pay` on the escrow contract (no
 * deposit, gas allowance only). It cannot call the USDC contract, cannot change its own policy and
 * cannot add keys. Every payment is checked on chain against the owner's policy.
 */

export const TGAS = 1_000_000_000_000n;
export type Guarded = { account: Account; provider: JsonRpcProvider; agentId: string; escrow: string };

export function guardedFromEnv(env = process.env): Guarded {
  const missing = ["GUARDED_AGENT_ID", "GUARDED_AGENT_FC_KEY", "ESCROW_CONTRACT_ID"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(", ")} (scripts/near-setup.sh writes them to agent-client/.env)`);
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,}$/.test(env.GUARDED_AGENT_FC_KEY!)) throw new Error("GUARDED_AGENT_FC_KEY must be ed25519:<base58>");
  const provider = new JsonRpcProvider({ url: env.NEAR_RPC_URL || "https://rpc.testnet.fastnear.com" });
  const account = new Account(env.GUARDED_AGENT_ID!, provider, KeyPairSigner.fromSecretKey(env.GUARDED_AGENT_FC_KEY as KeyPairString));
  return { account, provider, agentId: env.GUARDED_AGENT_ID!, escrow: env.ESCROW_CONTRACT_ID! };
}

export type Attempt = { ok: true; tx: string } | { ok: false; tx: string | null; reason: string };

/** The contract's panic message (or the runtime error) from a failed outcome or a thrown error. */
const RUNTIME_REFUSALS: Record<string, string> = {
  DepositWithFunctionCall: "NEAR runtime: a function-call key cannot attach a deposit (ft_transfer needs 1 yoctoNEAR)",
};
export function reasonOf(x: unknown): string {
  const type = (x as { type?: string } | null)?.type;
  const msg = x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x);
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(msg);
  if (panic) return panic[1]!.trim();
  if (type && RUNTIME_REFUSALS[type]) return RUNTIME_REFUSALS[type]!;
  const text = msg && msg !== "{}" ? msg : "";
  return `${type ? `NEAR runtime (${type}): ` : ""}${text}`.replace(/\s+/g, " ").slice(0, 300);
}

function failureOf(o: FinalExecutionOutcome): unknown {
  const all = [o.status, ...(o.receipts_outcome ?? []).map((r) => r.outcome.status)];
  for (const s of all) if (s && typeof s === "object" && (s as { Failure?: unknown }).Failure !== undefined) return (s as { Failure: unknown }).Failure;
  return null;
}

/** Sign and send one function call with the guarded key; never throws. */
export async function attempt(g: Guarded, contractId: string, methodName: string, args: object, deposit = 0n): Promise<Attempt> {
  for (let tries = 1; ; tries++) {
    try {
      const o = await g.account.callFunctionRaw({ contractId, methodName, args, gas: 100n * TGAS, deposit });
      const tx = o.transaction.hash as string;
      const f = failureOf(o);
      return f ? { ok: false, tx, reason: reasonOf(f) } : { ok: true, tx };
    } catch (e) {
      // RPC hiccup (nothing was refused): retry; the nonce makes a resend safe.
      if (e instanceof TypeError && tries < 3) continue;
      // A refused transaction still has a hash (its outcome id) for the explorer.
      const tx = (e as { transaction_outcome?: { id?: string } }).transaction_outcome?.id ?? null;
      return { ok: false, tx, reason: reasonOf(e) };
    }
  }
}

export const pay = (g: Guarded, payee: string, amount: bigint, memo: string) => attempt(g, g.escrow, "pay", { payee, amount: amount.toString(), memo });

export type Policy = { owner: string; balance: string; budget: string; spent: string; per_call_max: string; allow: string[]; paused: boolean };
export async function policyOf(g: Guarded): Promise<Policy | null> {
  return (await g.provider.callFunction(g.escrow, "get_agent", { agent: g.agentId })) as Policy | null;
}
