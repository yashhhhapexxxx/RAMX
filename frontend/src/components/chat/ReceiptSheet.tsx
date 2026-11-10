import type { NodeListing, Receipt } from "@shared/types";
import { Sheet } from "../Shared";
import { useSession } from "../../auth/context";
import SourceBadge from "../SourceBadge";
import CopyButton, { CodeBox } from "../console/CopyButton";
import { explorerEvent, explorerTx } from "../../lib/links";
import { env } from "../../config/env";
import { fmtUsdc, fmtLayers, fmtNum, fmtTime, gpuShort, nodeName, shortHash } from "../../lib/format";

const HASH_KEYS = new Set(["resp_hash", "prompt_hash", "x402_tx", "x402_payer"]);
const cr = (n: number) => `${fmtNum(n, 1)} cr`;

/** One request receipt (spec §5.3, §8.3). Hashes are shortened in the JSON view; Copy gives the exact JSON. */
export default function ReceiptSheet({ receipt, nodes, onClose }: { receipt: Receipt; nodes: NodeListing[]; onClose: () => void }) {
  const find = (id: string) => nodes.find((n) => n.node_id === id);
  const name = (id: string) => nodeName(find(id), id);
  const view = JSON.stringify(
    receipt,
    (k, v) => (typeof v === "string" && (HASH_KEYS.has(k) || k === "node_id") ? shortHash(v, 8, 6) : v),
    2,
  )
    // keep [start, end] layer ranges on one line
    .replace(/\[\s+(\d+),\s+(\d+)\s+\]/g, "[$1, $2]");
  const paid = receipt.pay_type === "x402" ? `${fmtUsdc(receipt.x402_amount ?? "0")} (x402)` : cr(receipt.cost);
  const s = receipt.split;
  const session = useSession();
  const myNodes = new Set((session.me?.nodes ?? []).map((n) => n.node_id.toLowerCase()));
  const toNodes = s ? s.nodes.reduce((sum, n) => sum + n.credits, 0) : 0;
  const mineEarned = s ? s.nodes.filter((n) => !n.self && myNodes.has(n.node_id.toLowerCase())).reduce((sum, n) => sum + n.credits, 0) : 0;

  return (
    <Sheet title="Receipt" onClose={onClose}>
      <div className="receipt-sheet">
        <dl className="kv">
          <dt>Model</dt>
          <dd className="mono">{receipt.model.split("/")[1] ?? receipt.model}</dd>
          <dt>Status</dt>
          <dd>{receipt.status === "ok" ? "settled" : receipt.status === "pending" ? "pending" : receipt.pay_type === "x402" && receipt.x402_tx ? "failed · payment settled before inference" : "failed · no credits charged"}</dd>
          <dt>Tokens</dt>
          <dd>
            {receipt.in_tokens} in / {receipt.out_tokens} out
          </dd>
          <dt>Paid</dt>
          <dd>
            {paid}
            {receipt.price_multiplier != null && <span className="faint"> · {receipt.price_multiplier}× price, locked at start</span>}
          </dd>
          <dt>Time</dt>
          <dd>{fmtTime(receipt.ts)}</dd>
          <dt>Ledger</dt>
          <dd>{receipt.ledger_seq != null ? <SourceBadge kind="ledger" seq={receipt.ledger_seq} href={explorerEvent(env.ledgerContract, receipt.ledger_seq)} /> : <span className="faint">not on the ledger yet</span>}{" "}<a className="text-link" href="/ledger">View in network activity</a></dd>
          {receipt.x402_tx && (
            <>
              <dt>Payment</dt>
              <dd>
                <SourceBadge kind="explorer" href={explorerTx(receipt.x402_tx)} title={receipt.x402_tx} />
              </dd>
            </>
          )}
        </dl>

        <div>
          <span className="mono-label">Route</span>
          <ol className="receipt-route">
            {receipt.route.map((h) => {
              const n = find(h.node_id);
              return (
                <li key={h.node_id}>
                  <span>{name(h.node_id)}</span>
                  <span className="mono faint">
                    {n ? gpuShort(n.gpu) : ""} {fmtLayers(h.layers)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        {s && (
          <div className="receipt-earned" role="status">
            <span className="mono-label">Contributor earnings</span>
            <p>
              <b>{cr(toNodes)}</b> went to the {s.nodes.length} {s.nodes.length === 1 ? "laptop" : "laptops"} that served this request, by layers served.
              {mineEarned > 0 && (
                <>
                  {" "}Your laptop earned <b>{cr(mineEarned)}</b>.{" "}
                  <a className="text-link" href="/account">See your earnings</a>
                </>
              )}
            </p>
          </div>
        )}

        {s && (
          <div>
            <span className="mono-label">Split · 90% by layers, 5% burn, 5% reserve</span>
            <div className="table-wrap">
              <table className="table table-compact split-table">
                <thead>
                  <tr>
                    <th>Node</th>
                    <th className="num">Layers</th>
                    <th className="num">Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {s.nodes.map((n) => (
                    <tr key={n.node_id}>
                      <td>{name(n.node_id)}</td>
                      <td className="num mono">{n.layers}</td>
                      <td className="num mono">{n.self ? <span className="faint">0 · own node → reserve</span> : cr(n.credits)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>Burn</td>
                    <td />
                    <td className="num mono">{cr(s.burn)}</td>
                  </tr>
                  <tr>
                    <td>Reserve</td>
                    <td />
                    <td className="num mono">{cr(s.reserve)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {receipt.tee_check && (
          <div className="receipt-tee">
            <span className="mono-label">TEE spot-check</span>
            {receipt.tee_check.status === "done" ? (
              <dl className="kv">
                <dt>Verdict</dt>
                <dd>
                  <span className={`pill ${receipt.tee_check.verdict === "plausible" ? "pill-ok" : receipt.tee_check.verdict === "implausible" ? "pill-bad" : "pill-warn"}`}>
                    {receipt.tee_check.verdict === "plausible" ? "Plausible ✓" : receipt.tee_check.verdict === "implausible" ? "Implausible" : "Unclear"}
                  </span>{" "}
                  {receipt.tee_check.reason}
                </dd>
                <dt>Judge</dt>
                <dd className="mono">{receipt.tee_check.judge_model} (NEAR AI Cloud TEE)</dd>
                <dt>Attested key</dt>
                <dd className="mono">{shortHash(receipt.tee_check.signing_address, 10, 6)}</dd>
                <dt>Signature</dt>
                <dd>{receipt.tee_check.signature_ok ? "valid: recovers to the attested key" : "NOT valid"}{receipt.tee_check.hashes_match ? ", covers our exact request and reply" : ""}</dd>
                <dt>Attestation</dt>
                <dd className="mono">{shortHash(receipt.tee_check.attestation_sha256, 10, 6)} (fresh nonce {shortHash(receipt.tee_check.nonce, 6, 4)})</dd>
              </dl>
            ) : receipt.tee_check.status === "queued" ? (
              <p className="faint">Sampled for a check; the judge runs within a minute.</p>
            ) : (
              <p className="faint">Check could not run: {receipt.tee_check.error}</p>
            )}
            <p className="faint">A plausibility check of the answer by a model in secure hardware, not proof that the pool ran the model correctly.</p>
          </div>
        )}

        <details className="receipt-tech">
          <summary className="text-link">Technical details</summary>
          <dl className="kv">
            <dt>Request</dt>
            <dd className="mono">{shortHash(receipt.req_id, 10, 4)}</dd>
            <dt>Prompt hash</dt>
            <dd className="mono">{shortHash(receipt.prompt_hash, 10, 6)}</dd>
            <dt>Reply hash</dt>
            <dd className="mono">{shortHash(receipt.resp_hash, 10, 6)}</dd>
          </dl>
          <span className="mono-label">JSON</span>
          <CodeBox code={view} copy={false} />
          <div className="receipt-copy">
            <CopyButton text={JSON.stringify(receipt, null, 2)} label="Copy full JSON" />
          </div>
        </details>
        <p className="faint">The NEAR ledger holds hashes of your prompt and the reply, never the text. The gateway keeps the text for 7 days, then deletes it.</p>
      </div>
    </Sheet>
  );
}
