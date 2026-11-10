import { test } from "node:test";
import assert from "node:assert/strict";
import { canAfford, explorerTxUrl, loadNetConfig, nearSecretKey, priceUnits, unitsToUsdc, usdcToUnits } from "../src/budget.ts";

test("price tiers match the shared config (SPEC §7.3), USDC base units", () => {
  const cfg = loadNetConfig();
  assert.equal(priceUnits(cfg, "Qwen/Qwen3-14B-FP8", 128), 4_000n);
  assert.equal(priceUnits(cfg, "Qwen/Qwen3-14B-FP8", 1024), 12_000n);
  assert.equal(priceUnits(cfg, "Qwen/Qwen3-8B-FP8", 512), 2_000n);
  assert.throws(() => priceUnits(cfg, "Qwen/Qwen3-14B-FP8", 4096), /last tier/);
});

test("USDC ↔ base units is exact", () => {
  assert.equal(usdcToUnits("1"), 1_000_000n);
  assert.equal(usdcToUnits("0.05"), 50_000n);
  assert.equal(usdcToUnits("0.000001"), 1n);
  assert.throws(() => usdcToUnits("0.0000001"));
  assert.throws(() => usdcToUnits("-1"));
  assert.equal(unitsToUsdc(4_000n), "0.004");
  assert.equal(unitsToUsdc(1_000_000n), "1");
  assert.equal(unitsToUsdc(0n), "0");
});

test("budget cap: stop before a payment would exceed the budget", () => {
  const budget = usdcToUnits("0.01"); // 10,000
  const price = 4_000n;
  let spent = 0n;
  let paid = 0;
  for (let i = 0; i < 5; i++) {
    if (!canAfford(spent, price, budget)) break;
    spent += price;
    paid++;
  }
  assert.equal(paid, 2);
  assert.equal(spent, 8_000n);
  assert.equal(canAfford(8_000n, 2_000n, budget), true); // exactly at the cap is allowed
});

test("NearBlocks link", () => {
  assert.equal(explorerTxUrl("4PQy4V66tfykETHsSgt49GBpPdWMAUSbnVLDkMz7RsxC"), "https://testnet.nearblocks.io/txns/4PQy4V66tfykETHsSgt49GBpPdWMAUSbnVLDkMz7RsxC");
  assert.throws(() => explorerTxUrl("0.0.9@1.1"));
});

test("NEAR secret keys: ed25519:<base58> only", () => {
  const k = `ed25519:${"3".repeat(80)}`;
  assert.equal(nearSecretKey(` ${k} `), k);
  assert.throws(() => nearSecretKey("ab".repeat(32)));
  assert.throws(() => nearSecretKey("ed25519:0OIl"));
});

test("top-up rate in shared config: 1 USDC = 1000 credits", () => {
  assert.equal(loadNetConfig().topup.credits_per_usdc, 1000);
});
