/* USDC top-up from a NEAR wallet (Phase 5.1): send testnet USDC to the treasury with
   `ft_transfer(memo = your account id)`, then paste the transaction hash. The gateway reads the
   transaction on NEAR RPC and credits it once (1 USDC = 1000 credits, never expire). */
import { useState } from "react";
import { NearAccountId } from "@ramx/shared";
import { api } from "../../data";
import { env } from "../../config/env";
import CopyButton, { CodeBox } from "./CopyButton";

export default function UsdcTopup({ token, accountId, onDone }: { token: string; accountId: string; onDone: () => void }) {
  const [sender, setSender] = useState("");
  const [tx, setTx] = useState("");
  const [usdc, setUsdc] = useState("1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const units = /^\d+(\.\d{1,6})?$/.test(usdc) ? String(Math.round(Number(usdc) * 1e6)) : "1000000";
  const from = NearAccountId.safeParse(sender.trim()).success ? sender.trim() : "<you>.testnet";
  const command = `near contract call-function as-transaction ${env.usdc} ft_transfer json-args '${JSON.stringify({ receiver_id: env.treasury, amount: units, memo: accountId })}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${from} network-config testnet sign-with-keychain send`;
  const valid = NearAccountId.safeParse(sender.trim()).success && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(tx.trim());

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.nearTopup(token, { tx_hash: tx.trim(), sender: sender.trim() });
      setMsg({ ok: true, text: `+${r.added.toLocaleString("en-US")} credits` });
      setTx("");
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="topup">
      <p className="muted">1. Send testnet USDC to <span className="mono">{env.treasury}</span> with your account id as the memo (1 USDC = 1,000 credits; they never expire). Get testnet USDC at faucet.circle.com (NEAR Testnet).</p>
      <div className="tile-actions">
        <input className="input mono" placeholder="you.testnet" value={sender} onChange={(e) => setSender(e.target.value)} aria-label="Your NEAR account" spellCheck={false} />
        <input className="input mono" style={{ maxWidth: 110 }} value={usdc} onChange={(e) => setUsdc(e.target.value)} aria-label="USDC amount" />
      </div>
      <CodeBox code={command} copy={false} />
      <CopyButton text={command} label="Copy command" />
      <p className="muted">2. Paste the transaction hash.</p>
      <form className="tile-actions" onSubmit={(e) => { e.preventDefault(); if (valid) void submit(); }}>
        <input className="input mono" placeholder="transaction hash" value={tx} onChange={(e) => setTx(e.target.value)} aria-label="Transaction hash" spellCheck={false} />
        <button className="button button-blue" type="submit" disabled={!valid || busy}>{busy ? "Checking…" : "Add credits"}</button>
      </form>
      {msg && <p className={msg.ok ? "ok-text" : "bad-text"} role="status">{msg.text}</p>}
    </div>
  );
}
