import { canonicalJson, MerkleLeaf, PayoutRoute, type PayoutsResponse } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { recordEvent, signEvent, type Signer, type UnsignedEvent } from "./events.ts";
import { payoutTree, ZERO_ROOT, type Hash } from "./merkle.ts";
import { validLayerMap } from "./route.ts";

/**
 * x402 epoch settlement on NEAR (SPEC §10.5). Every EPOCH_SECONDS:
 *  1. close: freeze the epoch's paid requests → 80% provider shares by layers → Merkle tree →
 *     signed `epoch_closed` event (with the payout list) into the ledger queue;
 *  2. post: once that event is final on the NEAR ledger contract, the settler sends the epoch total
 *     of USDC to the payout contract with `ft_transfer_call(msg = {epoch, root})` (funds + posts
 *     in one transaction). The contract refuses a second post of an epoch and the token contract
 *     then refunds the transfer, so a retry after a crash can never pay twice;
 *  3. index: read which providers claimed (one view call per epoch) → `payout_claimed` events.
 */

export type EpochState = {
  root: Hash;
  total: bigint;
  claimed: bigint;
  /** ms: claims open (post time + claim delay). */
  opensAt: number;
  swept: boolean;
};
export type SettlementChain = {
  /** Check the contract's settler and token match this gateway's configuration. */
  verify(): Promise<void>;
  /** null = not posted. */
  epoch(epoch: number): Promise<EpochState | null>;
  /** Fund and post one epoch. Throws (with the contract's message) when the post is refused. */
  post(epoch: number, root: Hash, total: bigint): Promise<{ tx: string }>;
  /** For each account: has it claimed `epoch`? */
  claimed(epoch: number, accounts: string[]): Promise<boolean[]>;
};
export type PaidRequest = { req_id: string; model: string; status: string; x402_payer: string | null; x402_tx: string | null; x402_amount: string | null; payout_snapshot: string | null };

/** BigInt only: 80% providers, per-request layer floors; missing/self shares and dust stay in the treasury. */
export function providerPayouts(cfg: Config, requests: PaidRequest[]): MerkleLeaf[] {
  const amounts = new Map<string, bigint>();
  for (const r of requests) {
    if (r.status !== "ok" || !r.payout_snapshot) continue;
    const snapshot = PayoutRoute.parse(JSON.parse(r.payout_snapshot));
    const model = cfg.model(r.model);
    if (!model || !validLayerMap(snapshot, model.num_layers)) throw new Error(`invalid payout layer map for ${r.req_id}`);
    if (!r.x402_amount || !/^\d+$/.test(r.x402_amount)) throw new Error(`missing x402 amount for ${r.req_id}`);
    if (!r.x402_payer) throw new Error(`payer unknown for ${r.req_id}`);
    const share = BigInt(r.x402_amount) * BigInt(cfg.net.x402_split_bps.providers) / 10_000n;
    for (const hop of snapshot) {
      const account = hop.payout_address;
      // Self-request rule: a provider paying for its own request earns nothing from it.
      if (!account || account === r.x402_payer) continue;
      const amount = share * BigInt(hop.layers[1] - hop.layers[0]) / BigInt(model.num_layers);
      amounts.set(account, (amounts.get(account) ?? 0n) + amount);
    }
  }
  return [...amounts].filter(([, n]) => n > 0n).map(([payout_address, n]) => ({ payout_address, amount_units: n.toString() }));
}

type EpochRow = { epoch: number; total_units: string; merkle_root: Hash; status: string; ledger_event_id: number; post_tx: string | null };

/** One worker owns the settler account. Closed epoch snapshots survive restarts. */
export function createSettlement(db: Db, cfg: Config, signer: Signer, chain: SettlementChain) {
  const duration = (cfg.env.EPOCH_SECONDS ?? 600) * 1000;
  let running = false;

  async function closeDue(now: number) {
    const boundary = Math.floor(now / duration) * duration;
    const due = db.prepare(`SELECT DISTINCT CAST(ts / ? AS INTEGER) AS epoch FROM requests
      WHERE pay_type = 'x402' AND ts < ? ORDER BY epoch`).all(duration, boundary) as { epoch: number }[];
    for (const { epoch } of due) {
      if (db.prepare("SELECT 1 FROM epochs WHERE epoch = ?").get(epoch)) continue;
      const start = epoch * duration;
      const rows = db.prepare(`SELECT * FROM requests WHERE pay_type = 'x402' AND ts >= ? AND ts < ? ORDER BY ts, req_id`).all(start, start + duration) as PaidRequest[];
      if (rows.some((r) => r.status === "pending")) continue;
      // An on-chain payment can fund providers once, even if a payment header is replayed.
      const unique = rows.filter((r) => r.x402_tx && (db.prepare(`SELECT req_id FROM requests WHERE pay_type = 'x402' AND x402_tx = ? ORDER BY ts, req_id LIMIT 1`).get(r.x402_tx) as { req_id: string }).req_id === r.req_id);
      const tree = payoutTree(epoch, providerPayouts(cfg, unique));
      const total = tree.payouts.reduce((sum, p) => sum + BigInt(p.amount_units), 0n).toString();
      let event: UnsignedEvent = { type: "epoch_closed", epoch, start_ts: start, end_ts: start + duration,
        total_units: total, merkle_root: tree.root, payouts_hash: tree.hash, payouts: tree.payouts };
      if (Buffer.byteLength(canonicalJson(signEvent(signer, event, now))) >= 4096) event = { ...event, payouts: null }; // ledger contract limit
      db.transaction(() => {
        recordEvent(db, signer, event, now);
        const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
        db.prepare(`INSERT INTO epochs (epoch, start_ts, end_ts, total_units, merkle_root, status, ledger_event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(epoch, start, start + duration, total, tree.root, tree.payouts.length ? "closed" : "empty", id);
        for (const p of tree.proofs) db.prepare(`INSERT INTO epoch_payouts (epoch, payout_address, amount_units, proof)
          VALUES (?, ?, ?, ?)`).run(epoch, p.payout_address, p.amount_units, JSON.stringify(p.proof));
      })();
    }
  }

  const markPosted = (epoch: number, state: EpochState) =>
    db.prepare("UPDATE epochs SET status = ?, claimable_at = ? WHERE epoch = ?").run(state.swept ? "swept" : "posted", state.opensAt, epoch);

  async function postDue() {
    const rows = db.prepare("SELECT * FROM epochs WHERE status IN ('closed', 'posting') ORDER BY epoch").all() as EpochRow[];
    for (const r of rows) {
      const ledger = db.prepare("SELECT ledger_seq FROM ledger_events WHERE id = ?").get(r.ledger_event_id) as { ledger_seq: number | null };
      if (ledger.ledger_seq === null) return; // the audit commitment must be final on the ledger contract before any payout
      const total = BigInt(r.total_units);
      let state = await chain.epoch(r.epoch);
      if (!state) {
        try {
          const { tx } = await chain.post(r.epoch, r.merkle_root, total);
          db.prepare("UPDATE epochs SET status = 'posting', post_tx = ? WHERE epoch = ?").run(tx, r.epoch);
          state = await chain.epoch(r.epoch);
        } catch (e) {
          // The post may have landed although we got an error (lost response, or a second post refused and
          // refunded by the contract): the contract state decides. Nothing landed → retry next tick.
          state = await chain.epoch(r.epoch);
          if (!state) throw e;
        }
        if (!state) throw new Error(`epoch ${r.epoch}: post did not land on the payout contract; retried next tick`);
      }
      if (state.root !== r.merkle_root || state.total !== total) throw new Error(`epoch ${r.epoch} conflicts with the payout contract (root ${state.root}, total ${state.total}); review before reconciliation`);
      markPosted(r.epoch, state);
    }
  }

  async function syncClaims() {
    const epochs = db.prepare(`SELECT DISTINCT e.epoch FROM epochs e JOIN epoch_payouts p ON p.epoch = e.epoch
      WHERE e.status = 'posted' AND p.claimed = 0 ORDER BY e.epoch`).all() as { epoch: number }[];
    for (const { epoch } of epochs) {
      const state = await chain.epoch(epoch);
      const open = db.prepare("SELECT payout_address, amount_units FROM epoch_payouts WHERE epoch = ? AND claimed = 0 ORDER BY payout_address").all(epoch) as { payout_address: string; amount_units: string }[];
      const flags = await chain.claimed(epoch, open.map((p) => p.payout_address));
      db.transaction(() => {
        open.forEach((p, i) => {
          if (!flags[i]) return;
          db.prepare("UPDATE epoch_payouts SET claimed = 1 WHERE epoch = ? AND payout_address = ?").run(epoch, p.payout_address);
          recordEvent(db, signer, { type: "payout_claimed", epoch, payout_address: p.payout_address, amount_units: p.amount_units, claim_tx: null });
        });
        if (state?.swept) db.prepare("UPDATE epochs SET status = 'swept' WHERE epoch = ?").run(epoch);
      })();
    }
  }

  return {
    closeDue,
    async runOnce(now = Date.now()) {
      if (running) return;
      running = true;
      try { await chain.verify(); await closeDue(now); await postDue(); await syncClaims(); }
      finally { running = false; }
    },
  };
}

/** Only contract-confirmed epochs are exposed. Ledger or posting delays never produce a claimable proof. */
export function payoutsFor(db: Db, account: string, now = Date.now()): PayoutsResponse {
  const rows = db.prepare(`SELECT p.*, e.merkle_root, e.post_tx, e.claimable_at, e.status FROM epoch_payouts p
    JOIN epochs e ON e.epoch = p.epoch WHERE p.payout_address = ? AND e.status IN ('posted', 'swept') ORDER BY p.epoch DESC`).all(account) as {
    epoch: number; amount_units: string; merkle_root: Hash; proof: string; claimed: number; claim_tx: string | null; post_tx: string | null; claimable_at: number; status: string;
  }[];
  return { payout_address: account, payouts: rows.map((r) => ({ epoch: r.epoch, amount_units: r.amount_units,
    merkle_root: r.merkle_root, proof: JSON.parse(r.proof), claimed: !!r.claimed, claim_tx: r.claim_tx, post_tx: r.post_tx,
    claimable_at: r.claimable_at, claimable: !r.claimed && r.status === "posted" && now >= r.claimable_at, swept: r.status === "swept" })) };
}

export function startSettlementWorker(settlement: ReturnType<typeof createSettlement>, intervalMs = 10_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try { await settlement.runOnce(); }
    catch (e) { console.error(`epoch settlement failed: ${(e as Error).message}`); }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 0);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

export { ZERO_ROOT };
