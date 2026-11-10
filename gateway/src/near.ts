import { Account } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import type { KeyPairString } from "@near-js/crypto";
import type { FinalExecutionOutcome } from "@near-js/types";

/**
 * NEAR RPC boundary for the gateway (ledger writer, payout settlement, registry). Testnet only
 * (CLAUDE.md §5.7). Keys are `ed25519:<base58>` strings from the env; they never leave this process.
 */

export const NEAR_TESTNET_RPC = "https://rpc.testnet.fastnear.com";
/** 1 TGas = 10^12 gas. A plain function call fits in 30 TGas; batches and cross-contract calls use more. */
export const TGAS = 1_000_000_000_000n;

export const nearProvider = (rpcUrl = NEAR_TESTNET_RPC): JsonRpcProvider => new JsonRpcProvider({ url: rpcUrl });

export function nearAccount(accountId: string, secretKey: string, rpcUrl?: string): Account {
  if (!/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{40,}$/.test(secretKey)) throw new Error(`NEAR key for ${accountId} must be ed25519:<base58>`);
  return new Account(accountId, nearProvider(rpcUrl), KeyPairSigner.fromSecretKey(secretKey as KeyPairString));
}

/** Throws with the contract's panic message when the transaction (or any receipt) failed. */
export function assertSuccess(outcome: FinalExecutionOutcome, what: string): void {
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown } | string;
  if (typeof status === "object" && status.Failure !== undefined) throw new Error(`${what} failed: ${JSON.stringify(status.Failure)}`);
  for (const r of outcome.receipts_outcome ?? []) {
    const s = r.outcome.status as { Failure?: unknown } | string;
    if (typeof s === "object" && s.Failure !== undefined) throw new Error(`${what} failed in a receipt: ${JSON.stringify(s.Failure)}`);
  }
}

/** The JSON return value of a successful function call (base64 SuccessValue), or undefined. */
export function returnValue<T>(outcome: FinalExecutionOutcome): T | undefined {
  const status = outcome.status as { SuccessValue?: string } | string;
  if (typeof status !== "object" || !status.SuccessValue) return undefined;
  return JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8")) as T;
}

/** Every `EVENT_JSON:` log (NEP-297) of a transaction, in receipt order. */
export function nep297Events(outcome: FinalExecutionOutcome): { standard: string; version: string; event: string; data: unknown }[] {
  const logs = [...(outcome.transaction_outcome?.outcome.logs ?? []), ...(outcome.receipts_outcome ?? []).flatMap((r) => r.outcome.logs)];
  return logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice("EVENT_JSON:".length)));
}

export const txHashOf = (outcome: FinalExecutionOutcome): string => outcome.transaction.hash as string;
