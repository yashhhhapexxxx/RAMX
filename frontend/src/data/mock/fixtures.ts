/* Seeded demo data, shaped exactly like the shared v0.1 types. Every id, hash and
   transaction below is synthetic. The story matches the landing page: one pool
   runs Qwen3-14B across Rex (RTX 4060, also the coordinator), Mika (M4) and
   Nova (M5). Requesters pay with credits or with x402; the gateway writes each
   balance change to the NEAR ledger contract; x402 income is paid out in USDC every 10-minute epoch. */
import type {
  AccountStats,
  Epoch,
  HexAddress,
  LedgerEvent,
  LedgerType,
  ModelEntry,
  NodeListing,
  Payout,
  PoolListing,
  Receipt,
  RouteHop,
} from "@shared/types";
import { cost, split, x402Price } from "../../lib/credits";

/* ── deterministic randomness (same LCG as quil's ParticleScene) ───────── */
export function rng(seed: number) {
  let v = seed >>> 0;
  return () => {
    v = (v * 1664525 + 1013904223) >>> 0;
    return v / 4294967296;
  };
}
const r = rng(20261106);
const HEX = "0123456789abcdef";
export const hex = (n: number, g: () => number = r) => Array.from({ length: n }, () => HEX[Math.floor(g() * 16)]).join("");
/** A synthetic NEAR transaction hash (44 base58 characters). */
export const txHash = (g: () => number = r) => hex(44, g).replace(/0/g, "z").replace(/[a-f]/g, (c) => c.toUpperCase());
const addr = () => `0x${hex(40)}` as HexAddress;

/** Anchor every timestamp to page load so the demo always looks "live". */
export const T0 = Date.now();
const MIN = 60_000;
export const EPOCH_MS = 10 * MIN; // §10.5: 10 minutes for the demo
export const LISTING_TTL = 120_000; // §11.2: 120 s, renewed every 30 s
export const LEDGER_CONTRACT = "ledger-v2.ramx.testnet";
export const USDC_UNITS = 1_000_000; // base units per USDC (6 decimals)
export const PROVIDER_SHARE = 0.8; // §10.5: x402 income → 80% providers, 10% reserve, 10% operations

/* ── models (directory ramx.model) ──────────────────────────────────────── */
export const MODELS: ModelEntry[] = [
  {
    model_id: "Qwen/Qwen3-8B",
    mlx_variant: "Qwen/Qwen3-8B-MLX-8bit",
    size_gb: 8.7,
    model_factor: 1.0,
    license: "Apache-2.0",
    params_b: 8,
    total_layers: 36,
  },
  {
    model_id: "Qwen/Qwen3-14B-FP8",
    mlx_variant: "Qwen/Qwen3-14B-MLX-8bit",
    size_gb: 16.0,
    model_factor: 1.75,
    license: "Apache-2.0",
    params_b: 14,
    total_layers: 40,
  },
];
export const POOL_MODEL = "Qwen/Qwen3-14B-FP8";
export const modelById = (id: string) => MODELS.find((m) => m.model_id === id);

/* ── accounts ──────────────────────────────────────────────────────────── */
/** The demo wallet (provider payout address) is Mika's owner, so /payouts has something to claim. */
export const PAYOUT = { rex: addr(), mika: addr(), nova: addr() } as const;
export const DEMO_OWNER: HexAddress = PAYOUT.mika;
export const ACC = { rex: "acc_rex", mika: "acc_mika", nova: "acc_nova" } as const;
/** The account a mock World login creates (or logs back in to). */
export const DEMO_ACCOUNT = "acc_demo";
const requesters = Array.from({ length: 6 }, () => `acc_${hex(6)}`);

/* ── nodes (directory ramx.node) and the pool (ramx.pool) ────────────── */
const nodeSeeds = [
  { nickname: "Rex", gpu: "RTX 4060 Laptop", mem_gb: 8, layers: [0, 11], owner: ACC.rex, success: 0.98, uptime: 0.97 },
  { nickname: "Mika", gpu: "Apple M4", mem_gb: 16, layers: [11, 31], owner: ACC.mika, success: 0.96, uptime: 0.93 },
  { nickname: "Nova", gpu: "Apple M5", mem_gb: 16, layers: [31, 40], owner: ACC.nova, success: 0.94, uptime: 0.9 },
] as const;

export const NODES: NodeListing[] = nodeSeeds.map((s) => ({
  node_id: addr(),
  owner_account: s.owner,
  pool_id: "pool-1",
  gpu: s.gpu,
  mem_gb: s.mem_gb,
  status: "ready",
  layers: [s.layers[0], s.layers[1]],
  tok_s: 18.4,
  reliability: +(0.7 * s.success + 0.3 * s.uptime).toFixed(3),
  expires_at: T0 + LISTING_TTL,
  nickname: s.nickname,
  success_rate: s.success,
  uptime_rate: s.uptime,
}));
export const NODE = { rex: NODES[0], mika: NODES[1], nova: NODES[2] };
export const nodeById = (id: string) => NODES.find((n) => n.node_id === id);
export const ownerOf = (nodeId: string) => nodeById(nodeId)?.owner_account;

const LAYER_MAP: RouteHop[] = NODES.map((n) => ({ node_id: n.node_id, layers: n.layers! }));
export const POOL: PoolListing = {
  pool_id: "pool-1",
  models: [POOL_MODEL],
  members: NODES.map((n) => n.node_id),
  status: "ready",
  layer_map: LAYER_MAP,
  reliability: Math.min(...NODES.map((n) => n.reliability)),
  load: 0.32,
  restarting: false,
  route_dispute: false,
  expires_at: T0 + LISTING_TTL,
};

/* ── receipts: one every 3 minutes for the last 75 minutes ─────────────── */
const PAYOUT_OF: Record<string, HexAddress> = { [ACC.rex]: PAYOUT.rex, [ACC.mika]: PAYOUT.mika, [ACC.nova]: PAYOUT.nova };
const sig = () => `0x${hex(130)}`;
export const ledgerSeqStart = 1201;

export const RECEIPTS: Receipt[] = Array.from({ length: 25 }, (_, i) => {
  const ts = T0 - (25 - i) * 3 * MIN + Math.floor(r() * 60_000);
  const m = modelById(POOL_MODEL)!;
  const x402 = i % 3 === 1;
  const failed = i === 9;
  const maxTokens = r() < 0.7 ? 512 : 2048;
  const in_tokens = 60 + Math.floor(r() * 500);
  const out_tokens = failed ? 0 : Math.min(maxTokens, 80 + Math.floor(r() * (maxTokens === 512 ? 420 : 1400)));
  const requester = x402 ? null : requesters[i % requesters.length];
  const c = failed || x402 ? 0 : +cost(m.model_factor, in_tokens, out_tokens).toFixed(2);
  return {
    req_id: `req_${hex(16)}`,
    model: POOL_MODEL,
    pay_type: x402 ? "x402" : "credits",
    in_tokens,
    out_tokens,
    cost: c,
    x402_amount: x402 ? String(Math.round(x402Price(m.params_b, maxTokens) * USDC_UNITS)) : null,
    route: LAYER_MAP,
    split: failed || x402 ? null : split(c, LAYER_MAP, requester, ownerOf),
    x402_tx: x402 ? txHash() : null,
    x402_payer: x402 ? "agent-1.ramx.testnet" : null,
    ledger_seq: null, // filled by the ledger below
    prompt_hash: `0x${hex(64)}`,
    resp_hash: failed ? "" : `0x${hex(64)}`,
    status: failed ? "failed" : "ok",
    account_id: null,
    ts,
  };
});
/** Who sent each credits receipt (for the ledger payload and the self-request rule). */
export const REQUESTER = new Map<string, string>();
RECEIPTS.forEach((rc, i) => {
  if (rc.pay_type === "credits") {
    REQUESTER.set(rc.req_id, requesters[i % requesters.length]);
    rc.account_id = requesters[i % requesters.length];
  }
});

/* ── epochs and payouts ────────────────────────────────────────────────── */
/** The current epoch started 3 minutes before page load. */
export const CURRENT_EPOCH = 12;
const epochStart = (n: number) => T0 - 3 * MIN - (CURRENT_EPOCH - n) * EPOCH_MS;

function payoutsFor(n: number): Payout[] {
  const start = epochStart(n);
  const owed = new Map<HexAddress, number>();
  for (const rc of RECEIPTS) {
    if (rc.pay_type !== "x402" || rc.status !== "ok" || rc.ts < start || rc.ts >= start + EPOCH_MS) continue;
    const total = rc.route.reduce((s, h) => s + h.layers[1] - h.layers[0], 0);
    for (const h of rc.route) {
      const to = PAYOUT_OF[ownerOf(h.node_id)!];
      owed.set(to, (owed.get(to) ?? 0) + (Number(rc.x402_amount) * PROVIDER_SHARE * (h.layers[1] - h.layers[0])) / total);
    }
  }
  return [...owed].map(([payout_address, amt]) => ({
    epoch: n,
    payout_address,
    amount_units: String(Math.floor(amt)),
    proof: [`0x${hex(64)}`, `0x${hex(64)}`] as HexAddress[],
    claimed: false,
    claim_tx: null,
  }));
}

export const PAYOUTS: Payout[] = [9, 10, 11].flatMap(payoutsFor);
// Epoch 10 was already claimed by Mika's owner; epoch 11 is waiting for the demo claim.
for (const p of PAYOUTS) if (p.epoch === 10 && p.payout_address === DEMO_OWNER) {
  p.claimed = true;
  p.claim_tx = txHash();
}

export const EPOCHS: Epoch[] = [CURRENT_EPOCH, 11, 10, 9].map((n) => {
  const done = n < CURRENT_EPOCH;
  const total = PAYOUTS.filter((p) => p.epoch === n).reduce((s, p) => s + Number(p.amount_units), 0);
  return {
    epoch: n,
    start_ts: epochStart(n),
    end_ts: epochStart(n) + EPOCH_MS,
    total_units: String(total),
    merkle_root: done ? `0x${hex(64)}` : null,
    post_tx: done ? txHash() : null,
    status: done ? "posted" : "open",
  };
});

/* ── ledger (ledger-v2.ramx.testnet) ───────────────────────────────────────── */
const ev = (type: LedgerType, ts: number, payload: Record<string, unknown>): LedgerEvent => ({
  id: `ev_${hex(12)}`,
  type,
  payload,
  gateway_sig: sig(),
  ledger_seq: null,
  ts,
});
export function settledPayload(rc: Receipt, account: string | null) {
  const s = rc.split!;
  const parts: Record<string, number> = {};
  s.nodes.forEach((n) => (parts[nodeById(n.node_id)?.nickname ?? n.node_id] = +n.credits.toFixed(2)));
  return {
    req_id: rc.req_id,
    account,
    model: rc.model,
    in: rc.in_tokens,
    out: rc.out_tokens,
    cost: rc.cost,
    split: { ...parts, burn: +s.burn.toFixed(2), reserve: +s.reserve.toFixed(2) },
    pay: "credits",
    prompt_hash: rc.prompt_hash,
    resp_hash: rc.resp_hash,
  };
}

const events: LedgerEvent[] = [];
const early = T0 - 80 * MIN;
[ACC.rex, ACC.mika, ACC.nova, ...requesters].forEach((a, i) => {
  events.push(ev("account_created", early + i * 20_000, { account: a, credential: i % 2 ? "selfie" : "orb" }));
  events.push(ev("starter_grant", early + i * 20_000 + 1000, { account: a, credits: 10_000, expires_at: early + i * 20_000 + 14 * 24 * 3600_000 }));
});
[ACC.rex, ACC.mika, ACC.nova].forEach((a, i) =>
  events.push(ev("payout_address_set", early + 4 * MIN + i * 30_000, { account: a, payout_address: PAYOUT_OF[a] })),
);
events.push(ev("credits_expired", early + 6 * MIN, { account: `acc_${hex(6)}`, credits: 8_412.5, reason: "starter credits older than 14 days" }));
for (const rc of RECEIPTS) {
  if (rc.status !== "ok") continue;
  if (rc.pay_type === "credits") events.push(ev("request_settled", rc.ts + 400, settledPayload(rc, REQUESTER.get(rc.req_id) ?? null)));
  else events.push(ev("x402_payment", rc.ts + 400, { req_id: rc.req_id, payer: rc.x402_payer, amount_units: rc.x402_amount, tx: rc.x402_tx, model: rc.model }));
}
for (const e of EPOCHS.filter((x) => x.status !== "open")) {
  events.push(ev("epoch_closed", e.end_ts + 5_000, { epoch: e.epoch, total_units: e.total_units, merkle_root: e.merkle_root, payouts: PAYOUTS.filter((p) => p.epoch === e.epoch).length }));
}
for (const p of PAYOUTS.filter((x) => x.claimed)) {
  events.push(ev("payout_claimed", epochStart(11) + 4 * MIN, { epoch: p.epoch, payout_address: p.payout_address, amount_units: p.amount_units, tx: p.claim_tx }));
}
events.sort((a, b) => a.ts - b.ts);
events.forEach((e, i) => (e.ledger_seq = ledgerSeqStart + i));
// receipts point at their ledger event
for (const rc of RECEIPTS) rc.ledger_seq = events.find((e) => e.payload.req_id === rc.req_id)?.ledger_seq ?? null;

export const LEDGER = events; // oldest first; mutated by the mock (new events get the next seq)

/* ── account stats (directory ramx.account_stats) ───────────────────────── */
function earnedBy(account: string) {
  let earned = 0;
  for (const rc of RECEIPTS) rc.split?.nodes.forEach((n) => ownerOf(n.node_id) === account && (earned += n.credits));
  return earned;
}
function spentBy(account: string) {
  return RECEIPTS.filter((rc) => REQUESTER.get(rc.req_id) === account).reduce((s, rc) => s + rc.cost, 0);
}
export const STATS: AccountStats[] = [ACC.rex, ACC.mika, ACC.nova, ...requesters.slice(0, 3)].map((a) => {
  const earned = earnedBy(a);
  const spent = spentBy(a);
  const node = NODES.find((n) => n.owner_account === a);
  return {
    account_id: a,
    earned: +earned.toFixed(1),
    spent: +spent.toFixed(1),
    ratio: +(earned / Math.max(spent, 1)).toFixed(2),
    reliability: node?.reliability ?? 0,
  };
});
