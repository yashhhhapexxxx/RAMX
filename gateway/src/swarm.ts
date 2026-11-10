import { keccak256, toBytes, type Hex } from "viem";
import { canonicalJson, MerkleLeaf } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { BundleStore } from "./settlement.ts";
import { payoutTree } from "./merkle.ts";

/**
 * SPEC §16.4 Swarm bundles. Each closed x402 epoch gets one JSON bundle (income receipts, frozen
 * routes, payout list, Merkle inputs; never prompts or transcripts) on Swarm. Its 64-hex reference
 * goes into the signed `epoch_closed` ledger event, so anyone can rebuild the epoch's Merkle root from
 * the bundle alone (`scripts/verify-bundle.ts`).
 *
 * Bee API (https://docs.ethswarm.org): POST /bzz?name=<file> with header Swarm-Postage-Batch-Id
 * uploads one file and answers { reference }; GET /bzz/<reference> returns it. A new postage batch
 * is usable only after a few confirmations (Bee answers 422 until then); the gateway retries.
 */

const REF = /^[0-9a-f]{64}$/;

export function beeStore(opts: { apiUrl: string; batchId: string; timeoutMs?: number }): BundleStore {
  if (!/^[0-9a-f]{64}$/i.test(opts.batchId)) throw new Error("BEE_POSTAGE_BATCH_ID must be a 64-hex batch ID");
  return {
    async upload(name, json) {
      const r = await fetch(new URL(`/bzz?name=${encodeURIComponent(name)}`, opts.apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "swarm-postage-batch-id": opts.batchId, "swarm-pin": "true" },
        body: json,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (!r.ok) throw new Error(`Bee upload returned HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      const ref = ((await r.json()) as { reference?: string }).reference?.toLowerCase();
      if (!ref || !REF.test(ref)) throw new Error("Bee answered without a valid reference");
      return ref;
    },
  };
}

export const swarmStore = (cfg: Config): BundleStore | undefined =>
  cfg.env.BEE_API_URL && cfg.env.BEE_POSTAGE_BATCH_ID ? beeStore({ apiUrl: cfg.env.BEE_API_URL, batchId: cfg.env.BEE_POSTAGE_BATCH_ID }) : undefined;

export async function fetchBundle(apiUrl: string, ref: string): Promise<unknown> {
  if (!REF.test(ref)) throw new Error("Swarm reference must be 64 lowercase hex characters");
  const r = await fetch(new URL(`/bzz/${ref}`, apiUrl), { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Bee download returned HTTP ${r.status}`);
  return r.json();
}

export type BundleCheck = { ok: boolean; epoch: number; root: Hex; computedRoot: Hex; payoutsHash: Hex; computedHash: Hex; total: string; computedTotal: string; receipts: number; problems: string[] };

/**
 * Rebuild the epoch from the bundle alone: payout list → Merkle root and hash, total = Σ payouts,
 * and (optionally) compare with the root posted on-chain / in the ledger event.
 */
export function checkBundle(bundle: unknown, expectedRoot?: string): BundleCheck {
  const b = bundle as { epoch: number; total_units: string; merkle_root: Hex; payouts_hash: Hex; payouts: unknown[]; receipts?: unknown[] };
  const payouts = (b.payouts ?? []).map((p) => MerkleLeaf.parse(p));
  const tree = payoutTree(b.epoch, payouts);
  const computedTotal = payouts.reduce((s, p) => s + BigInt(p.amount_units), 0n).toString();
  const problems: string[] = [];
  if (tree.root !== b.merkle_root) problems.push(`merkle root ${tree.root} != bundle ${b.merkle_root}`);
  if (tree.hash !== b.payouts_hash) problems.push(`payouts hash ${tree.hash} != bundle ${b.payouts_hash}`);
  if (computedTotal !== b.total_units) problems.push(`total ${computedTotal} != bundle ${b.total_units}`);
  if (expectedRoot && expectedRoot.toLowerCase() !== tree.root) problems.push(`root ${tree.root} != expected ${expectedRoot}`);
  return { ok: problems.length === 0, epoch: b.epoch, root: b.merkle_root, computedRoot: tree.root, payoutsHash: b.payouts_hash, computedHash: tree.hash,
    total: b.total_units, computedTotal, receipts: b.receipts?.length ?? 0, problems };
}

/** Deterministic digest of a bundle (for logs). */
export const bundleDigest = (bundle: unknown): Hex => keccak256(toBytes(canonicalJson(bundle)));
