/* /payouts (spec §12, §10.5): the USDC side of earning. AI agents pay per request with x402 in USDC
   on NEAR; each epoch the providers' 80% is split by layers served and posted to the payout contract
   as a Merkle root (funded in the same ft_transfer_call). This account's leaves come from
   GET /payouts/:account; closed epochs come from the signed epoch_closed events on the ledger.
   Claim = `claim(epoch, amount, proof)` on the payout contract, signed by the payout account. */
import { useState } from "react";
import { NearAccountId } from "@ramx/shared";
import type { Payout } from "@shared/types";
import { PageHead } from "../components/ConsoleShell";
import SourceBadge from "../components/SourceBadge";
import CopyButton from "../components/console/CopyButton";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading } from "../components/console/Status";

import { useLedger, usePayouts, useNow } from "../hooks/usePool";
import { env } from "../config/env";
import { explorerContract, explorerTx } from "../lib/links";
import { fmtUsdc, fmtLeft, fmtTime, shortHash } from "../lib/format";
import { explorerEvent } from "../lib/links";
import { navigate } from "../lib/router";

const ACCOUNT_KEY = "ramx.payout-account.v1";
const remembered = () => { try { return localStorage.getItem(ACCOUNT_KEY) ?? ""; } catch { return ""; } };

/** near-cli-rs command that claims one epoch, signed by the payout account (USDC goes to it). */
export const claimCommand = (contract: string, account: string, p: Payout) =>
  `near contract call-function as-transaction ${contract} claim json-args '${JSON.stringify({ epoch: p.epoch, amount: p.amount_units, proof: p.proof })}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as ${account} network-config testnet sign-with-keychain send`;

function AccountGate({ onSet }: { onSet: (account: string) => void }) {
  const [value, setValue] = useState(remembered());
  const valid = NearAccountId.safeParse(value.trim()).success;
  return (
    <section className="panel tile login-tile" aria-labelledby="wg-h">
      <span className="mono-label">
        <Icon name="wallet" size={12} /> NEAR testnet
      </span>
      <h2 id="wg-h">Which NEAR account gets your payouts?</h2>
      <p className="muted">Payouts go to the NEAR account you set for your nodes. Enter it to see your epochs and claim your USDC.</p>
      <form className="tile-actions" onSubmit={(e) => { e.preventDefault(); if (valid) onSet(value.trim()); }}>
        <input className="input mono" placeholder="you.testnet" value={value} onChange={(e) => setValue(e.target.value)} aria-label="NEAR payout account" spellCheck={false} />
        <button className="button button-blue" type="submit" disabled={!valid}>Show payouts</button>
      </form>
    </section>
  );
}

export default function Payouts() {
  const [account, setAccount] = useState(() => (NearAccountId.safeParse(remembered()).success ? remembered() : ""));
  const data = usePayouts(account || undefined);
  const now = useNow(1000);
  const choose = (a: string) => { try { localStorage.setItem(ACCOUNT_KEY, a); } catch { /* private window */ } setAccount(a); };

  const closed = useLedger("epoch_closed");
  const epochs = (closed.data ?? []).map((e) => ({
    epoch: Number(e.payload.epoch),
    start_ts: Number(e.payload.start_ts),
    end_ts: Number(e.payload.end_ts),
    total_units: String(e.payload.total_units ?? "0"),
    merkle_root: String(e.payload.merkle_root ?? ""),
    payouts: Array.isArray(e.payload.payouts) ? e.payload.payouts.length : null,
    ledger_seq: e.ledger_seq,
  }));
  const mine = data.data?.payouts ?? [];
  const last = epochs[0];
  const claimable = mine.filter((p) => !p.claimed && p.claimable === true && !p.swept);
  const claimed = mine.filter((p) => p.claimed);
  const totalClaimable = claimable.reduce((s, p) => s + BigInt(p.amount_units), 0n);

  return (
    <>
      <PageHead
        label="PAYOUTS · NEAR"
        title="Get paid in USDC on NEAR."
        sub="Credits pay for account requests. AI agents pay with x402 in USDC on NEAR instead. When an epoch closes, 80% of that income goes to the laptops that served it, by layers served, and each owner claims with a Merkle proof."
        aside={
          <span className="ledger-topic">
            <span className="faint">contract</span> <span className="mono">{env.payoutAddr ? shortHash(env.payoutAddr, 6, 4) : "not set"}</span> <SourceBadge kind="explorer" href={explorerContract(env.payoutAddr)} />
          </span>
        }
      />

      {!account ? (
        <AccountGate onSet={choose} />
      ) : data.error && !data.data ? (
        <ErrorBox error={data.error} retry={data.reload} />
      ) : !data.data ? (
        <Loading h={240} />
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <span className="mono-label">Last closed epoch</span>
              <p className="stat-value">{last ? `#${last.epoch}` : "—"}</p>
              <p className="stat-note">{last ? `${fmtUsdc(last.total_units)} to providers` : "none on the ledger yet"}</p>
            </div>
            <div className="stat">
              <span className="mono-label">Claimable</span>
              <p className="stat-value">{fmtUsdc(totalClaimable.toString())}</p>
              <p className="stat-note">
                {claimable.length} posted epoch{claimable.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="stat">
              <span className="mono-label">Payout account</span>
              <p className="stat-value mono payout-wallet" title={account}>{account.length > 22 ? shortHash(account, 10, 8) : account}</p>
              <p className="stat-note">
                NEAR testnet · <button className="text-link inline-link" onClick={() => setAccount("")}>change</button>
              </p>
            </div>
          </div>

          <section className="panel section-gap" aria-labelledby="claim-h">
            <div className="panel-head">
              <h2 id="claim-h" className="section-title">
                Your payouts
              </h2>
              <span className="faint">claim(epoch, amount, proof) · signed by your payout account</span>
            </div>
            {mine.length === 0 ? (
              <Empty>No payouts for this account yet. Payouts come from x402 requests that your nodes served.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Epoch</th>
                      <th className="num">Amount</th>
                      <th>Proof</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...mine]
                      .sort((a, b) => b.epoch - a.epoch)
                      .map((p) => {
                        const tx = p.claim_tx;
                        const posted = p.claimable === true && !p.swept;
                        return (
                          <tr key={p.epoch}>
                            <td className="mono">#{p.epoch}</td>
                            <td className="num mono">{fmtUsdc(p.amount_units)}</td>
                            <td className="mono faint">{p.proof.length} hashes</td>
                            <td>
                              {p.claimed ? (
                                <span className="row wrap">
                                  <span className="pill pill-ok">claimed</span>
                                  {tx && <SourceBadge kind="explorer" href={explorerTx(tx)} title={tx} />}
                                </span>
                              ) : posted ? (
                                <span className="row wrap">
                                  <span className="pill">claim {fmtUsdc(p.amount_units)}</span>
                                  <CopyButton text={claimCommand(env.payoutAddr || "payout.ramx.testnet", account, p)} compact />
                                </span>
                              ) : p.swept ? (
                                <span className="faint">swept back to the treasury</span>
                              ) : p.claimable_at ? (
                                <span className="faint">claimable in {fmtLeft(p.claimable_at, now)}</span>
                              ) : (
                                <span className="faint">waiting for the root</span>
                              )}
                              {p.post_tx && <SourceBadge kind="explorer" href={explorerTx(p.post_tx)} title={`ft_transfer_call ${p.post_tx}`} />}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
            {claimed.length > 0 && <p className="faint table-note">{claimed.length} claimed. Each claim is also a ledger event (payout_claimed).</p>}
          </section>


        </>
      )}

      <details className="panel section-gap payout-tech">
        <summary className="panel-head">
          <h2 id="epochs-h" className="section-title">
            Technical details: epochs and Merkle roots
          </h2>
          <span className="faint">from epoch_closed events on the NEAR ledger</span>
        </summary>
        {closed.error && !closed.data ? (
          <ErrorBox error={closed.error} retry={closed.reload} />
        ) : !closed.data ? (
          <Loading h={120} />
        ) : epochs.length === 0 ? (
          <Empty>No epoch has closed in the recent ledger events.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Epoch</th>
                  <th>Window</th>
                  <th className="num">To providers</th>
                  <th className="num">Payouts</th>
                  <th>Merkle root</th>
                  <th>Ledger</th>
                </tr>
              </thead>
              <tbody>
                {epochs.map((e) => (
                  <tr key={e.epoch}>
                    <td className="mono">#{e.epoch}</td>
                    <td className="nowrap">
                      {fmtTime(e.start_ts).slice(0, 5)}–{fmtTime(e.end_ts).slice(0, 5)}
                    </td>
                    <td className="num mono">{fmtUsdc(e.total_units)}</td>
                    <td className="num mono">{e.payouts ?? "—"}</td>
                    <td>
                      {e.merkle_root ? (
                        <span className="row">
                          <span className="mono">{shortHash(e.merkle_root, 8, 6)}</span>
                          <CopyButton text={e.merkle_root} compact />
                        </span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>{e.ledger_seq != null ? <SourceBadge kind="ledger" seq={e.ledger_seq} href={explorerEvent(env.ledgerContract, e.ledger_seq)} /> : <span className="faint">pending</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint table-note">
          The settler posts and funds each root. Anyone can compare it with the epoch_closed event on the ledger contract.{" "}
          <button className="text-link inline-link" onClick={() => navigate("/ledger?type=epoch_closed")}>
            See epoch_closed events <Icon name="arrow" size={12} />
          </button>
        </p>
      </details>
    </>
  );
}
