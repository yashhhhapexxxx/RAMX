import type { Db } from "./db.ts";
import { assertSuccess, nearAccount, nearProvider, returnValue, TGAS, txHashOf } from "./near.ts";

/**
 * NEAR ledger writer (replaces the ledger writer, SPEC §10.2). Events are first inserted into
 * `ledger_events` with ledger_seq NULL (events.ts, inside the money transaction). This loop appends
 * them to the `ledger` contract in id order, a batch per transaction. The sequence number on the
 * contract IS the event id: the contract accepts a batch only when `first_seq == seq() + 1`, so a
 * retry after a lost response is refused instead of publishing an event twice, and the gateway
 * reconciles from `seq()`. Restart-safe. The user request never waits for this (CLAUDE.md §4.9).
 */

export type LedgerChain = {
  /** Append `events` (signed canonical JSON) as sequence numbers first_seq… Returns the NEAR tx hash. */
  append(firstSeq: number, events: string[]): Promise<{ tx: string }>;
  /** Last sequence number on the contract (0 = none). */
  seq(): Promise<number>;
};

/** Events per transaction. The contract allows 50; 20 keeps one call far below the gas limit. */
export const BATCH = 20;

export function nearLedgerChain(o: { contractId: string; writerId: string; writerKey: string; rpcUrl?: string }): LedgerChain {
  const account = nearAccount(o.writerId, o.writerKey, o.rpcUrl);
  const provider = nearProvider(o.rpcUrl);
  return {
    async append(firstSeq, events) {
      const outcome = await account.callFunctionRaw({ contractId: o.contractId, methodName: "append_batch", args: { first_seq: firstSeq, events }, gas: 100n * TGAS });
      assertSuccess(outcome, "ledger append_batch");
      const last = returnValue<number>(outcome);
      if (last !== firstSeq + events.length - 1) throw new Error(`ledger returned seq ${last}, expected ${firstSeq + events.length - 1}`);
      return { tx: txHashOf(outcome) };
    },
    async seq() {
      return Number(await provider.callFunction(o.contractId, "seq", {}));
    },
  };
}

type Row = { id: number; type: string; payload: string };

/** Mark rows as final on the chain; for request_settled / x402_payment the receipt shows it too. */
function markFinal(db: Db, rows: Row[], tx: string | null): void {
  const setEvent = db.prepare("UPDATE ledger_events SET ledger_seq = ?, ledger_tx = ? WHERE id = ?");
  const setRequest = db.prepare("UPDATE requests SET ledger_seq = ?, ledger_tx = ? WHERE req_id = ?");
  db.transaction(() => {
    for (const r of rows) {
      setEvent.run(r.id, tx, r.id);
      if (r.type === "request_settled" || r.type === "x402_payment") {
        const reqId = (JSON.parse(r.payload) as { req_id?: string }).req_id;
        if (reqId) setRequest.run(r.id, tx, reqId);
      }
    }
  })();
}

/**
 * Append the next batch of unsent events (contiguous ids, in order). Returns how many became final.
 * Throws on a network or contract error; the caller backs off and retries the same rows.
 */
export async function flushOnce(db: Db, chain: LedgerChain, max = BATCH): Promise<number> {
  const all = db.prepare("SELECT id, type, payload FROM ledger_events WHERE ledger_seq IS NULL ORDER BY id LIMIT ?").all(max) as Row[];
  if (all.length === 0) return 0;
  const rows = all.filter((r, i) => r.id === all[0]!.id + i); // contiguous run only
  try {
    const { tx } = await chain.append(rows[0]!.id, rows.map((r) => r.payload));
    markFinal(db, rows, tx);
    return rows.length;
  } catch (e) {
    const m = /expected first_seq (\d+)/.exec((e as Error).message);
    if (!m) throw e;
    const next = Number(m[1]);
    if (next > rows[0]!.id && next - 1 <= rows.at(-1)!.id) {
      // An earlier attempt landed but its response was lost: these events are on the chain already.
      const landed = rows.filter((r) => r.id < next);
      markFinal(db, landed, null);
      return landed.length;
    }
    throw new Error(`ledger contract expects event ${next}, the gateway's next unsent event is ${rows[0]!.id}: the database and the contract do not match (deploy a fresh ledger contract after a database reset)`);
  }
}

/** Run flushOnce every `intervalMs` (sooner while a backlog remains); after a failure wait up to 30 s (doubling). Returns stop(). */
export function startLedgerWriter(db: Db, chain: LedgerChain, intervalMs = 1000): () => void {
  let stopped = false;
  let delay = intervalMs;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    let next = intervalMs;
    try {
      const n = await flushOnce(db, chain);
      if (n > 0) console.log(JSON.stringify({ msg: "ledger_written", count: n }));
      delay = intervalMs;
      if (n === BATCH) next = 0; // more waiting: go on at once
    } catch (e) {
      delay = Math.min(delay * 2, 30_000);
      next = delay;
      console.error(`ledger: append failed, retry in ${delay} ms: ${(e as Error).message}`);
    }
    if (!stopped) timer = setTimeout(tick, next);
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
