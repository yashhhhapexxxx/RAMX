import { incentivesFor } from "./incentives.ts";
import { randomBytes } from "node:crypto";
import type { MeResponse } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { refreshReliability } from "./reliability.ts";
import { recordEvent, type Signer } from "./events.ts";

export const newAccountId = (): string => `acc_${randomBytes(10).toString("hex")}`;

/** Contribution ratio uses a one-credit denominator floor; all stored amounts are millicredits. */
export const contributionRatio = (earnedMc: number, spentMc: number): number => earnedMc / Math.max(spentMc, 1000);

export type LoginResult = { accountId: string; newAccount: boolean; starterGrantedMc: number };

/**
 * One account per World nullifier (SPEC §6.2–6.3). New nullifier → account + starter credits
 * (STARTER_CREDITS credits → mc, expiry STARTER_EXPIRY_DAYS) + account_created + starter_grant
 * events, all in one transaction. Existing nullifier → the same account, no credits.
 * The UNIQUE constraint on world_nullifier makes a race between two logins safe.
 */
export function loginOrCreate(db: Db, cfg: Config, signer: Signer, nullifier: string, now = Date.now()): LoginResult {
  return db.transaction((): LoginResult => {
    const existing = db.prepare("SELECT id FROM accounts WHERE world_nullifier = ?").get(nullifier) as { id: string } | undefined;
    if (existing) return { accountId: existing.id, newAccount: false, starterGrantedMc: 0 };
    const id = newAccountId();
    const amount = (cfg.env.STARTER_CREDITS ?? 10_000) * 1000;
    const expires = now + (cfg.env.STARTER_EXPIRY_DAYS ?? 14) * 86_400_000;
    db.prepare("INSERT INTO accounts (id, world_nullifier, payout_address, created_at) VALUES (?, ?, NULL, ?)").run(id, nullifier, now);
    db.prepare("INSERT INTO balances (account_id, starter_mc, starter_expires_at) VALUES (?, ?, ?)").run(id, amount, expires);
    recordEvent(db, signer, { type: "account_created", account_id: id as `acc_${string}` }, now);
    recordEvent(db, signer, { type: "starter_grant", account_id: id as `acc_${string}`, amount_mc: amount, expires_at: expires }, now);
    return { accountId: id, newAccount: true, starterGrantedMc: amount };
  })();
}

/** GET /me body (shared MeResponse). */
export function me(db: Db, cfg: Config, accountId: string, now = Date.now()): MeResponse | null {
  const a = db.prepare("SELECT id, payout_address FROM accounts WHERE id = ?").get(accountId) as { id: string; payout_address: string | null } | undefined;
  if (!a) return null;
  const b = db.prepare("SELECT starter_mc, starter_expires_at, bought_mc, earned_mc, held_mc, earned_total_mc, spent_total_mc FROM balances WHERE account_id = ?").get(accountId) as MeResponse["balance"];
  const owned = db.prepare("SELECT node_id FROM nodes WHERE account_id = ?").all(accountId) as { node_id: string }[];
  for (const n of owned) refreshReliability(db, cfg, n.node_id, now);
  const fresh = now - cfg.net.router.pool_heartbeat_max_age_s * 1000;
  const nodes = db
    .prepare(
      `SELECT n.node_id, n.pool_id, n.gpu, n.mem_gb, n.hb_ts, n.hb_online, r.score FROM nodes n
       LEFT JOIN node_reliability r ON r.node_id = n.node_id WHERE n.account_id = ? ORDER BY n.registered_at`,
    )
    .all(accountId) as { node_id: string; pool_id: string; gpu: string; mem_gb: number; hb_ts: number | null; hb_online: number | null; score: number | null }[];
  return {
    account_id: a.id as MeResponse["account_id"],
    payout_address: a.payout_address as MeResponse["payout_address"],
    balance: b,
    // SPEC §8.2: earned_total / max(spent_total, 1 credit). Both in mc, so the floor is 1000 mc.
    ratio: contributionRatio(b.earned_total_mc, b.spent_total_mc),
    incentives: incentivesFor(db, cfg, accountId, now),
    nodes: nodes.map((n) => ({
      node_id: n.node_id as `0x${string}`,
      pool_id: n.pool_id,
      gpu: n.gpu,
      mem_gb: n.mem_gb,
      reliability: n.score ?? cfg.net.reliability.initial_score,
      online: n.hb_online === 1 && (n.hb_ts ?? 0) >= fresh,
    })),
  };
}
