#!/usr/bin/env node
/**
 * Check ledger events on NEAR (anyone can run this; no secrets needed):
 *   node src/verify-event.ts <tx_hash> [gateway_pubkey_hex]
 *   node --env-file=.env src/verify-event.ts --pubkey      prints the public key of GATEWAY_SIGNING_KEY
 * Env: LEDGER_CONTRACT_ID (default ledger.ramx.testnet), NEAR_RPC_URL (default testnet RPC).
 * Reads the transaction, takes every `ramx`/`ledger` NEP-297 event it emitted, and checks each
 * event's schema and its ed25519 signature against the key the contract publishes (or the one given).
 * Exit 1 if any event is invalid.
 */
import { LedgerEvent } from "@ramx/shared";
import { signerFromSeed, verifyEvent } from "./events.ts";
import { nearProvider, nep297Events } from "./near.ts";

const [arg, pubArg] = process.argv.slice(2);
if (arg === "--pubkey") {
  if (!process.env.GATEWAY_SIGNING_KEY) throw new Error("GATEWAY_SIGNING_KEY is not set");
  console.log(signerFromSeed(process.env.GATEWAY_SIGNING_KEY).publicKeyHex);
  process.exit(0);
}
if (!arg || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(arg)) {
  console.error("usage: verify-event.ts <near_tx_hash> [gateway_pubkey_hex] | --pubkey");
  process.exit(1);
}
const contract = process.env.LEDGER_CONTRACT_ID ?? "ledger.ramx.testnet";
const provider = nearProvider(process.env.NEAR_RPC_URL);
const writer = String(await provider.callFunction(contract, "writer", {}));
const pub = pubArg ?? String(await provider.callFunction(contract, "pubkey", {}));
const outcome = await provider.viewTransactionStatus(arg, writer, "FINAL");
const entries = nep297Events(outcome)
  .filter((e) => e.standard === "ramx" && e.event === "ledger")
  .flatMap((e) => e.data as { seq: number; event: Record<string, unknown> }[]);
if (entries.length === 0) {
  console.error(`transaction ${arg} has no RAMX ledger events (contract ${contract})`);
  process.exit(1);
}
let ok = true;
for (const { seq, event } of entries) {
  const schema = LedgerEvent.safeParse(event).success;
  const sig = verifyEvent(event, pub);
  ok &&= schema && sig;
  console.log(JSON.stringify({ contract, tx: arg, seq, type: event.type, schema: schema ? "valid" : "INVALID", signature: sig ? "valid" : "INVALID" }));
}
console.log(ok ? `all ${entries.length} event(s) valid, gateway key ${pub}` : "INVALID events found");
process.exit(ok ? 0 : 1);
