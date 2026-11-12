/* /ledger (spec §12): the gateway's signed ledger events (GET /ledger/events), each also appended
   to the ledger contract on NEAR (§10.2). Opening a row shows the payload and checks on NEAR RPC
   that the event is on the contract. */
import { Fragment, useState } from "react";
import type { LedgerEvent, LedgerType } from "@shared/types";
import { PageHead } from "../components/ConsoleShell";
import SourceBadge from "../components/SourceBadge";
import { CodeBox } from "../components/console/CopyButton";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading, Busy } from "../components/console/Status";
import { api } from "../data";

import { useAsync } from "../hooks/useAsync";
import { useLedger, useNow } from "../hooks/usePool";
import { env } from "../config/env";
import { explorerEvent, explorerLedger } from "../lib/links";
import { fmtAgo, fmtUsdc, fmtNum, fmtTime, shortHash } from "../lib/format";
import { navigate } from "../lib/router";

const PAGE = 25;
/** Filterable types. Verification, hardware challenges and fraud penalties (SPEC §16.2, §8.8) are disabled,
    so they are not offered as a filter; summary() still renders them if one ever appears. */
const TYPES: LedgerType[] = [
  "account_created",
  "starter_grant",
  "request_settled",
  "availability_reward",
  "x402_payment",
  "credits_expired",
  "payout_address_set",
  "epoch_closed",
  "payout_claimed",
  "agent_key_created",
  "credits_purchased",
];
const PILL: Partial<Record<LedgerType, string>> = { credits_purchased: "pill-ok", request_settled: "pill-ok", payout_claimed: "pill-ok", availability_reward: "pill-ok", x402_payment: "pill-warn", credits_expired: "pill-bad", credits_clawed_back: "pill-bad", account_banned: "pill-bad" };
const topic = env.ledgerContract;

const str = (v: unknown) => (v == null ? "" : String(v));
const num = (v: unknown) => Number(v ?? 0);
const cr = (mc: unknown, d = 1) => fmtNum(num(mc) / 1000, d);
const model = (v: unknown) => str(v).split("/")[1] ?? str(v);

/** One line per event type, from its payload (shared ledger event schemas). */
function summary(e: LedgerEvent): string {
  const p = e.payload;
  switch (e.type) {
    case "account_created":
      return "new account · World ID or NEAR wallet";
    case "starter_grant":
      return `+${cr(p.amount_mc, 0)} starter credits · 14 days`;
    case "request_settled": {
      const split = (p.split ?? {}) as { nodes?: Record<string, number>; burn_mc?: number; reserve_mc?: number };
      const nodes = Object.values(split.nodes ?? {});
      const paid = nodes.reduce((a, b) => a + b, 0);
      return `${cr(p.cost_mc)} cr · ${model(p.model)} · ${nodes.length} ${nodes.length === 1 ? "node" : "nodes"} earned ${cr(paid)} · burn ${cr(split.burn_mc)} · reserve ${cr(split.reserve_mc)}`;
    }
    case "availability_reward":
      return `+${cr(p.amount_mc)} cr standby reward · node ${shortHash(str(p.node_id), 6, 4)}`;
    case "x402_payment":
      return `${fmtUsdc(str(p.amount_units) || "0")} · ${model(p.model)} · ${Array.isArray(p.route) ? `${p.route.length} stages` : "route unknown"}`;
    case "credits_expired":
      return `−${cr(p.amount_mc)} ${str(p.kind) || "starter"} credits expired`;
    case "payout_address_set":
      return `payout → ${shortHash(str(p.payout_address), 6, 4)}`;
    case "epoch_closed":
      return `epoch ${str(p.epoch)} · ${fmtUsdc(str(p.total_units) || "0")} · ${Array.isArray(p.payouts) ? `${p.payouts.length} payouts` : "payout list kept by the gateway"}`;
    case "payout_claimed":
      return `epoch ${str(p.epoch)} · ${fmtUsdc(str(p.amount_units) || "0")} claimed`;
    case "agent_key_created":
      return `API key ${str(p.agent_id)} · ${p.budget_mc == null ? "no cap" : `cap ${cr(p.budget_mc, 0)} cr`}`;
    case "credits_purchased":
      return `+${cr(p.amount_mc)} cr bought for API key ${str(p.agent_id)} · ${fmtUsdc(str(p.amount_units) || "0")}`;
    case "hardware_challenge":
      return `hardware check ${str(p.result)} · node ${shortHash(str(p.node_id), 6, 4)}`;
    case "credits_clawed_back":
      return `−${cr(p.amount_mc)} vesting credits to the reserve`;
    case "account_banned":
      return "account banned from running nodes";
    default:
      return `${e.type.replace(/_/g, " ")} (verification is disabled)`;
  }
}
const who = (e: LedgerEvent) => str(e.payload.account_id) || str(e.payload.payer) || str(e.payload.payout_address);

function MirrorCheck({ seq }: { seq: number | null }) {
  const check = useAsync(() => (seq != null && topic ? api.onChain(topic, seq) : Promise.resolve(null)), [seq]);
  if (seq == null) return <span className="faint">Not on the ledger contract yet. The gateway appends events after the request, without blocking it.</span>;
  if (!topic) return <span className="faint">No ledger contract is set (VITE_LEDGER_CONTRACT).</span>;
  if (check.loading) return <span className="faint"><Busy>Checking NEAR…</Busy></span>;
  if (check.error) return <span className="mirror-bad">NEAR check failed: {check.error.message}</span>;
  return check.data?.found ? (
    <span className="mirror-ok">
      ✓ on {topic} #{seq}
      {check.data.on_chain_seq != null && <span className="faint"> · contract is at #{check.data.on_chain_seq}</span>}
    </span>
  ) : (
    <span className="faint">Not on the ledger contract yet (#{seq} not appended).</span>
  );
}

export default function Ledger({ query }: { query: URLSearchParams }) {
  const q = query.get("type");
  const type = TYPES.includes(q as LedgerType) ? (q as LedgerType) : undefined;
  const ledger = useLedger(type);
  const now = useNow(5000);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  const rows = ledger.data ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const p = Math.min(page, pages - 1);
  const shown = rows.slice(p * PAGE, p * PAGE + PAGE);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));

  return (
    <>
      <PageHead
        label="LEDGER · NEAR"
        title="Every credit, on the record."
        sub="Every credit earned, spent, burned or expired, signed by the gateway and appended to one public NEAR ledger contract. Anyone can rebuild the balances from it and check each signature."
        aside={
          <span className="ledger-topic">
            <span className="faint">contract</span> <span className="mono">{topic || "not set"}</span> <SourceBadge kind="explorer" href={explorerLedger(topic)} />
          </span>
        }
      />
      <section className="panel">
        <div className="panel-head">
          <span className="faint">{rows.length ? `${rows.length} events, newest first` : " "}</span>
          <label className="filters">
            <span className="sr-only">Event type</span>
            <select
              className="select"
              value={type ?? "all"}
              onChange={(e) => {
                setPage(0);
                setOpen(null);
                navigate(e.target.value === "all" ? "/ledger" : `/ledger?type=${e.target.value}`, { replace: true });
              }}
            >
              <option value="all">All events</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        {ledger.error && !ledger.data ? (
          <ErrorBox error={ledger.error} retry={ledger.reload} />
        ) : !ledger.data ? (
          <Loading h={360} />
        ) : shown.length === 0 ? (
          <Empty>No {type ?? ""} events yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-click ledger-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Event</th>
                  <th>Account</th>
                  <th>On chain</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <Fragment key={e.id}>
                    <tr className={open === e.id ? "is-open" : undefined} onClick={() => toggle(e.id)}>
                      <td className="nowrap">
                        <button
                          className="row-toggle"
                          aria-expanded={open === e.id}
                          aria-controls={`ev-${e.id}`}
                          title={fmtTime(e.ts)}
                          onClick={(x) => {
                            x.stopPropagation();
                            toggle(e.id);
                          }}
                        >
                          <Icon name="chevron" size={11} /> {fmtAgo(e.ts, now)}
                        </button>
                      </td>
                      <td>
                        <span className={`pill ${PILL[e.type] ?? "pill-idle"} mono`}>{e.type}</span>
                      </td>
                      <td>{summary(e)}</td>
                      <td className="mono nowrap">{who(e) ? shortHash(who(e), 8, 4) : "—"}</td>
                      <td onClick={(x) => x.stopPropagation()}>{e.ledger_seq != null ? <SourceBadge kind="ledger" seq={e.ledger_seq} href={explorerEvent(topic, e.ledger_seq)} /> : <span className="faint">pending</span>}</td>
                    </tr>
                    {open === e.id && (
                      <tr className="ledger-detail" id={`ev-${e.id}`}>
                        <td colSpan={5}>
                          <div className="ledger-detail-body">
                            <MirrorCheck seq={e.ledger_seq} />
                            <CodeBox code={JSON.stringify({ type: e.type, ...e.payload, gateway_sig: shortHash(e.gateway_sig, 10, 6) }, null, 2)} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > PAGE && (
          <div className="pager">
            <button className="button button-ghost button-sm" disabled={p === 0} onClick={() => setPage(p - 1)}>
              Newer
            </button>
            <span className="faint">
              {p * PAGE + 1}–{Math.min(rows.length, (p + 1) * PAGE)} of {rows.length}
            </span>
            <button className="button button-ghost button-sm" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>
              Older
            </button>
          </div>
        )}
      </section>
    </>
  );
}
