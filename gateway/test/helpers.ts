import { keccak256, toBytes } from "viem";
import type { Directory } from "../src/router.ts";
export const TEST_NODE = "0x" + "f".repeat(40);
import type { Config } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { signerFromSeed } from "../src/events.ts";
import { loginOrCreate } from "../src/accounts.ts";
import { issueToken } from "../src/auth.ts";

/** Test-only secrets (not real keys). */
export const TEST_JWT_SECRET = "test-jwt-secret-not-real";
export const TEST_SEED = "11".repeat(32);
export const signer = signerFromSeed(TEST_SEED);

/** A World-verified account (via the real login function) and its session token. */
export async function testAccount(db: Db, cfg: Config, nullifier = `0x${Math.random().toString(16).slice(2).padStart(64, "0")}`) {
  const login = loginOrCreate(db, cfg, signer, nullifier);
  const token = await issueToken(TEST_JWT_SECRET, login.accountId, 3600);
  return { accountId: login.accountId, token, auth: { authorization: `Bearer ${token}` } };
}

export const balance = (db: Db, accountId: string) =>
  db.prepare("SELECT starter_mc, starter_expires_at, earned_mc, held_mc, earned_total_mc, spent_total_mc, locked_mc FROM balances WHERE account_id = ?").get(accountId) as {
    starter_mc: number; starter_expires_at: number; earned_mc: number; held_mc: number; earned_total_mc: number; spent_total_mc: number; locked_mc: number;
  };

/** Fake directory plus a fresh registered node for proxy/payment integration tests. */
export function testDirectory(cfg: Config, db: Db, poolId = "pool-router-test", seed = true): Directory {
  if (seed) {
    db.prepare("INSERT INTO accounts (id, world_nullifier, created_at) VALUES ('acc_router', 'router-fixture', ?)").run(Date.now());
    db.prepare("INSERT INTO balances (account_id) VALUES ('acc_router')").run();
    db.prepare(`INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at, hb_ts, hb_online, hb_model, hb_layers)
      VALUES (?, 'acc_router', ?, 'fixture', 8, ?, ?, 1, ?, '[0,40]')`).run(TEST_NODE, poolId, Date.now(), Date.now(), "Qwen/Qwen3-14B-FP8");
  }
  return {
    pools: async () => [],
    nodes: async () => [],
    models: async () => cfg.net.models.map((m) => ({ ...m, type: "ramx.model" as const })),
    readyPools: async (model) => [{ type: "ramx.pool", reliability: 0.8, pool_id: poolId, models: [model],
      members: (db.prepare("SELECT node_id FROM nodes WHERE pool_id = ?").all(poolId) as { node_id: string }[]).map((n) => n.node_id),
      status: "ready", coordinator_url_hash: keccak256(toBytes(cfg.env.POOL_COORDINATOR_URL)), layer_map: null }],
  };
}

/** A NEAR tx hash shape (base58, 44 chars) that differs per n. */
export const fakeTxHash = (n: number): string => `LedgerTx${"1".repeat(28)}${String(n).padStart(8, "1").replaceAll("0", "z")}`;

/**
 * In-memory ledger contract with the same rule as contracts-near/ledger: a batch is accepted only
 * when first_seq == seq + 1. `seen` gets every appended event (signed JSON) in order.
 */
export function fakeLedgerChain(seen: (event: string) => void = () => {}) {
  let seq = 0;
  let txs = 0;
  return {
    get last() { return seq; },
    async append(firstSeq: number, events: string[]) {
      if (firstSeq !== seq + 1) throw new Error(`Smart contract panicked: expected first_seq ${seq + 1}`);
      events.forEach(seen);
      seq += events.length;
      return { tx: fakeTxHash(++txs) };
    },
    async seq() { return seq; },
  };
}
