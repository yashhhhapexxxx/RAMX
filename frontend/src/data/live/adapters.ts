/** Validated wire records → UI presentation units. No synthetic service records. */
import { MeResponse, Receipt as ReceiptSchema, NetworkResponse, LedgerEventsResponse, PayoutsResponse, RpSignatureResponse, AgentKey, AgentKeyListResponse, AgentKeyCreateResponse, AgentRequestsResponse } from '@ramx/shared';
import type { ApiKey, KeyRequest, NetworkSnapshot, NewApiKey, WorldRpContext } from '../api';
import type { Me, Receipt } from '@shared/types';
import type { Epoch, LedgerEvent, NodeListing, Payout } from '@shared/types';

export function meFromWire(raw: unknown): Me {
  const r = MeResponse.parse(raw), b = r.balance;
  return {
    account_id: r.account_id, payout_address: r.payout_address as Me['payout_address'], ratio: r.ratio,
    balance: { starter: b.starter_mc / 1000, starter_expires_at: b.starter_expires_at ?? 0, bought: b.bought_mc / 1000, earned: b.earned_mc / 1000, held: b.held_mc / 1000, earned_total: b.earned_total_mc / 1000, spent_total: b.spent_total_mc / 1000 },
    incentives: r.incentives,
    // /me has no layers or tok/s; pages join these with the node listing from /network.
    nodes: r.nodes.map((n) => ({ ...n, owner_account: r.account_id, status: n.online ? 'online' : 'offline', layers: null, tok_s: 0, expires_at: 0 })),
  };
}

export function receiptFromWire(raw: unknown): Receipt {
  const r = ReceiptSchema.parse(raw);
  const layersOf = (id: string) => r.route?.find((n) => n.node_id === id)?.layers.reduce((a, b) => b - a) ?? 0;
  const total = r.route?.reduce((m, h) => Math.max(m, h.layers[1]), 0) ?? 0;
  const nodesShare = Math.floor((r.cost_mc ?? 0) * 0.9);
  // Self-request (SPEC §8.3): the node got 0 although its layer share would have paid more than 0.
  const isSelf = (id: string, mc: number) => mc === 0 && total > 0 && Math.floor((nodesShare * layersOf(id)) / total) > 0;
  return {
    ...r, status: r.status, in_tokens: r.in_tokens ?? 0, out_tokens: r.out_tokens ?? 0, cost: (r.cost_mc ?? 0) / 1000,
    x402_amount: r.x402_amount, route: r.route ?? [], resp_hash: r.resp_hash ?? '',
    // The presentation keeps its field name; on the wire it is the NEAR ledger contract sequence.
    ledger_seq: r.ledger_seq,
    split: r.split ? {
      burn: r.split.burn_mc / 1000, reserve: r.split.reserve_mc / 1000,
      // A route node with 0 mc served its own owner's request (self-request rule, SPEC §8.3).
      nodes: Object.entries(r.split.nodes).map(([node_id, mc]) => ({ node_id, credits: mc / 1000, layers: layersOf(node_id), self: isSelf(node_id, mc) })),
    } : null,
  };
}

export function networkFromWire(raw: unknown): NetworkSnapshot {
  const r = NetworkResponse.parse(raw);
  return {
    // expires_at 0 = the gateway does not expose listing expiry; the UI must not invent one.
    pools: r.pools.map((p) => ({ ...p, status: p.status === 'loading' ? 'forming' : p.status, layer_map: p.layer_map ?? [], expires_at: 0 })),
    nodes: r.nodes.map((n) => ({ ...n, tok_s: n.tok_s ?? 0, expires_at: 0 })) as NodeListing[],
    stats: r.stats.map((s) => ({ ...s, earned: s.earned_mc / 1000, spent: s.spent_mc / 1000, reliability: s.reliability ?? 0 })),
    updated_at: Date.now(),
  };
}

export function ledgerFromWire(raw: unknown): LedgerEvent[] {
  return LedgerEventsResponse.parse(raw).events.map((r) => ({ id: String(r.id), type: r.event.type, payload: r.event, gateway_sig: r.event.sig, ledger_seq: r.ledger_seq, ts: r.event.ts }));
}

export function rpFromWire(raw: unknown): WorldRpContext {
  const r = RpSignatureResponse.parse(raw);
  return { ...r, app_id: r.app_id as `app_${string}`, signature: r.sig };
}

export function payoutsFromWire(raw: unknown): { epochs: Epoch[]; payouts: Payout[] } {
  const r = PayoutsResponse.parse(raw);
  // The endpoint lists this address's leaves, not aggregate epoch totals. Do not invent totals.
  return { epochs: [], payouts: r.payouts.map((p) => ({ ...p, payout_address: r.payout_address, proof: p.proof })) };
}

const keyOf = (k: AgentKey): ApiKey => ({ id: k.agent_id, name: k.name, cap: k.budget_mc === null ? null : k.budget_mc / 1000, spent: k.spent_mc / 1000, revoked: k.revoked, created_at: k.created_at, last_used_at: k.last_used_at, bought: k.key_credits_mc / 1000, boughtTotal: k.bought_total_mc / 1000 });
export const keysFromWire = (raw: unknown): ApiKey[] => AgentKeyListResponse.parse(raw).agents.map(keyOf);
export function newKeyFromWire(raw: unknown): NewApiKey {
  const k = AgentKeyCreateResponse.parse(raw);
  return { ...keyOf(k), token: k.token };
}
export const keyRequestsFromWire = (raw: unknown): KeyRequest[] =>
  AgentRequestsResponse.parse(raw).requests.map(({ cost_mc, ledger_seq, ...r }) => ({ ...r, ledger_seq: ledger_seq, cost: cost_mc === null ? null : cost_mc / 1000 }));
