import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RamxConfig } from "@ramx/shared";

export const loadNetConfig = (): RamxConfig =>
  RamxConfig.parse(JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@ramx/shared/config.json")), "utf8")));

/** x402 price (SPEC §7.3, same rule as the gateway): first tier with tier.max_tokens >= max_tokens. USDC base units. */
export function priceUnits(cfg: RamxConfig, modelId: string, maxTokens: number): bigint {
  const m = cfg.models.find((x) => x.model_id === modelId);
  if (!m) throw new Error(`unknown model ${modelId}`);
  const tier = m.x402_prices.find((t) => maxTokens <= t.max_tokens);
  if (!tier) throw new Error(`max_tokens ${maxTokens} is above the last tier for ${modelId}`);
  return BigInt(tier.price_units);
}

/** "1.5" USDC → 1500000 base units (exact decimal, no float). */
export function usdcToUnits(usdc: string, decimals = 6): bigint {
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`).exec(usdc.trim());
  if (!m) throw new Error(`not a USDC amount with at most ${decimals} decimals: ${usdc}`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

/** Base units → "0.004" USDC, for display. */
export const unitsToUsdc = (units: bigint, decimals = 6): string => {
  const s = units.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
};

/** Budget cap (SPEC §13): pay the next request only if it does not take the total above the budget. */
export function canAfford(spent: bigint, price: bigint, budget: bigint): boolean {
  return spent + price <= budget;
}

/** NEAR tx hash → NearBlocks explorer URL. */
export function explorerTxUrl(txHash: string, network = "testnet"): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) throw new Error(`not a NEAR tx hash: ${txHash}`);
  return `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${txHash}`;
}

/** NEAR secret keys are "ed25519:<base58>" (or "secp256k1:<base58>"), as near-cli stores them. */
export function nearSecretKey(raw: string): `ed25519:${string}` | `secp256k1:${string}` {
  const k = raw.trim();
  if (!/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{40,}$/.test(k)) throw new Error("AGENT_SECRET_KEY must be a NEAR key: ed25519:<base58> (from ~/.near-credentials or near-cli)");
  return k as `ed25519:${string}`;
}
