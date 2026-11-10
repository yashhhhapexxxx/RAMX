/**
 * Provider CLI: claim RAMX epoch payouts (USDC on NEAR testnet). Preview by default; --broadcast sends.
 *   node --env-file=provider.env scripts/claim-payout.ts [--epoch N] [--broadcast]
 * Env: GATEWAY_URL, PAYOUT_CONTRACT_ID, PROVIDER_ACCOUNT_ID (your payout account) + PROVIDER_SECRET_KEY
 * (ed25519:…), NEAR_RPC_URL (optional). Your account must be registered on the USDC contract
 * (storage_deposit), or the contract undoes the claim and you can retry after registering.
 */
import { parseArgs } from "node:util";
import { PayoutsResponse } from "@ramx/shared";
import { verifyPayoutProof, type Hash } from "../src/merkle.ts";
import { assertSuccess, nearAccount, nearProvider, nep297Events, TGAS, txHashOf } from "../src/near.ts";

const { values } = parseArgs({ options: { broadcast: { type: "boolean", default: false }, epoch: { type: "string" } } });
const e = process.env;
for (const key of ["GATEWAY_URL", "PAYOUT_CONTRACT_ID", "PROVIDER_ACCOUNT_ID", "PROVIDER_SECRET_KEY"]) if (!e[key]) throw new Error(`missing ${key} (see gateway/provider.env.example)`);
if (e.NEAR_RPC_URL && /mainnet/i.test(e.NEAR_RPC_URL)) throw new Error("claims run on NEAR testnet only");
const account = e.PROVIDER_ACCOUNT_ID!;
const contract = e.PAYOUT_CONTRACT_ID!;
const response = await fetch(new URL(`/payouts/${account}`, e.GATEWAY_URL!), { signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`payout API returned HTTP ${response.status}`);
const data = PayoutsResponse.parse(await response.json());
if (data.payout_address !== account) throw new Error("payout API returned a different provider account");
const provider = nearProvider(e.NEAR_RPC_URL);
const signer = nearAccount(account, e.PROVIDER_SECRET_KEY!, e.NEAR_RPC_URL);
let count = 0;
for (const p of data.payouts) {
  if (values.epoch && String(p.epoch) !== values.epoch) continue;
  if (p.claimed || p.swept || !p.claimable) continue;
  if (!verifyPayoutProof(account, BigInt(p.amount_units), p.proof as Hash[], p.merkle_root as Hash)) throw new Error(`invalid Merkle proof for epoch ${p.epoch}`);
  // Read the contract before spending gas: same root, not claimed yet.
  const onchain = await provider.callFunction(contract, "get_epoch", { epoch: p.epoch }) as { root: string } | null;
  if (!onchain || `0x${onchain.root}` !== p.merkle_root) throw new Error(`epoch ${p.epoch}: the contract root differs from the gateway's`);
  if (await provider.callFunction(contract, "has_claimed", { epoch: p.epoch, account })) { console.log(`epoch ${p.epoch}: already claimed`); continue; }
  console.log(JSON.stringify({ epoch: p.epoch, provider: account, amount_units: p.amount_units, broadcast: values.broadcast }));
  if (values.broadcast) {
    const outcome = await signer.callFunctionRaw({ contractId: contract, methodName: "claim", args: { epoch: p.epoch, amount: p.amount_units, proof: p.proof }, gas: 100n * TGAS });
    assertSuccess(outcome, `claim epoch ${p.epoch}`);
    const failed = nep297Events(outcome).some((ev) => ev.event === "claim_failed");
    if (failed) throw new Error(`claim undone: register ${account} on the USDC contract (storage_deposit), then retry`);
    console.log(`Claim confirmed: https://testnet.nearblocks.io/txns/${txHashOf(outcome)}`);
  }
  count++;
}
console.log(count ? `${count} claim(s) ${values.broadcast ? "sent" : "ready (add --broadcast to send)"}` : "nothing to claim");
