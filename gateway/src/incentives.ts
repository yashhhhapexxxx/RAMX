import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentKey, AgentRequest, CollusionFlagsResponse, CreditSplit, RamxConfig, KeyCreditsResponse } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { recordEvent, type Signer } from "./events.ts";
import { availableMc } from "./ledger.ts"; // call-time only (ledger imports this module too)

/**
 * SPEC §16.3 incentives and reputation, on the MVP ledger (SQLite working copy + a ledger event for
 * every balance change, integer millicredits). See SPEC §8.8.
 *
 * Balances: `earned_mc` = unlocked, spendable earned credits; `locked_mc` = earned credits still
 * vesting. Every credit to an owner is one row in `earned_lots`, so vesting, oldest-first spending,
 * expiry and clawback are exact.
 */

type Acc = `acc_${string}`;

// ---------- World credential tier ----------

export type Credential = "orb" | "passport" | "selfie";
const RANK: Record<Credential, number> = { selfie: 1, passport: 2, orb: 3 };
const IDS: Record<string, Credential> = {
  proof_of_human: "orb", orb: "orb",
  passport: "passport", document: "passport", secure_document: "passport",
  selfie: "selfie", face: "selfie",
};

/** Strongest credential among the IDKit result identifiers (null = none accepted). */
export function credentialOf(identifiers: string[]): Credential | null {
  let best: Credential | null = null;
  for (const id of identifiers) {
    const c = IDS[id];
    if (c && (!best || RANK[c] > RANK[best])) best = c;
  }
  return best;
}

/** Keep the strongest credential an account has shown (same nullifier, one account). */
export function upgradeCredential(db: Db, accountId: string, c: Credential | null): void {
  if (!c) return;
  const row = db.prepare("SELECT credential FROM accounts WHERE id = ?").get(accountId) as { credential: Credential | null } | undefined;
  if (row && (!row.credential || RANK[c] > RANK[row.credential])) db.prepare("UPDATE accounts SET credential = ? WHERE id = ?").run(c, accountId);
}

// ---------- network reserve ----------

export function addReserve(db: Db, mc: number): void {
  if (mc <= 0) return;
  db.prepare("INSERT INTO network_reserve (id, balance_mc) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET balance_mc = balance_mc + excluded.balance_mc").run(mc);
}

export const reserveMc = (db: Db): number => (db.prepare("SELECT balance_mc FROM network_reserve WHERE id = 1").get() as { balance_mc: number } | undefined)?.balance_mc ?? 0;

function takeReserve(db: Db, mc: number): void {
  const r = db.prepare("UPDATE network_reserve SET balance_mc = balance_mc - ? WHERE id = 1 AND balance_mc >= ?").run(mc, mc);
  if (r.changes !== 1) throw new Error(`network reserve has less than ${mc} mc`);
}

// ---------- vesting ----------

/**
 * Credit an owner (request share or standby reward). With vesting_s > 0 the credits are locked
 * until unlock_at; earned_total (the contribution ratio) counts them at once.
 */
export function creditEarned(db: Db, cfg: RamxConfig, accountId: string, mc: number, source: "request" | "availability", ref: string, now = Date.now()): void {
  if (mc <= 0) return;
  const unlockAt = now + cfg.incentives.vesting_s * 1000;
  const locked = unlockAt > now;
  db.prepare(`INSERT INTO earned_lots (account_id, source, ref, amount_mc, remaining_mc, created_at, unlock_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(accountId, source, ref, mc, locked ? 0 : mc, now, unlockAt, locked ? "locked" : "unlocked");
  db.prepare(`UPDATE balances SET ${locked ? "locked_mc = locked_mc + @mc" : "earned_mc = earned_mc + @mc"}, earned_total_mc = earned_total_mc + @mc WHERE account_id = @id`).run({ mc, id: accountId });
}

/** Move every lot whose vesting ended into the spendable balance. Returns the number of lots. */
export function unlockDue(db: Db, now = Date.now()): number {
  return db.transaction(() => {
    const lots = db.prepare("SELECT id, account_id, amount_mc FROM earned_lots WHERE status = 'locked' AND unlock_at <= ?").all(now) as { id: number; account_id: string; amount_mc: number }[];
    for (const l of lots) {
      db.prepare("UPDATE earned_lots SET status = 'unlocked', remaining_mc = amount_mc WHERE id = ?").run(l.id);
      db.prepare("UPDATE balances SET locked_mc = locked_mc - ?, earned_mc = earned_mc + ? WHERE account_id = ?").run(l.amount_mc, l.amount_mc, l.account_id);
    }
    return lots.length;
  })();
}

/** Spend `mc` of unlocked earned credits from the oldest lots first (settle calls this). */
export function consumeEarned(db: Db, accountId: string, mc: number): void {
  let left = mc;
  const lots = db.prepare("SELECT id, remaining_mc FROM earned_lots WHERE account_id = ? AND status = 'unlocked' AND remaining_mc > 0 ORDER BY unlock_at, id").all(accountId) as { id: number; remaining_mc: number }[];
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(left, l.remaining_mc);
    db.prepare("UPDATE earned_lots SET remaining_mc = remaining_mc - ? WHERE id = ?").run(take, l.id);
    left -= take;
  }
}

// ---------- expiry of earned credits ----------

/**
 * Unlocked earned credits older than earned_expiry_days expire (oldest first), but never below
 * what running requests hold. One credits_expired (kind "earned") event per account.
 */
export function expireEarned(db: Db, cfg: RamxConfig, signer: Signer, now = Date.now()): number {
  const cutoff = now - cfg.incentives.earned_expiry_days * 86_400_000;
  return db.transaction(() => {
    const accounts = db.prepare("SELECT DISTINCT account_id FROM earned_lots WHERE status = 'unlocked' AND remaining_mc > 0 AND unlock_at <= ?").all(cutoff) as { account_id: string }[];
    let n = 0;
    for (const { account_id } of accounts) {
      const b = db.prepare("SELECT starter_mc, starter_expires_at, earned_mc, held_mc FROM balances WHERE account_id = ?").get(account_id) as { starter_mc: number; starter_expires_at: number | null; earned_mc: number; held_mc: number };
      const starter = b.starter_expires_at !== null && b.starter_expires_at > now ? b.starter_mc : 0;
      const old = db.prepare("SELECT id, remaining_mc FROM earned_lots WHERE account_id = ? AND status = 'unlocked' AND remaining_mc > 0 AND unlock_at <= ? ORDER BY unlock_at, id").all(account_id, cutoff) as { id: number; remaining_mc: number }[];
      const due = old.reduce((s, l) => s + l.remaining_mc, 0);
      const amount = Math.min(due, b.earned_mc, Math.max(0, starter + b.earned_mc - b.held_mc));
      if (amount <= 0) continue;
      let left = amount;
      for (const l of old) {
        if (left <= 0) break;
        const take = Math.min(left, l.remaining_mc);
        db.prepare("UPDATE earned_lots SET remaining_mc = remaining_mc - ? WHERE id = ?").run(take, l.id);
        left -= take;
      }
      db.prepare("UPDATE balances SET earned_mc = earned_mc - ? WHERE account_id = ?").run(amount, account_id);
      recordEvent(db, signer, { type: "credits_expired", account_id: account_id as Acc, amount_mc: amount, kind: "earned" }, now);
      n++;
    }
    return n;
  })();
}

// ---------- fraud penalties and bans ----------

/** Take back every locked (unvested) lot of the account into the network reserve. Returns mc. */
export function clawBack(db: Db, signer: Signer, accountId: string, evidenceId: string, now = Date.now()): number {
  const sum = (db.prepare("SELECT coalesce(sum(amount_mc), 0) AS s FROM earned_lots WHERE account_id = ? AND status = 'locked'").get(accountId) as { s: number }).s;
  if (sum <= 0) return 0;
  db.prepare("UPDATE earned_lots SET status = 'clawed' WHERE account_id = ? AND status = 'locked'").run(accountId);
  db.prepare("UPDATE balances SET locked_mc = locked_mc - ? WHERE account_id = ?").run(sum, accountId);
  addReserve(db, sum);
  recordEvent(db, signer, { type: "credits_clawed_back", account_id: accountId as Acc, amount_mc: sum, evidence_id: evidenceId }, now);
  return sum;
}

/** Ban the account's World nullifier from running nodes (its nodes leave routing at once). */
export function ban(db: Db, signer: Signer, accountId: string, evidenceId: string, now = Date.now()): boolean {
  const r = db.prepare("UPDATE accounts SET banned_at = ?, ban_evidence = ? WHERE id = ? AND banned_at IS NULL").run(now, evidenceId, accountId);
  db.prepare("UPDATE nodes SET banned = 1 WHERE account_id = ?").run(accountId);
  if (r.changes === 1) recordEvent(db, signer, { type: "account_banned", account_id: accountId as Acc, evidence_id: evidenceId }, now);
  return r.changes === 1;
}

export const isBanned = (db: Db, accountId: string): boolean =>
  !!(db.prepare("SELECT banned_at FROM accounts WHERE id = ?").get(accountId) as { banned_at: number | null } | undefined)?.banned_at;

/**
 * Act on final fraud verdicts (16.2 `verification_jobs.verdict = 'final_flag'`, after the appeal
 * window). Blame only route nodes with a group-test risk ≥ penalty_min_risk (a one-node route is
 * blamed directly). Their owners lose locked credits and are banned. No evidence → no penalty.
 */
export function runPenalties(db: Db, cfg: RamxConfig, signer: Signer, now = Date.now()): number {
  const hasJobs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'verification_jobs'").get();
  if (!hasJobs) return 0;
  const jobs = db.prepare(`SELECT id, route FROM verification_jobs WHERE verdict = 'final_flag'
    AND id NOT IN (SELECT verification_id FROM penalties) ORDER BY id`).all() as { id: string; route: string }[];
  for (const job of jobs) {
    db.transaction(() => {
      const ids = [...new Set((JSON.parse(job.route) as { node_id: string }[]).map((h) => h.node_id))];
      const risk = (id: string) => {
        const r = db.prepare("SELECT alpha, beta FROM verification_node_risk WHERE node_id = ?").get(id) as { alpha: number; beta: number } | undefined;
        return r ? r.alpha / (r.alpha + r.beta) : 0;
      };
      const blamed = ids.length === 1 ? ids : ids.filter((id) => risk(id) >= cfg.incentives.penalty_min_risk);
      const owners = [...new Set(blamed.map((id) => (db.prepare("SELECT account_id FROM nodes WHERE node_id = ?").get(id) as { account_id: string } | undefined)?.account_id).filter((x): x is string => !!x))];
      let clawed = 0;
      for (const acc of owners) {
        clawed += clawBack(db, signer, acc, job.id, now);
        ban(db, signer, acc, job.id, now);
      }
      db.prepare("INSERT INTO penalties (verification_id, nodes, accounts, clawed_mc, ts) VALUES (?, ?, ?, ?, ?)").run(job.id, JSON.stringify(blamed), JSON.stringify(owners), clawed, now);
      console.warn(JSON.stringify({ msg: "fraud_penalty", verification_id: job.id, blamed, accounts: owners, clawed_mc: clawed }));
    })();
  }
  return jobs.length;
}

// ---------- reputation-based node cap ----------

/**
 * Start: max_nodes_per_account (MVP). Proven (node_cap_proven): account older than
 * proven_after_days, a proven credential (Orb / Passport), every own node reliability ≥
 * proven_min_reliability and ≥ proven_min_requests successful requests in the window. Banned: 0.
 */
export function nodeCap(db: Db, cfg: Config, accountId: string, now = Date.now()): number {
  const a = db.prepare("SELECT created_at, credential, banned_at FROM accounts WHERE id = ?").get(accountId) as { created_at: number; credential: Credential | null; banned_at: number | null } | undefined;
  if (!a) return 0;
  if (a.banned_at) return 0;
  const inc = cfg.net.incentives;
  const start = cfg.net.max_nodes_per_account;
  if (now - a.created_at < inc.proven_after_days * 86_400_000 || !a.credential || !inc.proven_credentials.includes(a.credential)) return start;
  const n = db.prepare(`SELECT count(*) AS nodes, min(coalesce(r.score, ?)) AS min_score, coalesce(sum(r.requests_ok), 0) AS ok
    FROM nodes n LEFT JOIN node_reliability r ON r.node_id = n.node_id WHERE n.account_id = ?`).get(cfg.net.reliability.initial_score, accountId) as { nodes: number; min_score: number | null; ok: number };
  if (n.nodes === 0 || (n.min_score ?? 0) < inc.proven_min_reliability || n.ok < inc.proven_min_requests) return start;
  return Math.max(start, inc.node_cap_proven);
}

// ---------- collusion flags (flag only) ----------

/**
 * Credit flows requester → node owner over the window, from settled credit requests:
 * - dominant_requester: one requester gave more than max_pair_share of an owner's earnings;
 * - mutual_flow: A paid B's nodes and B paid A's nodes (both ≥ min_pair_mc);
 * - twin_accounts: two accounts created within twin_window_s that only trade with each other.
 * Flags only: penalties need a final verification verdict.
 */
export function collusionFlags(db: Db, cfg: RamxConfig, now = Date.now()): CollusionFlagsResponse {
  const c = cfg.incentives.collusion;
  const rows = db.prepare(`SELECT account_id, split FROM requests WHERE pay_type = 'credits' AND status = 'ok' AND split IS NOT NULL AND ts >= ?`).all(now - c.window_days * 86_400_000) as { account_id: string; split: string }[];
  const flow = new Map<string, number>(); // "req|owner" → mc
  const ownerTotal = new Map<string, number>();
  const partners = new Map<string, Set<string>>();
  const owner = db.prepare("SELECT account_id FROM nodes WHERE node_id = ?");
  for (const r of rows) {
    for (const [nodeId, mc] of Object.entries((JSON.parse(r.split) as CreditSplit).nodes)) {
      const o = (owner.get(nodeId) as { account_id: string } | undefined)?.account_id;
      if (!o || mc <= 0 || o === r.account_id) continue;
      flow.set(`${r.account_id}|${o}`, (flow.get(`${r.account_id}|${o}`) ?? 0) + mc);
      ownerTotal.set(o, (ownerTotal.get(o) ?? 0) + mc);
      for (const [x, y] of [[r.account_id, o], [o, r.account_id]] as const) {
        if (!partners.has(x)) partners.set(x, new Set());
        partners.get(x)!.add(y);
      }
    }
  }
  const flags: CollusionFlagsResponse["flags"] = [];
  const seen = new Set<string>();
  for (const [key, mc] of flow) {
    const [req, own] = key.split("|") as [string, string];
    const total = ownerTotal.get(own)!;
    if (mc >= c.min_pair_mc && mc / total > c.max_pair_share) {
      flags.push({ kind: "dominant_requester", accounts: [req, own] as Acc[], amount_mc: mc, detail: `${req} paid ${Math.round((mc / total) * 100)}% of ${own}'s earnings (${mc} of ${total} mc)` });
    }
    const back = flow.get(`${own}|${req}`) ?? 0;
    const pair = [req, own].sort().join("|");
    if (mc >= c.min_pair_mc && back >= c.min_pair_mc && !seen.has(`m|${pair}`)) {
      seen.add(`m|${pair}`);
      flags.push({ kind: "mutual_flow", accounts: [req, own] as Acc[], amount_mc: mc + back, detail: `${req}→${own} ${mc} mc, ${own}→${req} ${back} mc` });
    }
    const created = (id: string) => (db.prepare("SELECT created_at FROM accounts WHERE id = ?").get(id) as { created_at: number }).created_at;
    const only = (a: string, b: string) => [...(partners.get(a) ?? [])].every((p) => p === b);
    if (!seen.has(`t|${pair}`) && Math.abs(created(req) - created(own)) <= c.twin_window_s * 1000 && only(req, own) && only(own, req)) {
      seen.add(`t|${pair}`);
      flags.push({ kind: "twin_accounts", accounts: [req, own] as Acc[], amount_mc: mc + back, detail: `created ${Math.round(Math.abs(created(req) - created(own)) / 1000)} s apart; trade only with each other` });
    }
  }
  return { window_days: c.window_days, flags };
}

// ---------- availability rewards ----------

/** A request waited `waitMs` for a slot in `poolId` (billing calls this; local SQLite only). */
export function recordPoolWait(db: Db, poolId: string, waitMs: number, now = Date.now()): void {
  if (waitMs > 0) db.prepare("INSERT INTO pool_waits (pool_id, ts, wait_ms) VALUES (?, ?, ?)").run(poolId, now, Math.round(waitMs));
}

/**
 * Pay the last full epoch once: in pools where a request waited ≥ min_wait_ms, every node that was
 * online gets reward_mc_per_min × online minutes (heartbeat slots), from the network reserve,
 * capped at min(max_per_epoch_mc, reserve) (scaled down evenly). Credits vest like any earnings.
 */
export function payAvailability(db: Db, cfg: Config, signer: Signer, now = Date.now()): number {
  const a = cfg.net.incentives.availability;
  const E = a.epoch_s * 1000;
  const start = Math.floor(now / E) * E - E;
  const end = start + E;
  if (db.prepare("SELECT 1 FROM availability_epochs WHERE epoch_start = ?").get(start)) return 0;
  return db.transaction(() => {
    const pools = (db.prepare("SELECT DISTINCT pool_id FROM pool_waits WHERE ts >= ? AND ts < ? AND wait_ms >= ?").all(start, end, a.min_wait_ms) as { pool_id: string }[]).map((p) => p.pool_id);
    const slotMin = cfg.env.HEARTBEAT_SECONDS / 60;
    const due: { node_id: string; account_id: string; mc: number }[] = [];
    for (const pool of pools) {
      const nodes = db.prepare(`SELECT n.node_id, n.account_id, count(h.slot_ts) AS slots FROM nodes n
        JOIN node_heartbeats h ON h.node_id = n.node_id AND h.slot_ts >= ? AND h.slot_ts < ?
        JOIN accounts acc ON acc.id = n.account_id
        WHERE n.pool_id = ? AND n.banned = 0 AND acc.banned_at IS NULL GROUP BY n.node_id`).all(start, end, pool) as { node_id: string; account_id: string; slots: number }[];
      for (const n of nodes) due.push({ node_id: n.node_id, account_id: n.account_id, mc: Math.floor(a.reward_mc_per_min * n.slots * slotMin) });
    }
    const total = due.reduce((s, d) => s + d.mc, 0);
    const cap = Math.min(a.max_per_epoch_mc, reserveMc(db));
    const scale = total > cap ? cap / total : 1;
    let paid = 0;
    for (const d of due) {
      const mc = Math.floor(d.mc * scale);
      if (mc <= 0) continue;
      takeReserve(db, mc);
      creditEarned(db, cfg.net, d.account_id, mc, "availability", String(start), now);
      recordEvent(db, signer, { type: "availability_reward", account_id: d.account_id as Acc, node_id: d.node_id as `0x${string}`, amount_mc: mc, epoch_start: start }, now);
      paid += mc;
    }
    db.prepare("INSERT INTO availability_epochs (epoch_start, paid_mc, ts) VALUES (?, ?, ?)").run(start, paid, now);
    db.prepare("DELETE FROM pool_waits WHERE ts < ?").run(start - E);
    return paid;
  })();
}

// ---------- human-backed agent keys (World Agent Pass, MVP form) ----------

const hashSecret = (s: string) => createHash("sha256").update(s).digest("hex");
type AgentRow = { id: string; account_id: string; name: string; secret_hash: string; budget_mc: number | null; spent_mc: number; key_credits_mc: number; key_held_mc: number; bought_total_mc: number; key_spent_mc: number; created_at: number; revoked_at: number | null; last_used_at?: number | null };
const toKey = (r: AgentRow): AgentKey => ({ agent_id: r.id, name: r.name, budget_mc: r.budget_mc, spent_mc: r.spent_mc, revoked: r.revoked_at !== null, created_at: r.created_at, last_used_at: r.last_used_at ?? null,
  key_credits_mc: r.key_credits_mc - r.key_held_mc, bought_total_mc: r.bought_total_mc });
const KEY_ROWS = "SELECT k.*, (SELECT max(ts) FROM requests r WHERE r.agent_id = k.id) AS last_used_at FROM agent_keys k";

/** A World-verified human creates an API key, with an optional credit cap (null = whole balance). The token is returned once. */
export function createAgentKey(db: Db, signer: Signer, accountId: string, name: string, budgetMc: number | null, now = Date.now()): AgentKey & { token: string } {
  const id = `agt_${randomBytes(8).toString("hex")}`;
  const secret = randomBytes(32).toString("hex");
  db.transaction(() => {
    db.prepare("INSERT INTO agent_keys (id, account_id, name, secret_hash, budget_mc, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, accountId, name, hashSecret(secret), budgetMc, now);
    recordEvent(db, signer, { type: "agent_key_created", account_id: accountId as Acc, agent_id: id, budget_mc: budgetMc }, now);
  })();
  return { ...toKey(db.prepare(`${KEY_ROWS} WHERE k.id = ?`).get(id) as AgentRow), token: `gpa_${id}_${secret}` };
}

export const listAgentKeys = (db: Db, accountId: string): AgentKey[] =>
  (db.prepare(`${KEY_ROWS} WHERE k.account_id = ? ORDER BY k.created_at`).all(accountId) as AgentRow[]).map(toKey);

/** The key's latest requests (newest first), or null when the key is not this account's. */
export function agentRequests(db: Db, accountId: string, agentId: string, limit = 50): AgentRequest[] | null {
  if (!db.prepare("SELECT 1 FROM agent_keys WHERE id = ? AND account_id = ?").get(agentId, accountId)) return null;
  return db.prepare("SELECT req_id, model, status, in_tokens, out_tokens, max_tokens, cost_mc, ledger_seq, ts FROM requests WHERE agent_id = ? AND account_id = ? ORDER BY ts DESC LIMIT ?")
    .all(agentId, accountId, limit) as AgentRequest[];
}

export function revokeAgentKey(db: Db, accountId: string, agentId: string, now = Date.now()): boolean {
  return db.prepare("UPDATE agent_keys SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL").run(now, agentId, accountId).changes === 1;
}

/** Bearer `gpa_<agent_id>_<secret>` → the human account + agent, or null (unknown / revoked / wrong). */
export function agentFromToken(db: Db, token: string): { accountId: string; agentId: string } | null {
  const m = /^gpa_(agt_[A-Za-z0-9]+)_([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const r = db.prepare("SELECT * FROM agent_keys WHERE id = ?").get(m[1]) as AgentRow | undefined;
  if (!r || r.revoked_at !== null) return null;
  const a = Buffer.from(r.secret_hash, "hex"), b = Buffer.from(hashSecret(m[2]!), "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? { accountId: r.account_id, agentId: r.id } : null;
}

/** Account credits the key may still spend; no cap = Infinity. The cap never limits the key's own bought credits. */
export const agentBudgetLeft = (db: Db, agentId: string): number => {
  const r = db.prepare("SELECT budget_mc, spent_mc, key_spent_mc FROM agent_keys WHERE id = ?").get(agentId) as { budget_mc: number | null; spent_mc: number; key_spent_mc: number };
  return r.budget_mc === null ? Infinity : Math.max(0, r.budget_mc - (r.spent_mc - r.key_spent_mc));
};

/** GET /v1/credits: what a key can spend now. */
export function keyCredits(db: Db, cfg: RamxConfig, agentId: string, now = Date.now()): KeyCreditsResponse {
  const r = db.prepare("SELECT * FROM agent_keys WHERE id = ?").get(agentId) as AgentRow;
  const account = Math.max(0, availableMc(db, r.account_id, now));
  const capLeft = agentBudgetLeft(db, agentId);
  const keyCredits = r.key_credits_mc - r.key_held_mc;
  return {
    agent_id: r.id, name: r.name, key_credits_mc: keyCredits, bought_total_mc: r.bought_total_mc,
    account_available_mc: account, cap_mc: r.budget_mc, cap_left_mc: capLeft === Infinity ? null : capLeft,
    spendable_mc: keyCredits + Math.min(account, capLeft), spent_mc: r.spent_mc, topup: cfg.topup,
  };
}

/** Millicredits for a top-up: units × credits_per_usdc × 1000 / 10^decimals, rounded down. */
export const topupMc = (cfg: RamxConfig, units: bigint): number => Number((units * BigInt(cfg.topup.credits_per_usdc) * 1000n) / 10n ** BigInt(cfg.x402_near.decimals));

/**
 * Credit a settled x402 top-up to the key, once per NEAR transaction. false = this tx was
 * already credited (replay). The USDC stays in the treasury; it is not epoch payout income.
 */
export function creditTopup(db: Db, cfg: RamxConfig, signer: Signer, t: { agentId: string; payer: string; tx: string; units: string }, now = Date.now()): { added: number } | null {
  return db.transaction(() => {
    const k = db.prepare("SELECT account_id FROM agent_keys WHERE id = ?").get(t.agentId) as { account_id: string };
    const mc = topupMc(cfg, BigInt(t.units));
    const ins = db.prepare("INSERT OR IGNORE INTO key_topups (tx_id, agent_id, account_id, payer, amount_units, amount_mc, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(t.tx, t.agentId, k.account_id, t.payer, t.units, mc, now);
    if (ins.changes !== 1) return null;
    db.prepare("UPDATE agent_keys SET key_credits_mc = key_credits_mc + ?, bought_total_mc = bought_total_mc + ? WHERE id = ?").run(mc, mc, t.agentId);
    recordEvent(db, signer, { type: "credits_purchased", account_id: k.account_id as Acc, agent_id: t.agentId, payer: t.payer, tx_id: t.tx, amount_units: t.units, amount_mc: mc }, now);
    return { added: mc };
  })();
}

export function chargeAgent(db: Db, agentId: string, reqId: string, mc: number): void {
  db.prepare("UPDATE agent_keys SET spent_mc = spent_mc + ? WHERE id = ?").run(mc, agentId);
  db.prepare("UPDATE requests SET agent_id = ? WHERE req_id = ?").run(agentId, reqId);
}

/** GET /me incentives block. */
export function incentivesFor(db: Db, cfg: Config, accountId: string, now = Date.now()) {
  const b = db.prepare("SELECT locked_mc FROM balances WHERE account_id = ?").get(accountId) as { locked_mc: number };
  const next = db.prepare("SELECT min(unlock_at) AS t FROM earned_lots WHERE account_id = ? AND status = 'locked'").get(accountId) as { t: number | null };
  const a = db.prepare("SELECT credential, banned_at FROM accounts WHERE id = ?").get(accountId) as { credential: Credential | null; banned_at: number | null };
  return { locked_mc: b.locked_mc, next_unlock_at: next.t, credential: a.credential, node_cap: nodeCap(db, cfg, accountId, now), banned: a.banned_at !== null };
}
