import { createHash } from "node:crypto";
import { canonicalJson, MerkleLeaf, type PayoutProof } from "@ramx/shared";

/**
 * Epoch payout Merkle tree, identical to contracts-near/payout (shared/src/merkle.ts; cross-language
 * vector contracts-near/payout/tests/merkle-vector.json):
 *   leaf = sha256(account_id UTF-8 ‖ 0x00 ‖ amount u128 big-endian), pair = sha256(min ‖ max).
 * Hashes are `0x` + 64 lowercase hex in the gateway; the contract takes them with or without `0x`.
 */

export type Hash = `0x${string}`;
export const ZERO_ROOT: Hash = `0x${"0".repeat(64)}`;

const sha256 = (data: Buffer): Buffer => createHash("sha256").update(data).digest();
const hex = (b: Buffer): Hash => `0x${b.toString("hex")}`;
const bytes = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");

/** u128 big-endian, 16 bytes. */
function u128(amount: bigint): Buffer {
  if (amount < 0n || amount >= 1n << 128n) throw new Error(`amount out of u128 range: ${amount}`);
  return Buffer.from(amount.toString(16).padStart(32, "0"), "hex");
}

export const payoutLeaf = (account: string, amount: bigint): Hash =>
  hex(sha256(Buffer.concat([Buffer.from(account, "utf8"), Buffer.from([0]), u128(amount)])));

export const pairHash = (a: Hash, b: Hash): Hash => {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return hex(sha256(Buffer.concat([bytes(lo), bytes(hi)])));
};

/** One leaf per account; zero amounts omitted; leaves sorted by hash; odd nodes promoted unchanged. */
export function payoutTree(epoch: number, input: MerkleLeaf[]): { root: Hash; hash: Hash; payouts: MerkleLeaf[]; proofs: PayoutProof[] } {
  const amounts = new Map<string, bigint>();
  for (const raw of input) {
    const p = MerkleLeaf.parse(raw);
    amounts.set(p.payout_address, (amounts.get(p.payout_address) ?? 0n) + BigInt(p.amount_units));
  }
  const payouts = [...amounts].filter(([, amount]) => amount > 0n).sort(([a], [b]) => a.localeCompare(b))
    .map(([payout_address, amount]) => ({ payout_address, amount_units: amount.toString() }));
  const sorted = payouts.map((p) => ({ ...p, leaf: payoutLeaf(p.payout_address, BigInt(p.amount_units)) })).sort((a, b) => a.leaf.localeCompare(b.leaf));
  const levels: Hash[][] = [sorted.map((p) => p.leaf)];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!;
    const next: Hash[] = [];
    for (let i = 0; i < previous.length; i += 2) next.push(previous[i + 1] ? pairHash(previous[i]!, previous[i + 1]!) : previous[i]!);
    levels.push(next);
  }
  const root = levels.at(-1)![0] ?? ZERO_ROOT;
  const proofs = sorted.map((p, index) => {
    const proof: Hash[] = [];
    for (const level of levels.slice(0, -1)) {
      const sibling = level[index ^ 1];
      if (sibling) proof.push(sibling);
      index = Math.floor(index / 2);
    }
    return { epoch, payout_address: p.payout_address, amount_units: p.amount_units, proof, merkle_root: root };
  });
  return { root, hash: hex(sha256(Buffer.from(canonicalJson(payouts), "utf8"))), payouts, proofs };
}

export function verifyPayoutProof(account: string, amount: bigint, proof: Hash[], root: Hash): boolean {
  return proof.reduce((hash, sibling) => pairHash(hash, sibling), payoutLeaf(account, amount)) === root;
}
