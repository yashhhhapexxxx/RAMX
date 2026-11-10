import type { FinalExecutionOutcome } from "@near-js/types";
import { nearProvider } from "./near.ts";

/**
 * On-chain checks for credits bought outside x402 (Phase 5). The gateway never trusts the client:
 * it reads the transaction from NEAR RPC and checks who paid, to whom, how much and the memo.
 *  - escrow:  a guarded agent called `escrow.pay(treasury, amount, memo = <API key id>)`; the escrow
 *             emits `paid` only after the USDC transfer succeeded.
 *  - wallet:  a user called `usdc.ft_transfer(treasury, amount, memo = <account id>)` from a wallet.
 * The memo binds the payment to one key / account, so a public tx hash cannot be credited to
 * someone else. Each tx is credited once (`key_topups.tx_id` primary key).
 */

/** Fetch a final transaction outcome (injected in tests). */
export type NearTxLookup = (txHash: string, senderId: string) => Promise<FinalExecutionOutcome>;

export const rpcTxLookup = (rpcUrl?: string): NearTxLookup => {
  const provider = nearProvider(rpcUrl);
  return (hash, sender) => provider.viewTransactionStatus(hash, sender, "FINAL") as Promise<FinalExecutionOutcome>;
};

export class ChainCheckError extends Error {}
const fail = (m: string): never => {
  throw new ChainCheckError(m);
};

function failure(outcome: FinalExecutionOutcome): string | null {
  const all = [outcome.status, outcome.transaction_outcome?.outcome.status, ...(outcome.receipts_outcome ?? []).map((r) => r.outcome.status)];
  for (const s of all) if (s && typeof s === "object" && (s as { Failure?: unknown }).Failure !== undefined) return JSON.stringify((s as { Failure: unknown }).Failure);
  return null;
}

type Tx = { signer_id: string; receiver_id: string; actions: unknown[] };
const txOf = (o: FinalExecutionOutcome): Tx => o.transaction as unknown as Tx;

/** The single FunctionCall action of the transaction, with its JSON args. */
function onlyCall(tx: Tx): { method: string; args: Record<string, unknown> } {
  if (tx.actions.length !== 1) fail("the transaction must have exactly one action");
  const fc = (tx.actions[0] as { FunctionCall?: { method_name: string; args: string } }).FunctionCall;
  if (!fc) fail("the transaction is not a function call");
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(Buffer.from(fc!.args, "base64").toString("utf8"));
  } catch {
    return fail("function call args are not JSON");
  }
  return { method: fc!.method_name, args };
}

/** Amount (USDC base units) a guarded agent paid to `payee` through the escrow with `memo`. */
export function escrowPayment(outcome: FinalExecutionOutcome, o: { escrow: string; agent: string; payee: string; memo: string }): string {
  const tx = txOf(outcome);
  if (tx.signer_id !== o.agent) fail(`transaction was signed by ${tx.signer_id}, not ${o.agent}`);
  if (tx.receiver_id !== o.escrow) fail(`transaction calls ${tx.receiver_id}, not the escrow ${o.escrow}`);
  const call = onlyCall(tx);
  if (call.method !== "pay") fail(`transaction calls ${call.method}, not pay`);
  const f = failure(outcome);
  if (f) fail(`the escrow payment failed: ${f}`);
  // The `paid` event, logged by the escrow contract itself (not by any other receipt).
  for (const r of outcome.receipts_outcome ?? []) {
    if ((r.outcome as { executor_id?: string }).executor_id !== o.escrow) continue;
    for (const log of r.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const e = JSON.parse(log.slice("EVENT_JSON:".length)) as { standard: string; event: string; data: { agent: string; payee: string; amount: string; memo: string }[] };
      if (e.standard !== "ramx-escrow" || e.event !== "paid") continue;
      const d = e.data[0]!;
      if (d.agent !== o.agent) fail(`escrow paid for ${d.agent}, not ${o.agent}`);
      if (d.payee !== o.payee) fail(`escrow paid ${d.payee}, not the treasury ${o.payee}`);
      if (d.memo !== o.memo) fail(`payment memo is "${d.memo}", expected the API key id "${o.memo}"`);
      if (!/^[1-9]\d*$/.test(d.amount)) fail("bad amount in the escrow event");
      return d.amount;
    }
  }
  return fail("no `paid` event from the escrow in this transaction (refused or still pending)");
}

/** Amount (USDC base units) a wallet sent to `treasury` with `ft_transfer` and `memo`. */
export function walletTransfer(outcome: FinalExecutionOutcome, o: { usdc: string; sender: string; treasury: string; memo: string }): string {
  const tx = txOf(outcome);
  if (tx.signer_id !== o.sender) fail(`transaction was signed by ${tx.signer_id}, not ${o.sender}`);
  if (tx.receiver_id !== o.usdc) fail(`transaction calls ${tx.receiver_id}, not the USDC contract`);
  const call = onlyCall(tx);
  if (call.method !== "ft_transfer") fail(`transaction calls ${call.method}, expected ft_transfer (to the treasury, memo = your account id)`);
  if (call.args.receiver_id !== o.treasury) fail(`USDC went to ${String(call.args.receiver_id)}, not the treasury ${o.treasury}`);
  if (call.args.memo !== o.memo) fail(`transfer memo is "${String(call.args.memo ?? "")}", expected your account id "${o.memo}"`);
  const amount = String(call.args.amount ?? "");
  if (!/^[1-9]\d*$/.test(amount)) fail("bad amount");
  const f = failure(outcome);
  if (f) fail(`the transfer failed: ${f}`);
  return amount;
}
