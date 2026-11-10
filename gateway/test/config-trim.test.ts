import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("env values pasted with a trailing newline or spaces are trimmed (hosting dashboards)", () => {
  const cfg = loadConfig({ POOL_COORDINATOR_URL: " http://127.0.0.1:3001\n", DATABASE_PATH: ":memory:\r\n", NEAR_GATEWAY_KEY: `ed25519:${"3".repeat(80)}\n`, PORT: "10000 " });
  assert.equal(cfg.env.POOL_COORDINATOR_URL, "http://127.0.0.1:3001");
  assert.equal(cfg.env.DATABASE_PATH, ":memory:");
  assert.equal(cfg.env.NEAR_GATEWAY_KEY, `ed25519:${"3".repeat(80)}`);
  assert.equal(cfg.env.PORT, 10000);
});
