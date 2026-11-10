import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { agentFromToken, creditTopup } from "../src/incentives.ts";
import { signer, TEST_JWT_SECRET, TEST_SEED } from "./helpers.ts";

const SCRIPT = new URL("../scripts/api-key.ts", import.meta.url).pathname;

test("scripts/api-key.ts: create (dev + account), list, credits, requests, revoke", () => {
  const dir = mkdtempSync(join(tmpdir(), "ramx-apikey-"));
  const dbPath = join(dir, "gateway.db");
  const env = { ...process.env, DATABASE_PATH: dbPath, GATEWAY_SIGNING_KEY: TEST_SEED, JWT_SECRET: TEST_JWT_SECRET, POOL_COORDINATOR_URL: "http://127.0.0.1:1" };
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" }));
  const runFails = (...args: string[]) => {
    try {
      execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      return String((e as { stderr: string }).stderr);
    }
    assert.fail(`expected failure: ${args.join(" ")}`);
  };
  try {
    const a = run("create", "--dev", "alice", "--name", "opencode");
    assert.equal(a.new_account, true);
    assert.match(a.token, /^gpa_agt_[A-Za-z0-9]+_[0-9a-f]{64}$/);
    assert.equal(a.budget_mc, null);
    const b = run("create", "--account", a.account_id, "--name", "ci", "--cap", "250.5");
    assert.equal(b.new_account, false);
    assert.equal(b.budget_mc, 250_500);
    assert.equal(run("create", "--dev", "alice").account_id, a.account_id, "same dev label → same account");

    const list = run("list", "--account", a.account_id);
    assert.deepEqual(list.agents.map((k: { name: string }) => k.name), ["opencode", "ci", "opencode"]);

    // The token works for the gateway; credits are visible by token or by id.
    const db = openDb(dbPath);
    const cfg = loadConfig({ DATABASE_PATH: dbPath, POOL_COORDINATOR_URL: "http://127.0.0.1:1" });
    assert.equal(agentFromToken(db, a.token)?.agentId, a.agent_id);
    creditTopup(db, cfg.net, signer, { agentId: a.agent_id, payer: "acct-9.testnet", tx: "HEqAxC3rbvSwWW6KQbzt69wp6MeWqL4JLsv1jY1gCDQy", units: "30000" });
    db.close();
    const byToken = run("credits", a.token);
    assert.equal(byToken.key_credits_mc, 30_000, "0.03 USDC = 30 credits");
    assert.equal(byToken.spendable_mc, 30_000 + byToken.account_available_mc);
    assert.deepEqual(run("credits", a.agent_id), byToken);
    assert.equal(run("credits", b.agent_id).cap_left_mc, 250_500);
    assert.deepEqual(run("requests", a.agent_id).requests, []);

    assert.equal(run("revoke", b.agent_id).revoked, true);
    assert.equal(run("revoke", b.agent_id).revoked, false, "already revoked");
    assert.match(runFails("credits", b.token), /invalid or revoked/);

    assert.match(runFails("create"), /exactly one of --dev/);
    assert.match(runFails("create", "--account", "acc_nope"), /no account acc_nope/);
    assert.match(runFails("create", "--dev", "x", "--cap", "-1"), /--cap/);
    assert.match(runFails("revoke", "agt_nope"), /no API key/);
    assert.match(runFails("bogus"), /usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
