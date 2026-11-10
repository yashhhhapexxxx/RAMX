import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * SQLite schema (SPEC §8.7). Credits are integer millicredits (`*_mc`), token amounts (USDC) are
 * base-unit decimal strings, times are Unix ms. No migrations (dev phase): when SCHEMA_VERSION
 * changes, delete the database file and restart.
 */
export const SCHEMA_VERSION = 23;

export const TABLES = [
  "provider_pools", "provider_members", "provider_enrollments",
  "accounts",
  "balances",
  "nodes",
  "node_reliability",
  "node_heartbeats",
  "node_request_outcomes",
  "requests",
  "ledger_events",
  "epochs",
  "epoch_payouts",
  "transcripts",
  "pools",
  "node_served",
  "node_rtt",
  "verification_jobs",
  "verification_appeals",
  "verification_node_risk",
  "node_challenges",
  "verification_canaries",
  "earned_lots",
  "network_reserve",
  "pool_waits",
  "penalties",
  "availability_epochs",
  "agent_keys",
  "key_topups",
  "near_nonces",
  "tee_checks",
  "tee_attestations",
  "swarm_commits", "swarm_reveals", "swarm_rounds", "swarm_slots",
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_pools (
  pool_id TEXT PRIMARY KEY, owner_account TEXT NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL,
  expected_members INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'preparing', generation INTEGER NOT NULL DEFAULT 0,
  dht_prefix TEXT NOT NULL, lan_secret TEXT NOT NULL, snapshots TEXT, scheduler_addr TEXT, start_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_members (
  id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES provider_pools(pool_id), account_id TEXT NOT NULL,
  role TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0,
  node_id TEXT UNIQUE, payout_address TEXT NOT NULL, token_hash TEXT UNIQUE, token_expires_at INTEGER,
  stage TEXT NOT NULL DEFAULT 'waiting', message TEXT NOT NULL DEFAULT '', ip TEXT, gpu TEXT, mem_gb REAL,
  bytes_done INTEGER NOT NULL DEFAULT 0, bytes_total INTEGER NOT NULL DEFAULT 0, last_seen INTEGER,
  UNIQUE(pool_id, account_id)
);
CREATE TABLE IF NOT EXISTS provider_enrollments (
  code_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES provider_members(id), expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,                 -- acc_…
  world_nullifier  TEXT NOT NULL UNIQUE,             -- never leaves the gateway; 'near:<account>' for a NEAR-wallet-only account
  near_account     TEXT UNIQUE,                      -- NEAR wallet login (NEP-413)
  payout_address   TEXT,                             -- NEAR account that receives epoch payouts
  created_at       INTEGER NOT NULL,
  credential       TEXT,                             -- §16.3: strongest World credential (orb / passport / selfie)
  banned_at        INTEGER,                          -- §16.3: nullifier banned from running nodes
  ban_evidence     TEXT
);
CREATE TABLE IF NOT EXISTS balances (
  account_id          TEXT PRIMARY KEY REFERENCES accounts(id),
  starter_mc          INTEGER NOT NULL DEFAULT 0 CHECK (starter_mc >= 0),
  starter_expires_at  INTEGER,
  bought_mc           INTEGER NOT NULL DEFAULT 0 CHECK (bought_mc >= 0),  -- USDC wallet top-ups; never expire
  earned_mc           INTEGER NOT NULL DEFAULT 0 CHECK (earned_mc >= 0),
  held_mc             INTEGER NOT NULL DEFAULT 0 CHECK (held_mc >= 0),
  earned_total_mc     INTEGER NOT NULL DEFAULT 0,
  spent_total_mc      INTEGER NOT NULL DEFAULT 0,
  locked_mc           INTEGER NOT NULL DEFAULT 0 CHECK (locked_mc >= 0)  -- §16.3: earned, still vesting
);
CREATE TABLE IF NOT EXISTS nodes (
  node_id        TEXT PRIMARY KEY,                   -- lowercase EVM address of the node key
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  pool_id        TEXT NOT NULL,
  gpu            TEXT NOT NULL,
  mem_gb         REAL NOT NULL,
  registered_at  INTEGER NOT NULL,
  -- latest signed heartbeat (POST /nodes/heartbeat); the pool layer map is built from these (SPEC §5.5)
  hb_ts          INTEGER,                            -- gateway receive time, ms
  hb_online      INTEGER,
  hb_model       TEXT,
  hb_layers      TEXT,                               -- JSON [start, end) or NULL
  hb_tok_s       REAL,
  hb_max_seq     INTEGER,
  -- post-MVP P5 heartbeat fields
  hb_peer_id         TEXT,                           -- Parallax peer ID (P5.4 admission, P5.8/P5.9)
  hb_lan_ip          TEXT,                           -- P5.6
  hb_mem_pressure    TEXT,                           -- P5.7: ok / swap_growing
  hb_usable_mem_gb   REAL,                           -- P5.7
  hb_restart_ack     INTEGER,                        -- P5.5: last pool restart ID executed
  hb_p2p_port        INTEGER,                        -- §16.1 formation: Parallax TCP port
  hb_hw_verified     INTEGER,                        -- P6.4 false after a failed capability check; null before first check
  auto_pool          INTEGER NOT NULL DEFAULT 0,     -- §16.1 formation: registered in pool "auto"
  banned             INTEGER NOT NULL DEFAULT 0      -- §16.3: owner banned; the router skips its pools
);
CREATE TABLE IF NOT EXISTS node_reliability (
  node_id              TEXT PRIMARY KEY REFERENCES nodes(node_id),
  requests_routed      INTEGER NOT NULL DEFAULT 0,
  requests_ok          INTEGER NOT NULL DEFAULT 0,
  heartbeats_expected  INTEGER NOT NULL DEFAULT 0,
  heartbeats_received  INTEGER NOT NULL DEFAULT 0,
  score                REAL NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS node_heartbeats (
  node_id  TEXT NOT NULL REFERENCES nodes(node_id),
  slot_ts  INTEGER NOT NULL,
  PRIMARY KEY (node_id, slot_ts)
);
CREATE TABLE IF NOT EXISTS node_request_outcomes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id  TEXT NOT NULL REFERENCES nodes(node_id),
  ok       INTEGER NOT NULL CHECK (ok IN (0, 1)),
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS node_outcomes_window ON node_request_outcomes(node_id, ts);
CREATE TABLE IF NOT EXISTS requests (
  req_id               TEXT PRIMARY KEY,             -- req_…
  account_id           TEXT REFERENCES accounts(id), -- null for x402
  x402_payer           TEXT,                         -- NEAR account ID
  x402_tx              TEXT,                         -- NEAR tx hash
  x402_amount  TEXT,                         -- USDC paid, in base units
  x402_asset           TEXT,                         -- NEP-141 token contract paid (USDC)
  model                TEXT NOT NULL,
  pay_type             TEXT NOT NULL CHECK (pay_type IN ('credits', 'x402')),
  in_tokens            INTEGER,
  out_tokens           INTEGER,
  cost_mc              INTEGER,
  price_multiplier     REAL,
  split                TEXT,                         -- JSON CreditSplit
  payout_snapshot      TEXT,                         -- x402 provider attribution frozen at request start
  route                TEXT,                         -- JSON Route (node → layers); NULL = unknown (SPEC §5.5)
  status               TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed')),
  prompt_hash          TEXT NOT NULL,
  resp_hash            TEXT,
  ledger_seq           INTEGER,                      -- NEAR ledger contract sequence of the settle event
  ledger_tx            TEXT,                         -- NEAR tx hash that appended it
  attempts             TEXT,                         -- JSON RequestAttempt[]; NULL = first attempt, no failover (P5.2)
  route_source         TEXT,                         -- P5.8: scheduler (hook route log) / heartbeat
  hash_salt            TEXT,                         -- privacy: salt of prompt_hash / resp_hash (never public)
  privacy              TEXT,                         -- privacy: trusted-ends / trusted-all / NULL
  agent_id             TEXT,                         -- §16.3: agent key that sent the request (human-backed)
  sampling_seed       INTEGER,
  sampling_settings   TEXT,
  max_tokens           INTEGER,                      -- answer cap the gateway picked (budget.ts); learns per user
  backend              TEXT,                         -- "pool" or "near-ai-cloud" (judge mode); set when the request finishes
  ts                   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,                        -- JSON LedgerEvent (with sig)
  gateway_sig  TEXT NOT NULL,
  ledger_seq   INTEGER,                              -- null until final on the NEAR ledger contract
  ledger_tx    TEXT,                                 -- NEAR tx hash that appended the event
  ts           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS epochs (
  epoch          INTEGER PRIMARY KEY,
  start_ts       INTEGER NOT NULL,
  end_ts         INTEGER NOT NULL,
  total_units  TEXT NOT NULL,
  merkle_root    TEXT,
  post_tx        TEXT,                               -- NEAR tx of the funding ft_transfer_call
  status         TEXT NOT NULL,
  ledger_event_id    INTEGER REFERENCES ledger_events(id),
  claimable_at   INTEGER                             -- ms: claims open on the payout contract
);
CREATE TABLE IF NOT EXISTS epoch_payouts (
  epoch           INTEGER NOT NULL REFERENCES epochs(epoch),
  payout_address  TEXT NOT NULL,
  amount_units  TEXT NOT NULL,
  proof           TEXT NOT NULL,                     -- JSON array of Hex32
  claimed         INTEGER NOT NULL DEFAULT 0,
  claim_tx        TEXT,
  PRIMARY KEY (epoch, payout_address)
);
CREATE TABLE IF NOT EXISTS pools (                 -- post-MVP P5.5 clean restart orders
  pool_id      TEXT PRIMARY KEY,
  restart_id   INTEGER NOT NULL DEFAULT 0,           -- 0 = never ordered
  restart_at   INTEGER,                              -- ms
  model        TEXT,                                 -- §16.1 formation: model of an "auto" pool
  formed_at    INTEGER
);
-- SPEC §9.2 pool reliability: the pool is the reputation identity the router scores.
CREATE TABLE IF NOT EXISTS pool_request_outcomes (   -- one row per request routed to the pool
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id  TEXT NOT NULL,
  ok       INTEGER NOT NULL,                         -- 1 = served, 0 = failed (client aborts excluded)
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pool_request_outcomes_pool_ts ON pool_request_outcomes (pool_id, ts);
CREATE TABLE IF NOT EXISTS pool_up_slots (           -- heartbeat-interval slots in which the pool was complete
  pool_id  TEXT NOT NULL,
  slot_ts  INTEGER NOT NULL,                         -- wall clock, floored to HEARTBEAT_SECONDS
  PRIMARY KEY (pool_id, slot_ts)
);
CREATE TABLE IF NOT EXISTS pool_reliability (
  pool_id          TEXT PRIMARY KEY,
  first_seen       INTEGER NOT NULL,                 -- ms; uptime is counted from here (inside the window)
  requests_routed  INTEGER NOT NULL DEFAULT 0,
  requests_ok      INTEGER NOT NULL DEFAULT 0,
  slots_expected   INTEGER NOT NULL DEFAULT 0,
  slots_up         INTEGER NOT NULL DEFAULT 0,
  score            REAL,                             -- null until refreshed; reads fall back to initial_score
  updated_at       INTEGER
);
CREATE TABLE IF NOT EXISTS node_rtt (                -- §16.1 formation: measured delay a → b
  a    TEXT NOT NULL,
  b    TEXT NOT NULL,
  ms   REAL NOT NULL,
  ts   INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS node_served (             -- post-MVP P5.9 node reports from --notify-url
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id   TEXT NOT NULL REFERENCES nodes(node_id),
  peer_id   TEXT,
  sessions  INTEGER NOT NULL,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS node_served_window ON node_served(node_id, ts);
CREATE TABLE IF NOT EXISTS verification_jobs (
  id               TEXT PRIMARY KEY,
  req_id           TEXT NOT NULL UNIQUE REFERENCES requests(req_id),
  pool_id          TEXT NOT NULL,
  route            TEXT NOT NULL,
  owner_accounts   TEXT NOT NULL,
  model            TEXT NOT NULL,
  seed             INTEGER NOT NULL,
  settings         TEXT NOT NULL,
  score            REAL,
  threshold        REAL,
  verdict          TEXT NOT NULL CHECK (verdict IN ('queued','pass','flag','error','appealed','final_pass','final_flag')),
  reference_hash   TEXT,
  verifier_owner   TEXT,
  created_at       INTEGER NOT NULL,
  checked_at       INTEGER,
  appeal_until     INTEGER NOT NULL,
  final_at         INTEGER
);
CREATE INDEX IF NOT EXISTS verification_jobs_queue ON verification_jobs(verdict, created_at);
CREATE TABLE IF NOT EXISTS verification_canaries (
  id             TEXT PRIMARY KEY,
  pool_id        TEXT NOT NULL,
  model          TEXT NOT NULL,
  route_hash     TEXT NOT NULL,
  score          REAL NOT NULL,
  threshold      REAL NOT NULL,
  verdict        TEXT NOT NULL CHECK (verdict IN ('pass','flag')),
  ts             INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_appeals (
  id               TEXT PRIMARY KEY,
  verification_id  TEXT NOT NULL REFERENCES verification_jobs(id),
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('queued','checked','error')),
  score            REAL,
  verdict          TEXT,
  created_at       INTEGER NOT NULL,
  checked_at       INTEGER,
  UNIQUE(verification_id)
);
CREATE TABLE IF NOT EXISTS verification_node_risk (
  node_id          TEXT PRIMARY KEY REFERENCES nodes(node_id),
  alpha            REAL NOT NULL DEFAULT 1,
  beta             REAL NOT NULL DEFAULT 1,
  flagged          INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS node_challenges (
  challenge_id     TEXT PRIMARY KEY,
  node_id          TEXT NOT NULL REFERENCES nodes(node_id),
  nonce            TEXT NOT NULL,
  expires_at       INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('issued','passed','failed','expired')),
  issued_at        INTEGER NOT NULL,
  returned_at      INTEGER,
  result_hash      TEXT,
  elapsed_ms       INTEGER
);
CREATE TABLE IF NOT EXISTS earned_lots (              -- §16.3 vesting + expiry: one lot per credit to an owner
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  source        TEXT NOT NULL CHECK (source IN ('request', 'availability')),
  ref           TEXT,                                 -- req_id or epoch
  amount_mc     INTEGER NOT NULL CHECK (amount_mc > 0),
  remaining_mc  INTEGER NOT NULL CHECK (remaining_mc >= 0),  -- unlocked and not yet spent / expired
  created_at    INTEGER NOT NULL,
  unlock_at     INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('locked', 'unlocked', 'clawed'))
);
CREATE INDEX IF NOT EXISTS earned_lots_account ON earned_lots(account_id, status, unlock_at);
CREATE TABLE IF NOT EXISTS network_reserve (          -- §16.3: reserve share of every settled request
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  balance_mc  INTEGER NOT NULL DEFAULT 0 CHECK (balance_mc >= 0)
);
CREATE TABLE IF NOT EXISTS pool_waits (               -- §16.3 availability: requests that waited for a pool slot
  pool_id  TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  wait_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pool_waits_ts ON pool_waits(ts);
CREATE TABLE IF NOT EXISTS penalties (                -- §16.3: one row per final fraud verdict handled
  verification_id  TEXT PRIMARY KEY,
  nodes            TEXT NOT NULL,                     -- JSON node IDs blamed (may be empty)
  accounts         TEXT NOT NULL,                     -- JSON accounts penalized
  clawed_mc        INTEGER NOT NULL,
  ts               INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS availability_epochs (      -- §16.3: standby rewards paid once per epoch
  epoch_start  INTEGER PRIMARY KEY,
  paid_mc      INTEGER NOT NULL,
  ts           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_keys (               -- §16.3 Agent Pass (MVP form): human-backed agent keys
  id           TEXT PRIMARY KEY,                      -- agt_…
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  name         TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,                         -- sha256 of the secret part; the token is shown once
  budget_mc    INTEGER CHECK (budget_mc IS NULL OR budget_mc >= 0), -- NULL = no cap (whole balance)
  spent_mc     INTEGER NOT NULL DEFAULT 0,          -- everything this key spent (bought + account)
  -- Credits bought with USDC for this key only (x402 top-ups). The cap (budget_mc) limits account credits only.
  key_credits_mc   INTEGER NOT NULL DEFAULT 0 CHECK (key_credits_mc >= 0),
  key_held_mc      INTEGER NOT NULL DEFAULT 0 CHECK (key_held_mc >= 0),
  bought_total_mc  INTEGER NOT NULL DEFAULT 0,
  key_spent_mc     INTEGER NOT NULL DEFAULT 0,      -- part of spent_mc paid from key_credits_mc
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE TABLE IF NOT EXISTS key_topups (               -- USDC → key or account credits; the USDC stays in the treasury
  tx_id          TEXT PRIMARY KEY,                    -- NEAR tx: one top-up per payment, never twice
  agent_id       TEXT REFERENCES agent_keys(id),      -- NULL = account credits (wallet top-up)
  via            TEXT NOT NULL,                       -- x402 | escrow | wallet
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  payer          TEXT NOT NULL,
  amount_units TEXT NOT NULL,
  amount_mc      INTEGER NOT NULL,
  ts             INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tee_checks (               -- Phase 6.2: sampled answers judged in NEAR AI Cloud's TEE
  req_id             TEXT PRIMARY KEY REFERENCES requests(req_id),
  pool_id            TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('queued', 'done', 'error')),
  judge_model        TEXT, nonce TEXT, verdict TEXT, reason TEXT, chat_id TEXT,
  signing_address    TEXT, attestation_sha256 TEXT,
  signature_ok       INTEGER, hashes_match INTEGER,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  judged_at          INTEGER
);
CREATE TABLE IF NOT EXISTS tee_attestations (         -- Phase J: attestation of the NEAR AI model that served a request
  req_id             TEXT PRIMARY KEY REFERENCES requests(req_id),
  model              TEXT NOT NULL,
  nonce              TEXT NOT NULL,
  signing_address    TEXT NOT NULL,
  attestation_sha256 TEXT NOT NULL,
  attested_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS swarm_commits (             -- Phase 7 capacity market (swarm-sim/RULES.md)
  round_id INTEGER NOT NULL, agent TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('buyer', 'seller')),
  commit_hex TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (round_id, agent, role)
);
CREATE TABLE IF NOT EXISTS swarm_reveals (
  round_id INTEGER NOT NULL, agent TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
  units INTEGER NOT NULL, price_mc INTEGER NOT NULL, salt TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (round_id, agent, role)
);
CREATE TABLE IF NOT EXISTS swarm_rounds (
  round_id INTEGER PRIMARY KEY, cleared_at INTEGER NOT NULL, commits_sha256 TEXT NOT NULL, orders TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS swarm_slots (                -- priority requests won in a round
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, model TEXT NOT NULL,
  units_left INTEGER NOT NULL, round_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS near_nonces (              -- NEP-413 login nonces: single use, short-lived
  nonce       TEXT PRIMARY KEY,                       -- base64, 32 bytes
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transcripts (
  req_id      TEXT PRIMARY KEY REFERENCES requests(req_id),
  prompt      TEXT NOT NULL,
  response    TEXT,
  expires_at  INTEGER NOT NULL                       -- 7 days (SPEC §14)
);
`;

export type Db = Database.Database;

export type OpenOptions = {
  /**
   * Dev phase (CLAUDE.md §1: no migrations). When the file has another schema version: true (default) =
   * move it aside as `<file>-bak-v<N>-<time>` and start a fresh database on the latest schema (nothing is
   * deleted); false = refuse to start.
   */
  resetOnMismatch?: boolean;
};

/** Move a database file (and any leftover WAL/SHM files) aside. Returns the backup path. */
function backupAside(path: string, version: number, now = Date.now()): string {
  const backup = `${path}-bak-v${version}-${now}`;
  renameSync(path, backup);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) renameSync(path + suffix, backup + suffix);
  return backup;
}

export function openDb(path: string, opts: OpenOptions = {}): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  let db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  const hasTables = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n > 0;
  if (hasTables && version !== SCHEMA_VERSION) {
    if (path === ":memory:" || opts.resetOnMismatch === false) {
      db.close();
      throw new Error(`database ${path} has schema v${version}, need v${SCHEMA_VERSION}: remove the file, or set DB_RESET_ON_MISMATCH=true to move it aside automatically`);
    }
    db.close(); // a clean close checkpoints the WAL into the main file
    const backup = backupAside(path, version);
    console.warn(JSON.stringify({ msg: "db_schema_reset", found: version, need: SCHEMA_VERSION, backup }));
    db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  db.exec(SCHEMA);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}
