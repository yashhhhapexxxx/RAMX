import { useState } from "react";
import type { FormEvent } from "react";
import { Icon } from "../Icon";
import { ErrorBox, Busy } from "../console/Status";
import { useSession } from "../../auth/context";
import { providerApi } from "../../data/provider";

export default function ProviderForm({ mode, models, done }: { mode: "create" | "join"; models: { model_id: string; size_gb: number }[]; done: () => void }) {
  const session = useSession();
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState("");
  const payout = address || session.me?.payout_address || "";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(null);
    try {
      if (mode === "create") await providerApi.create(session.token!, { name: String(form.get("name")), model: String(form.get("model")), expected_members: Number(form.get("count")), payout_address: payout });
      else await providerApi.join(session.token!, { pool_id: String(form.get("pool")).trim(), payout_address: payout });
      done();
    } catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }
  return <form id="provider-form" className="provider-form panel" onSubmit={submit}>
    <div className="provider-section-label"><span className="mono-label">01 / YOUR {mode === "create" ? "POOL" : "INVITATION"}</span><span className="pill pill-ok"><Icon name="user-check" size={12} /> World verified</span></div>
    <h2>{mode === "create" ? "Make room for a bigger model." : "Bring your laptop to the pool."}</h2>
    {mode === "create" ? <div className="provider-fields">
      <label>Pool name<input name="name" autoFocus required maxLength={60} placeholder="Friday GPU crew" autoComplete="off" /></label>
      <label>Model<select name="model" required defaultValue={models.find(m => m.model_id.includes("14B"))?.model_id ?? models[0]?.model_id}>{models.map(m => <option key={m.model_id} value={m.model_id}>{m.model_id} · {m.size_gb} GB</option>)}</select></label>
      <label>Laptops in this pool<input name="count" type="number" required min={2} max={16} defaultValue={4} /><span className="faint">Include this coordinator. Start when everyone is prepared.</span></label>
    </div> : <label>Pool ID<input name="pool" autoFocus required placeholder="pool_…" autoComplete="off" spellCheck={false} /><span className="faint">Ask the coordinator for their Pool ID. They approve new members.</span></label>}
    <div className="provider-payout"><label>Your NEAR payout account<input value={payout} onChange={e => setAddress(e.target.value.trim())} required pattern="(([a-z\d]+[\-_])*[a-z\d]+\.)*([a-z\d]+[\-_])*[a-z\d]+" minLength={2} maxLength={64} placeholder="you.testnet" spellCheck={false} autoComplete="off" /><span className="faint">Serving earns USDC: requests paid with x402 are paid out to laptop owners each epoch on NEAR testnet. Each owner claims their own share to this NEAR account (register it on the USDC contract first).</span></label></div>
    {error && <ErrorBox title={mode === "create" ? "Couldn't create the pool" : "Couldn't send your request"} error={error} hint="Nothing was saved. Fix the field above or try again." />}
    <button className="button button-blue" type="submit" disabled={busy || (mode === "create" && !models.length)}>{busy ? <Busy>Saving…</Busy> : mode === "create" ? "Create pool" : "Request to join"}<Icon name="arrow" size={15} /></button>
  </form>;
}
