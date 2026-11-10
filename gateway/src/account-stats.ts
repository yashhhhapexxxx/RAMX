import { AccountStats } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { contributionRatio } from "./accounts.ts";
import { refreshReliability } from "./reliability.ts";

/** Lifetime contribution totals for GET /network; never select or expose the identity nullifier or private account fields. */
export function accountStatsSnapshot(db: Db, cfg: Config, now = Date.now()): AccountStats[] {
  refreshReliability(db, cfg, undefined, now);
  const rows = db.prepare(`SELECT a.id AS account_id, b.earned_total_mc AS earned_mc, b.spent_total_mc AS spent_mc,
    CASE WHEN count(n.node_id) = 0 THEN NULL ELSE min(coalesce(r.score, ?)) END AS reliability
    FROM accounts a JOIN balances b ON b.account_id = a.id
    LEFT JOIN nodes n ON n.account_id = a.id LEFT JOIN node_reliability r ON r.node_id = n.node_id
    GROUP BY a.id ORDER BY a.created_at, a.id`).all(cfg.net.reliability.initial_score) as { account_id: string; earned_mc: number; spent_mc: number; reliability: number | null }[];
  return rows.map((r) => AccountStats.parse({ type: "ramx.account_stats", ...r, ratio: contributionRatio(r.earned_mc, r.spent_mc) }));
}
