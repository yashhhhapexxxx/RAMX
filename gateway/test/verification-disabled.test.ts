import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { signer, testDirectory } from "./helpers.ts";

// SPEC §16.2: output verification is a planned feature and is off unless VERIFICATION_ENABLED=true.
const base = { DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001" };

test("verification is disabled by default: config flag false and /verifications routes absent", async () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.env.VERIFICATION_ENABLED, "false");
  const db = openDb(":memory:");
  try {
    const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db) });
    assert.equal((await app.request("/verifications/ver_x")).status, 404);
    assert.equal((await app.request("/verifications/ver_x/appeal", { method: "POST" })).status, 404);
  } finally {
    db.close();
  }
});

test("VERIFICATION_ENABLED=true mounts the /verifications routes (session required)", async () => {
  const cfg = loadConfig({ ...base, VERIFICATION_ENABLED: "true" });
  const db = openDb(":memory:");
  try {
    const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db) });
    assert.equal((await app.request("/verifications/ver_x")).status, 401);
  } finally {
    db.close();
  }
});
