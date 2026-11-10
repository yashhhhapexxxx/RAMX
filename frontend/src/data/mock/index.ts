/* Mock PoolApi: seeded fixtures + a 1 s ticker that makes the pool feel live.
   Money follows spec v0.1 §5.3 / §8: hold the maximum cost, stream, settle the
   real cost, split 90/5/5 by layers, write a ledger event with the next ledger seq.
   Dev hooks (browser console):
     __ramxUnplug("Mika")    → stop that node's heartbeats; its listing vanishes ≤120 s later
     __ramxReplug("Mika")    → renew again
     __ramxExpireNow("Mika") → skip the wait (listing expires now) */
import type { Balance, LedgerEvent, LedgerType, Me, NodeListing, Receipt } from "@shared/types";
import type { ChatBody, ChatChunk, LoginResult, NetworkSnapshot, NewApiKey, NodeLink, PoolApi } from "../api";
import { PaymentRequired, SessionExpired } from "../api";
import { InsufficientCredits, START_NODE_CAP, STARTER_CREDITS, STARTER_TTL_MS, available, cost, estimateTokens, holdFor, ratio, spend, split } from "../../lib/credits";
import {
  ACC,
  DEMO_ACCOUNT,
  DEMO_OWNER,
  EPOCHS,
  LEDGER_CONTRACT,
  LEDGER,
  LISTING_TTL,
  MODELS,
  NODES,
  PAYOUT,
  PAYOUTS,
  POOL,
  RECEIPTS,
  REQUESTER,
  STATS,
  T0,
  hex,
  txHash,
  modelById,
  nodeById,
  ownerOf,
  rng,
  settledPayload,
} from "./fixtures";

const RENEW_EVERY = 30_000;
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) return abort();
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
const latency = () => wait(150 + Math.random() * 250);
const clone = <T,>(v: T): T => structuredClone(v);
const rand = rng(Date.now() & 0xffff);

/* ── ledger writes ─────────────────────────────────────────────────────── */
function append(type: LedgerType, payload: Record<string, unknown>): LedgerEvent {
  const e: LedgerEvent = {
    id: `ev_${hex(12, rand)}`,
    type,
    payload,
    gateway_sig: `0x${hex(130, rand)}`,
    ledger_seq: (LEDGER.at(-1)?.ledger_seq ?? 1200) + 1,
    ts: Date.now(),
  };
  LEDGER.push(e);
  return e;
}

/* ── accounts ──────────────────────────────────────────────────────────── */
type Account = { id: string; balance: Balance; payout_address: `0x${string}` | null; created_at: number };
const accounts = new Map<string, Account>();
// Mika's owner exists already (earned credits from the seeded receipts), so the demo has a provider view.
const mikaEarned = RECEIPTS.reduce((s, rc) => s + (rc.split?.nodes.find((n) => n.node_id === NODES[1].node_id)?.credits ?? 0), 0);
accounts.set(ACC.mika, {
  id: ACC.mika,
  balance: { starter: 9_120.4, starter_expires_at: T0 + STARTER_TTL_MS - 80 * 60_000, bought: 0, earned: mikaEarned, held: 0, earned_total: mikaEarned, spent_total: 879.6 },
  payout_address: PAYOUT.mika,
  created_at: T0 - 80 * 60_000,
});

/* Demo state survives a reload in the same tab (sessionStorage), so a logged-in
   session keeps its balance, linked nodes, receipts and claims. */
const STORE = "ramx.mock.v1";
const base = { nodes: NODES.length, receipts: RECEIPTS.length, events: LEDGER.length };
type Saved = {
  accounts: Account[];
  nodes: NodeListing[];
  receipts: Receipt[];
  requesters: [string, string][];
  events: LedgerEvent[];
  claims: { epoch: number; payout_address: string; claim_tx: string | null }[];
};
function persist() {
  try {
    const saved: Saved = {
      accounts: [...accounts.values()],
      nodes: NODES.slice(base.nodes),
      receipts: RECEIPTS.slice(base.receipts),
      requesters: RECEIPTS.slice(base.receipts).map((rc) => [rc.req_id, REQUESTER.get(rc.req_id) ?? ""]),
      events: LEDGER.slice(base.events),
      claims: PAYOUTS.filter((p) => p.claimed).map((p) => ({ epoch: p.epoch, payout_address: p.payout_address, claim_tx: p.claim_tx })),
    };
    sessionStorage.setItem(STORE, JSON.stringify(saved));
  } catch {
    /* no storage (tests, private mode): state lasts until reload */
  }
}
function restore() {
  try {
    const raw = sessionStorage.getItem(STORE);
    if (!raw) return;
    const saved = JSON.parse(raw) as Saved;
    saved.accounts.forEach((a) => accounts.set(a.id, a));
    NODES.push(...saved.nodes.map((n) => ({ ...n, expires_at: Date.now() + LISTING_TTL })));
    RECEIPTS.push(...saved.receipts);
    saved.requesters.forEach(([id, acc]) => REQUESTER.set(id, acc));
    LEDGER.push(...saved.events);
    for (const c of saved.claims) {
      const p = PAYOUTS.find((x) => x.epoch === c.epoch && x.payout_address.toLowerCase() === c.payout_address.toLowerCase());
      if (p) Object.assign(p, { claimed: true, claim_tx: c.claim_tx });
    }
  } catch {
    /* corrupt or blocked storage: start fresh */
  }
}
restore();

const tokenFor = (id: string) => `mock.${id}`;
function accountOf(token: string) {
  const a = accounts.get(token.replace(/^mock\./, ""));
  if (!a) throw new SessionExpired();
  return a;
}
function meOf(a: Account): Me {
  return clone({
    account_id: a.id,
    balance: a.balance,
    ratio: ratio(a.balance.earned_total, a.balance.spent_total),
    payout_address: a.payout_address,
    incentives: { locked_mc: 0, next_unlock_at: null, node_cap: START_NODE_CAP, banned: false, credential: "orb" },
    nodes: NODES.filter((n) => n.owner_account === a.id && isListed(n)),
  });
}
function createAccount(id: string, at = Date.now(), quiet = false) {
  const a: Account = {
    id,
    balance: { starter: STARTER_CREDITS, starter_expires_at: at + STARTER_TTL_MS, bought: 0, earned: 0, held: 0, earned_total: 0, spent_total: 0 },
    payout_address: null,
    created_at: at,
  };
  accounts.set(id, a);
  if (quiet) return a; // registered before this session: its events are already on the ledger
  append("account_created", { account: id, credential: "selfie" });
  append("starter_grant", { account: id, credits: STARTER_CREDITS, expires_at: a.balance.starter_expires_at });
  return a;
}

/* ── live state: listings renew every 30 s unless unplugged ────────────── */
const unplugged = new Set<string>();
const lastRenew = new Map<string, number>(NODES.map((n) => [n.node_id, Date.now()]));
let poolRenew = Date.now();

function isListed(n: NodeListing, now = Date.now()) {
  return n.expires_at > now;
}
function step() {
  const now = Date.now();
  for (const n of NODES) {
    if (!unplugged.has(n.node_id) && now - (lastRenew.get(n.node_id) ?? 0) >= RENEW_EVERY) lastRenew.set(n.node_id, now);
    n.expires_at = (lastRenew.get(n.node_id) ?? now) + LISTING_TTL;
  }
  const members = POOL.members.map((id) => nodeById(id)!);
  const alive = members.every((n) => isListed(n, now));
  if (alive && now - poolRenew >= RENEW_EVERY) poolRenew = now;
  POOL.expires_at = poolRenew + LISTING_TTL;
  POOL.status = alive ? "ready" : "forming";
  POOL.load = alive ? Math.min(0.9, Math.max(0.1, POOL.load + (rand() - 0.5) * 0.06)) : 0;
  const toks = alive ? +(18.4 * (0.93 + rand() * 0.14)).toFixed(1) : 0;
  for (const n of NODES) n.tok_s = n.layers && isListed(n, now) ? toks : 0;
  POOL.reliability = Math.min(...members.map((n) => n.reliability));
}
function snapshot(): NetworkSnapshot {
  const now = Date.now();
  const pools = POOL.expires_at > now ? [POOL] : [];
  return clone({ pools, nodes: NODES.filter((n) => isListed(n, now)), stats: STATS, updated_at: now });
}

const subs = new Set<(s: NetworkSnapshot) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function ensureTicker() {
  if (timer) return;
  step();
  timer = setInterval(() => {
    step();
    const s = snapshot();
    subs.forEach((cb) => cb(s));
  }, 1000);
}

function findNode(ref: string) {
  const q = ref.toLowerCase();
  return NODES.find((n) => n.node_id.toLowerCase() === q || n.nickname?.toLowerCase() === q);
}
if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  w.__ramxUnplug = (ref: string) => {
    const n = findNode(ref);
    if (!n) return `no node "${ref}"`;
    unplugged.add(n.node_id);
    return `${n.nickname} unplugged: its heartbeats stop and its listing expires ≤${LISTING_TTL / 1000}s after the last renewal`;
  };
  w.__ramxReplug = (ref: string) => {
    const n = findNode(ref);
    if (!n) return `no node "${ref}"`;
    unplugged.delete(n.node_id);
    lastRenew.set(n.node_id, Date.now());
    step();
    return `${n.nickname} renewed`;
  };
  w.__ramxExpireNow = (ref: string) => {
    const n = findNode(ref);
    if (!n) return `no node "${ref}"`;
    unplugged.add(n.node_id);
    lastRenew.set(n.node_id, Date.now() - LISTING_TTL - 1);
    step();
    return `${n.nickname} expired`;
  };
}

/* ── chat ──────────────────────────────────────────────────────────────── */
const ANSWERS: [RegExp, string][] = [
  [/pool|split|layer|how/i, "Your request just ran across three laptops. Rex, an RTX 4060 gaming laptop, ran layers 0–11 of Qwen3-14B and passed the activations to Mika, an M4 MacBook, for layers 11–31. Nova, an M5 MacBook, finished layers 31–40 and produced these tokens. None of them could hold the model alone. The gateway wrote a receipt with that route and split your credits between them by layers served."],
  [/credit|cost|pay|price|balance/i, "This answer costs model_factor × (output tokens + 0.2 × input tokens) credits. Qwen3-14B has a factor of 1.75. The gateway held the maximum cost before it started, then settled the real cost when the stream ended. 90% goes to the nodes on the route by layers served, 5% is burned and 5% goes to the network reserve."],
  [/usdc|x402|agent|epoch|payout|claim/i, "AI agents without an account pay per request with x402 in USDC on NEAR testnet: 0.004 USDC for up to 512 tokens on a 14B model. That USDC goes to the treasury. Every 10 minutes the epoch closes, the providers' 80% share is posted to the payout contract as a Merkle root, and each node owner claims their USDC with a proof."],
];
const DEFAULT_ANSWER =
  "Hi! I'm Qwen3-14B, running on a pool of three laptops rather than one big server. Each laptop holds a slice of my layers, and the gateway stitches them into one reply. Ask me how the pool splits the model, what this answer costs, or how providers get paid.";

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return `0x${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function* mockChat(body: ChatBody, token: string | null, signal: AbortSignal): AsyncIterable<ChatChunk> {
  if (!token) throw new PaymentRequired();
  const acct = accountOf(token);
  const model = modelById(body.model);
  ensureTicker();
  step();
  if (!model || POOL.status !== "ready" || !POOL.models.includes(body.model)) {
    throw new Error(`No pool is serving ${body.model} right now (HTTP 503). You paid nothing.`);
  }
  const inTok = estimateTokens(body.messages);
  const hold = holdFor(model.model_factor, body.max_tokens, inTok);
  const free = available(acct.balance);
  if (hold > free) throw new InsufficientCredits(hold, free);
  acct.balance.held += hold;
  let released = false;
  const release = () => {
    if (!released) acct.balance.held -= hold;
    released = true;
  };

  const last = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const text = ANSWERS.find(([re]) => re.test(last))?.[1] ?? DEFAULT_ANSWER;
  const t0 = Date.now();
  let tokens = 0;
  try {
    await wait(380 + Math.random() * 240, signal);
    yield { delta: "", route: POOL.layer_map, ttft_ms: Date.now() - t0 };
    const start = Date.now();
    for (const w of text.split(/(\s+)/)) {
      if (!w) continue;
      if (tokens >= body.max_tokens) break;
      await wait(1000 / 18.4, signal);
      tokens++;
      yield { delta: w, tok_s: +(tokens / Math.max((Date.now() - start) / 1000, 0.05)).toFixed(1) };
    }
  } catch (e) {
    release();
    // Stop: the tokens already served are settled and paid for. Nothing served → nothing paid.
    if (!(e instanceof DOMException && e.name === "AbortError") || tokens === 0) throw e;
  } finally {
    release(); // also when the reader stops early (generator return)
  }
  const c = +cost(model.model_factor, inTok, tokens).toFixed(2);
  acct.balance = spend(acct.balance, c);
  const s = split(c, POOL.layer_map, acct.id, ownerOf);
  for (const n of s.nodes) {
    const owner = accounts.get(ownerOf(n.node_id) ?? "");
    if (owner && n.credits > 0) {
      owner.balance.earned += n.credits;
      owner.balance.earned_total += n.credits;
    }
  }
  const rc: Receipt = {
    req_id: `req_${hex(16, rand)}`,
    account_id: acct.id,
    model: body.model,
    pay_type: "credits",
    in_tokens: inTok,
    out_tokens: tokens,
    cost: c,
    x402_amount: null,
    route: POOL.layer_map,
    split: s,
    x402_tx: null,
    x402_payer: null,
    ledger_seq: null,
    prompt_hash: await sha256(JSON.stringify(body.messages)),
    resp_hash: await sha256(text),
    status: "ok",
    ts: t0,
  };
  rc.ledger_seq = append("request_settled", settledPayload(rc, acct.id)).ledger_seq;
  RECEIPTS.push(rc);
  REQUESTER.set(rc.req_id, acct.id);
  persist();
  yield { delta: "", done: true, receipt_id: rc.req_id };
}

/* ── the API ───────────────────────────────────────────────────────────── */
/** Mock API keys (in memory; tests and offline demos only). */
const KEYS = new Map<string, NewApiKey[]>();
const keysOf = (token: string) => {
  const id = accountOf(token).id;
  if (!KEYS.has(id)) KEYS.set(id, []);
  return KEYS.get(id)!;
};

export const mockApi: PoolApi = {
  mode: "mock",

  auth: {
    async rpContext() {
      await latency();
      return null; // no relying party in the demo: the login offers simulated outcomes
    },
    async verify(result): Promise<LoginResult> {
      await wait(700);
      const sim = (result as { simulate?: string } | null)?.simulate ?? "new";
      if (sim === "invalid") throw new Error("World ID could not verify this proof. Try again.");
      const existing = accounts.get(DEMO_ACCOUNT);
      if (sim === "existing" && !existing) {
        // the human registered earlier (a day ago); log in without a new grant
        const a = createAccount(DEMO_ACCOUNT, Date.now() - 24 * 3600_000, true);
        persist();
        return { token: tokenFor(a.id), me: meOf(a), created: false };
      }
      if (existing) return { token: tokenFor(existing.id), me: meOf(existing), created: false };
      const a = createAccount(DEMO_ACCOUNT);
      persist();
      return { token: tokenFor(a.id), me: meOf(a), created: true };
    },
    async nearNonce() {
      await latency();
      return { message: "Log in to RAMX", nonce: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), recipient: "ramx", expires_at: Date.now() + 300_000 };
    },
    async nearVerify() {
      throw new Error("NEAR wallet login needs the live gateway (VITE_DATA_MODE=live).");
    },
  },

  async nearTopup() {
    throw new Error("USDC top-up needs the live gateway.");
  },

  async me(token) {
    ensureTicker();
    await latency();
    return meOf(accountOf(token));
  },

  async registerNode(token, link: NodeLink) {
    await wait(900);
    const a = accountOf(token);
    if (!/^0x[0-9a-fA-F]{40}$/.test(link.node_id)) throw new Error("This registration link has an invalid node id.");
    if (!link.node_sig) throw new Error("This registration link is missing the node signature. Run ramx-node init again.");
    const known = NODES.find((n) => n.node_id.toLowerCase() === link.node_id.toLowerCase());
    if (known && known.owner_account !== a.id) throw new Error("This node is already linked to another account.");
    if (known) return meOf(a);
    if (NODES.filter((n) => n.owner_account === a.id).length >= START_NODE_CAP) {
      throw new Error(`An account can have at most ${START_NODE_CAP} nodes.`);
    }
    if (link.payout_address && a.payout_address?.toLowerCase() !== link.payout_address.toLowerCase()) {
      a.payout_address = link.payout_address as typeof a.payout_address;
      append("payout_address_set", { account: a.id, payout_address: link.payout_address });
    }
    const n: NodeListing = {
      node_id: link.node_id,
      owner_account: a.id,
      pool_id: POOL.pool_id,
      gpu: link.gpu || "Unknown GPU",
      mem_gb: link.mem_gb ?? 0,
      status: "online",
      layers: null, // joins the pipeline at the next pool start (join while running is post-MVP)
      tok_s: 0,
      reliability: 0.8, // §9.1: a new node starts at 0.8
      expires_at: Date.now() + LISTING_TTL,
      nickname: "You", // no success / uptime history yet
    };
    NODES.push(n);
    lastRenew.set(n.node_id, Date.now());
    persist();
    return meOf(a);
  },

  async models() {
    ensureTicker();
    await latency();
    return MODELS.map((m) => ({ model: clone(m), served: POOL.status === "ready" && POOL.models.includes(m.model_id), pools: POOL.models.includes(m.model_id) ? 1 : 0 }));
  },
  chat: mockChat,
  async request(id) {
    await latency();
    const rc = RECEIPTS.find((r) => r.req_id === id);
    return rc ? clone(rc) : null;
  },
  async myRequests(token) {
    await latency();
    const a = accountOf(token);
    return clone(RECEIPTS.filter((rc) => REQUESTER.get(rc.req_id) === a.id).reverse());
  },

  async network() {
    ensureTicker();
    await latency();
    return snapshot();
  },
  subscribe(cb) {
    ensureTicker();
    subs.add(cb);
    cb(snapshot());
    return () => {
      subs.delete(cb);
    };
  },

  async ledger(opts) {
    await latency();
    const rows = LEDGER.filter((e) => !opts?.type || e.type === opts.type).slice().reverse();
    return clone(opts?.limit ? rows.slice(0, opts.limit) : rows);
  },
  async onChain(contract, seq) {
    await wait(300);
    const last = LEDGER.at(-1)?.ledger_seq ?? 0;
    if (contract !== LEDGER_CONTRACT) return { found: false };
    return { found: LEDGER.some((x) => x.ledger_seq === seq), on_chain_seq: last };
  },

  async keys(token) {
    await latency();
    return clone(keysOf(token).map(({ token: _t, ...k }) => k));
  },
  async createKey(token, name, cap) {
    await latency();
    const id = `agt_${hex(8, rand)}`;
    const k: NewApiKey = { id, name, cap, spent: 0, revoked: false, created_at: Date.now(), last_used_at: null, bought: 0, boughtTotal: 0, token: `gpa_${id}_${hex(64, rand)}` };
    keysOf(token).push(k);
    return clone(k);
  },
  async revokeKey(token, id) {
    await latency();
    const k = keysOf(token).find((x) => x.id === id && !x.revoked);
    if (!k) throw new Error("No such active API key.");
    k.revoked = true;
  },
  async keyRequests(token, id) {
    await latency();
    if (!keysOf(token).some((x) => x.id === id)) throw new Error("No such API key.");
    return [];
  },

  async payouts(address) {
    await latency();
    const a = address.toLowerCase();
    return clone({ epochs: EPOCHS, payouts: PAYOUTS.filter((p) => p.payout_address.toLowerCase() === a) });
  },
  async claim(payout) {
    await wait(900);
    const p = PAYOUTS.find((x) => x.epoch === payout.epoch && x.payout_address.toLowerCase() === payout.payout_address.toLowerCase());
    const e = EPOCHS.find((x) => x.epoch === payout.epoch);
    if (!p || e?.status !== "posted") throw new Error(`Epoch ${payout.epoch} is not posted yet.`);
    if (p.claimed) throw new Error("Already claimed for this epoch.");
    p.claimed = true;
    p.claim_tx = txHash(rand);
    append("payout_claimed", { epoch: p.epoch, payout_address: p.payout_address, amount_units: p.amount_units, tx: p.claim_tx });
    persist();
    return { tx: p.claim_tx };
  },
};

export { DEMO_OWNER, LEDGER_CONTRACT, modelById, nodeById };
