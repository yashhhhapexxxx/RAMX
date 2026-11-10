/* /account (spec §12, §8, §8.8, §9): your side of the earn → spend loop.
   Starter vs earned (unlocked / still vesting), held, contribution ratio and what it buys (priority),
   node cap, availability rewards, your nodes with reliability, payout address, recent receipts.
   `/register-node?node_id&pool_id&gpu&mem_gb&ts&node_sig` (printed by `ramx-node init`) opens the
   Confirm node card, which calls POST /nodes/register. */
import { useState } from "react";
import type { Me, NodeListing, Receipt } from "@shared/types";
import { PageHead } from "../components/ConsoleShell";
import ReceiptSheet from "../components/chat/ReceiptSheet";
import SourceBadge from "../components/SourceBadge";
import { CodeBox } from "../components/console/CopyButton";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading, StatusPill, Spinner, Busy } from "../components/console/Status";
import { api, SessionExpired } from "../data";
import { useSession } from "../auth/context";
import UsdcTopup from "../components/console/UsdcTopup";
import { useAsync } from "../hooks/useAsync";
import { useNetwork, useNow } from "../hooks/usePool";
import { NearAccountId } from "@ramx/shared";
import { PROVEN_NODE_CAP, START_NODE_CAP, available, liveStarter } from "../lib/credits";
import { fmtAgo, fmtLayers, fmtLeft, fmtMc, fmtNum, gpuShort, shortHash } from "../lib/format";
import { explorerEvent } from "../lib/links";
import { navigate } from "../lib/router";
import { env } from "../config/env";
import config from "../../../shared/config/ramx.config.json";

const cr = (n: number) => fmtNum(n, 1);
type Link = import("../data/api").NodeLink;
const inc = config.incentives;
const CREDENTIAL: Record<string, string> = { orb: "Orb", passport: "Passport", selfie: "Selfie Check" };

function readLink(q: URLSearchParams): Link | null {
  const node_id = q.get("node_id");
  if (!node_id) return null;
  return { node_id, pool_id: q.get("pool_id") ?? "", gpu: q.get("gpu") ?? "", mem_gb: Number(q.get("mem_gb")), ts: Number(q.get("ts")), node_sig: q.get("node_sig") ?? "" };
}

function RegisterCard({ link, me, token, onDone }: { link: Link; me: Me; token: string; onDone: (me: Me) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [typed, setTyped] = useState("");
  const payout = me.payout_address ?? (NearAccountId.safeParse(typed.trim()).success ? typed.trim() : null);
  const already = me.nodes.some((n) => n.node_id.toLowerCase() === link.node_id.toLowerCase());
  const full = !already && me.nodes.length >= me.incentives.node_cap;

  async function confirm() {
    if (!payout) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.registerNode(token, { ...link, payout_address: payout }));
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel register-card section-bottom" aria-labelledby="reg-h">
      <span className="mono-label">
        <Icon name="laptop" size={12} /> Registration link
      </span>
      <h2 id="reg-h">Confirm this node.</h2>
      <p className="muted">Your node agent signed this link with its own key. Confirm to link the laptop to your account. Once it serves layers in a pool, every request it serves earns you credits.</p>
      <dl className="kv">
        <dt>Node key</dt>
        <dd className="mono" title={link.node_id}>
          {shortHash(link.node_id, 8, 6)}
        </dd>
        <dt>Pool</dt>
        <dd className="mono">{link.pool_id === "auto" ? "auto (the gateway forms a pool with nearby nodes)" : link.pool_id || "—"}</dd>
        <dt>GPU</dt>
        <dd>{link.gpu || "—"}</dd>
        <dt>Memory</dt>
        <dd>{link.mem_gb ? `${link.mem_gb} GB` : "—"}</dd>
        <dt>Payout address</dt>
        <dd className="mono">
          {me.payout_address ?? (
            <input className="input mono" placeholder="you.testnet" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="NEAR payout account" spellCheck={false} />
          )}
        </dd>
      </dl>
      {!me.payout_address && <p className="faint">Your NEAR account receives this node's share of USDC from x402 requests at each epoch. It is recorded on the ledger. Register it on the USDC contract (storage_deposit) before you claim.</p>}
      {full && <ErrorBox error={new Error(`This account already has ${me.nodes.length} of ${me.incentives.node_cap} nodes. Remove one or prove the account to raise the cap to ${PROVEN_NODE_CAP}.`)} />}
      {error && <ErrorBox error={error} />}
      <div className="tile-actions">
        {already ? (
          <span className="pill pill-ok">already linked to this account</span>
        ) : payout ? (
          <button className="button button-blue" onClick={confirm} disabled={busy || full || me.incentives.banned}>
            {busy ? <Busy>Linking…</Busy> : "Confirm node"} <Icon name="check" size={15} />
          </button>
        ) : (
          <span className="faint">Enter a NEAR account (e.g. you.testnet) to confirm.</span>
        )}
        <button className="button button-ghost" onClick={() => navigate("/account", { replace: true })}>
          Cancel
        </button>
      </div>
      <p className="faint">
        {me.nodes.length} of {me.incentives.node_cap} nodes used on this account.
      </p>
    </section>
  );
}

/** How to put a laptop in a pool. There is no "create a pool" endpoint: pools come from config or POOL_ID=auto. */
function JoinGuide({ open }: { open?: boolean }) {
  return (
    <details className="panel join-guide" open={open}>
      <summary>
        <span className="section-title">Join with your laptop</span>
        <span className="faint">install, init, open the link</span>
      </summary>
      <ol className="join-steps">
        <li>
          <h3>Install Parallax and download the model</h3>
          <p className="muted">Parallax runs your slice of the model. Download the weights before you join: nodes start offline from the local cache.</p>
        </li>
        <li>
          <h3>Set up the node agent</h3>
          <CodeBox code={"cd node-agent && cp .env.example .env && uv sync"} />
          <p className="muted">
            In <code className="mono">.env</code> set <code className="mono">GATEWAY_URL</code>, <code className="mono">FRONTEND_URL</code> and <code className="mono">POOL_ID</code>. With <code className="mono">POOL_ID=auto</code> the gateway puts you in a pool with nodes less than {config.pool_formation.max_rtt_ms} ms away that together can hold a model.
          </p>
        </li>
        <li>
          <h3>Make a node key and open the link</h3>
          <CodeBox code={"uv run ramx-node init"} />
          <p className="muted">It prints a /register-node link. Open it here, log in, and confirm. The node is linked to your account and your payout address.</p>
        </li>
        <li>
          <h3>Start serving</h3>
          <CodeBox code={"uv run ramx-node start"} />
          <p className="muted">The agent joins the pool, reports its layer range in a signed heartbeat every 10 seconds; the gateway lists it in the directory. Stop with <code className="mono">uv run ramx-node stop</code>.</p>
        </li>
      </ol>
    </details>
  );
}

function NodesTable({ me, listings }: { me: Me; listings: NodeListing[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Node</th>
            <th>Pool</th>
            <th>Status</th>
            <th>Layers</th>
            <th className="num">Tok/s</th>
            <th className="num">Reliability</th>
          </tr>
        </thead>
        <tbody>
          {me.nodes.map((n) => {
            const l = listings.find((x) => x.node_id === n.node_id);
            return (
              <tr key={n.node_id}>
                <td>
                  <span>
                    {gpuShort(n.gpu)} · {n.mem_gb} GB
                  </span>
                  <span className="cell-sub mono faint" title={n.node_id}>
                    {shortHash(n.node_id, 6, 4)}
                  </span>
                </td>
                <td className="mono">{n.pool_id}</td>
                <td>
                  <StatusPill status={l?.status ?? n.status} />
                </td>
                <td className="mono">{l?.layers ? fmtLayers(l.layers) : <span className="faint">none yet</span>}</td>
                <td className="num mono">{l?.tok_s ? l.tok_s.toFixed(1) : <span className="faint">—</span>}</td>
                <td className="num">
                  <span className="mono">{n.reliability.toFixed(2)}</span>
                  <span className="cell-sub faint">{n.reliability === config.reliability.initial_score ? "new node, starts at 0.80" : "0.7 × success + 0.3 × uptime"}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Account({ query }: { query: URLSearchParams }) {
  const session = useSession();
  const net = useNetwork();
  const now = useNow(10_000);
  const [sheet, setSheet] = useState<Receipt | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  const link = readLink(query);
  const token = session.token;
  const me = session.me;
  const receipts = useAsync(() => (token ? api.myRequests(token) : Promise.resolve([])), [token, me?.balance.spent_total]);
  const rewards = useAsync(() => (me ? api.ledger({ type: "availability_reward", limit: 100 }) : Promise.resolve([])), [me?.account_id], { refreshMs: 60_000 });
  const nodes = net?.nodes ?? [];

  const head = (
    <PageHead
      label="ACCOUNT · GATEWAY"
      title="Your account."
      sub={
        me ? (
          <>
            <span className="mono">{me.account_id}</span>
            {me.incentives.credential && <span className="faint"> · verified with {CREDENTIAL[me.incentives.credential]}</span>}
          </>
        ) : (
          "Serve layers to earn credits. Spend them on any pool."
        )
      }
    />
  );

  if (!token && !session.loading) {
    const here = `${location.pathname}${query.toString() ? `?${query}` : ""}`;
    return (
      <>
        {head}
        <section className="panel tile login-tile section-bottom" aria-labelledby="acc-login-h">
          <span className="mono-label">
            <Icon name="user-check" size={12} /> World ID
          </span>
          <h2 id="acc-login-h">{link ? "Log in to link your node." : "Log in to see your account."}</h2>
          <p className="muted">{link ? "Your node agent printed this link. Log in with World ID first; the link stays open after login." : "Your credits, contribution ratio, nodes and receipts live here."}</p>
          <div className="tile-actions">
            <button className="button button-blue" onClick={() => session.openLogin(here)}>
              Log in with World ID <Icon name="arrow" size={15} />
            </button>
          </div>
        </section>
        <JoinGuide open={!link} />
      </>
    );
  }
  if (!me) {
    return (
      <>
        {head}
        {session.error ? <ErrorBox error={new Error(session.error)} retry={() => void session.reload()} /> : <Loading h={240} />}
      </>
    );
  }

  const b = me.balance;
  const i = me.incentives;
  const myRewards = (rewards.data ?? []).filter((e) => e.payload.account_id === me.account_id);
  const rewardMc = myRewards.reduce((s, e) => s + Number(e.payload.amount_mc ?? 0), 0);
  const earnedTotal = b.earned_total;
  const spentTotal = b.spent_total;
  const barMax = Math.max(earnedTotal, spentTotal, 1);

  return (
    <>
      {head}
      {i.banned && <ErrorBox error={new Error("This account is banned: it cannot add nodes and its nodes are out of routing. Unlocked credits stay spendable.")} />}

      {linked && (
        <div className="world-card is-ok section-bottom" role="status">
          <Icon name="check" size={20} />
          <div>
            <h3>Node linked.</h3>
            <p className="muted">
              <span className="mono">{shortHash(linked, 8, 6)}</span> is on your account. Start it with <code className="mono">ramx-node start</code>; its listing appears on the network once it renews.
            </p>
          </div>
        </div>
      )}
      {link && !linked && token && (
        <RegisterCard
          link={link}
          me={me}
          token={token}
          onDone={() => {
            setLinked(link.node_id);
            void session.reload();
            navigate("/account", { replace: true });
          }}
        />
      )}

      <section className="panel" aria-labelledby="credits-h">
        <div className="panel-head">
          <h2 id="credits-h" className="section-title">
            Credits
          </h2>
          <span className="faint">
            <b className="acc-avail">{cr(available(b, now))}</b> available now
          </span>
        </div>
        <div className="stats">
          <div className="stat">
            <span className="mono-label">Starter</span>
            <p className="stat-value">{cr(liveStarter(b, now))}</p>
            <p className="stat-note">{b.starter_expires_at ? `expires in ${fmtLeft(b.starter_expires_at, now)}` : "none"} · spent first</p>
          </div>
          <div className="stat">
            <span className="mono-label">Earned, unlocked</span>
            <p className="stat-value">{cr(b.earned)}</p>
            <p className="stat-note">spendable · expires {inc.earned_expiry_days} days after unlock</p>
          </div>
          <div className="stat">
            <span className="mono-label">Earned, vesting</span>
            <p className="stat-value">{fmtMc(i.locked_mc)}</p>
            <p className="stat-note">{i.next_unlock_at ? `next unlock in ${fmtLeft(i.next_unlock_at, now)}` : `each share vests ${Math.round(inc.vesting_s / 60)} min`}</p>
          </div>
          <div className="stat">
            <span className="mono-label">Held</span>
            <p className="stat-value">{cr(b.held)}</p>
            <p className="stat-note">reserved for requests in flight</p>
          </div>
        </div>
        <p className="faint table-note">Requests spend starter credits first, then bought credits, then unlocked earned credits, oldest first. Vesting credits count toward your ratio at once but cannot be spent yet.</p>
        {b.bought > 0 && <p className="faint">Bought with USDC: <b>{cr(b.bought)}</b> (never expire).</p>}
        {session.token && me && (
          <details className="section-gap">
            <summary className="text-link">Top up with USDC from a NEAR wallet</summary>
            <UsdcTopup token={session.token} accountId={me.account_id} onDone={() => void session.reload()} />
          </details>
        )}
      </section>

      <div className="grid grid-2 section-gap acc-grid">
        <section className="panel" aria-labelledby="ratio-h">
          <div className="panel-head">
            <h2 id="ratio-h" className="section-title">
              Contribution ratio
            </h2>
            <span className="faint">earned ÷ max(spent, 1)</span>
          </div>
          <p className="stat-value acc-ratio">{me.ratio.toFixed(2)}</p>
          <div className="ratio-bars" aria-hidden="true">
            <span>earned</span>
            <i style={{ width: `${(earnedTotal / barMax) * 100}%` }} className="ratio-earned" />
            <span className="mono">{cr(earnedTotal)}</span>
            <span>spent</span>
            <i style={{ width: `${(spentTotal / barMax) * 100}%` }} className="ratio-spent" />
            <span className="mono">{cr(spentTotal)}</span>
          </div>
          <p className="muted">When a pool is busy, waiting requests are served in order of ratio, highest first. A low ratio never blocks a request; it only waits longer. AI agents paying with x402 count as 1.</p>
          <p className="faint">
            Availability rewards: {rewards.data ? <b>{fmtMc(rewardMc)} credits</b> : <Spinner size={11} />} in recent ledger events. Nodes that stay online while their pool has a queue earn {inc.availability.reward_mc_per_min} mc a minute from the reserve.
          </p>
        </section>

        <section className="panel" aria-labelledby="payout-h">
          <div className="panel-head">
            <h2 id="payout-h" className="section-title">
              Payout address
            </h2>
            <span className="faint">NEAR testnet</span>
          </div>
          {me.payout_address ? (
            <>
              <p className="mono payout-addr">{me.payout_address}</p>
              <p className="faint">Credits pay for requests made with an account. AI agents pay with x402 in USDC on NEAR instead: your nodes' share of that income is paid to this account at each epoch.</p>
              <button className="text-link" onClick={() => navigate("/payouts")}>
                Open payouts <Icon name="arrow" size={13} />
              </button>
            </>
          ) : (
            <p className="muted">Not set yet. Connect a wallet when you confirm your first node: the address is saved with it and recorded on the ledger.</p>
          )}
        </section>
      </div>

      <section className="panel section-gap" aria-labelledby="mynodes-h">
        <div className="panel-head">
          <h2 id="mynodes-h" className="section-title">
            My nodes
          </h2>
          <span className="faint">
            {me.nodes.length} of {i.node_cap} allowed
          </span>
        </div>
        {me.nodes.length === 0 ? (
          <Empty>
            No nodes yet. Run <code className="mono">ramx-node init</code> on your laptop and open the link it prints. Your laptop then earns credits for every request it serves.
          </Empty>
        ) : (
          <NodesTable me={me} listings={nodes} />
        )}
        <p className="faint table-note">
          Accounts start with {START_NODE_CAP} nodes. The cap rises to {PROVEN_NODE_CAP} after {inc.proven_after_days} days with an Orb or Passport login, every node at reliability {inc.proven_min_reliability} or more, and {inc.proven_min_requests} good requests.
          {me.incentives.credential === "selfie" && " Selfie Check accounts stay at the start cap."}
        </p>
      </section>

      <div className="section-gap">
        <JoinGuide open={me.nodes.length === 0} />
      </div>

      <section className="panel section-gap" aria-labelledby="rc-h">
        <div className="panel-head">
          <h2 id="rc-h" className="section-title">
            Recent requests
          </h2>
          <button className="text-link" onClick={() => navigate("/chat")}>
            Open the playground <Icon name="arrow" size={13} />
          </button>
        </div>
        {receipts.error instanceof SessionExpired ? (
          <ErrorBox error={receipts.error} />
        ) : receipts.error && !receipts.data ? (
          <ErrorBox error={receipts.error} retry={receipts.reload} />
        ) : !receipts.data ? (
          <Loading h={120} />
        ) : receipts.data.length === 0 ? (
          <Empty>No requests yet. Spend your credits on any pool in the playground.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Model</th>
                  <th className="num">Stages</th>
                  <th className="num">Tokens in / out</th>
                  <th className="num">Cost</th>
                  <th>Ledger</th>
                </tr>
              </thead>
              <tbody>
                {receipts.data.map((rc) => (
                  <tr
                    key={rc.req_id}
                    tabIndex={0}
                    onClick={() => setSheet(rc)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      setSheet(rc);
                    }}
                    aria-label={`Open receipt ${rc.req_id}`}
                  >
                    <td>{fmtAgo(rc.ts, now)}</td>
                    <td className="mono">{rc.model.split("/")[1] ?? rc.model}</td>
                    <td className="num mono">{rc.route.length || "—"}</td>
                    <td className="num mono">
                      {rc.in_tokens} / {rc.out_tokens}
                    </td>
                    <td className="num mono">{rc.status === "ok" ? `${cr(rc.cost)} cr` : <span className="faint">failed · 0</span>}</td>
                    <td>{rc.ledger_seq != null ? <SourceBadge kind="ledger" seq={rc.ledger_seq} href={explorerEvent(env.ledgerContract, rc.ledger_seq)} /> : <span className="faint">pending</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {sheet && <ReceiptSheet receipt={sheet} nodes={nodes} onClose={() => setSheet(null)} />}
    </>
  );
}
