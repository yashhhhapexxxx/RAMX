import { z } from "zod";
import { AccountId, EpochNumber, EvmAddress, Hex32, LayerRange, TokenUnits, NearAccountId } from "./common.ts";

/**
 * Epoch payout Merkle tree (SPEC §10.5). The gateway (TS) and contracts-near/payout must agree
 * (cross-language vector: contracts-near/payout/tests/merkle-vector.json):
 *
 * - leaf  = sha256(payout_address UTF-8 ‖ 0x00 ‖ amount_units as u128 big-endian, 16 bytes)
 * - node  = sha256(sorted(a, b))  — the smaller 32-byte value first
 * - one leaf per payout address (NEAR account) per epoch; leaves with amount 0 are left out
 * - one-leaf tree: root = leaf, proof = []; an odd node is promoted unchanged
 */
export const MERKLE_LEAF_ENCODING = "sha256(account_id || 0x00 || u128_be(amount))" as const;
export const MERKLE_PAIR_ORDER = "sorted" as const;

export const MerkleLeaf = z.object({
  payout_address: NearAccountId,
  amount_units: TokenUnits,
});
export type MerkleLeaf = z.infer<typeof MerkleLeaf>;

/** What a provider needs to call `claim(epoch, amount, proof)`. */
export const PayoutProof = z.object({
  epoch: EpochNumber,
  payout_address: NearAccountId,
  amount_units: TokenUnits,
  proof: z.array(Hex32),
  merkle_root: Hex32,
});
export type PayoutProof = z.infer<typeof PayoutProof>;

/** Provider attribution frozen when an x402 request starts (never recomputed from later ownership changes). */
export const PayoutRoute = z.array(z.object({
  node_id: EvmAddress,
  owner_account: AccountId,
  payout_address: NearAccountId.nullable(),
  layers: LayerRange,
})).min(1);
export type PayoutRoute = z.infer<typeof PayoutRoute>;
