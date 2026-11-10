import { useEffect, useState } from "react";
import type { ProviderPool } from "@ramx/shared";
import { Icon } from "../Icon";
import CopyButton, { CodeBox } from "../console/CopyButton";
import { ErrorBox, Busy, Success } from "../console/Status";
import { usePoolAvailability } from "../../hooks/usePool";
import { useSession } from "../../auth/context";
import { providerApi } from "../../data/provider";
import { shortHash, fmtAgo, fmtLeft, fmtNum, gpuShort } from "../../lib/format";
import { navigate } from "../../lib/router";

const stages: Record<string, string> = { waiting: "Waiting", installing: "Installing", downloading: "Downloading", prepared: "Prepared", starting: "Loading layers", online: "Connected", error: "Needs attention", stopped: "Stopped" };
const bytes = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
export default function PoolSetup({ pool, refresh, sizeGb }: { pool: ProviderPool; refresh: () => void; sizeGb?: number }) {
  const session = useSession();
  const availability = usePoolAvailability(pool.pool_id, pool.model);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 3000);
    return () => window.clearInterval(timer);
  }, []);
  const own = pool.members.find(m => m.account_id === session.me?.account_id);
  const coordinator = pool.owner_account === session.me?.account_id;
  const [command, setCommand] = useState<{ command: string; expires_at: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(null), 6000);
    return () => window.clearTimeout(t);
  }, [done]);
  const doneText = (path: string) => path.endsWith("/approve") ? "Member approved. Their install command is now available to them." : path.endsWith("/revoke") ? "Member removed from the pool." : path === "stop" ? "Pool stopped. Helpers disconnect; restart it when you're ready." : "Restart requested. Laptops reconnect and reload the model.";
  async function action(path: string) {
    setBusy(true); setError(null); setDone(null);
    try { await providerApi.manage(session.token!, pool.pool_id, path); setDone(doneText(path)); refresh(); }
    catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }
  async function enroll() {
    setBusy(true); setError(null); setDone(null);
    try { setCommand(await providerApi.enroll(session.token!, pool.pool_id)); setDone("Install command ready. Run it in Terminal on this laptop."); }
    catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }
  const approved = pool.members.filter(m => m.approved);
  const online = approved.filter(m => m.online).length;
  const available = availability.data?.available === true;
  const ownOnline = !!own?.approved && own.online;
  const serving = ownOnline && available;
  const me = session.me;
  const machine = (m: { gpu: string | null }) => (m.gpu ? gpuShort(m.gpu) : "Your laptop");
  const prepared = (stage: string) => stage === "prepared" || stage === "starting" || stage === "online";

  // Setup progression: what is done, what is happening, who acts next.
  const steps = ["Verify identity", "Join or create pool", "Connect laptop", "Prepare model", "Serve"];
  const others = approved.filter(m => m.id !== own?.id && !prepared(m.stage));
  const next: { step: number; title: string; body: string; who: string } =
    !own?.approved ? { step: 1, title: "Waiting for coordinator approval", body: "Your request was sent. Installation becomes available after approval.", who: "The coordinator" }
    : pool.state === "stopped" ? { step: 4, title: "Pool stopped", body: "The coordinator must restart this pool before laptops can reconnect.", who: coordinator ? "You (coordinator)" : "The coordinator" }
    : own.stage === "error" ? { step: 3, title: "Your laptop needs attention", body: own.message || "The helper reported an error. Generate a new command and run it again.", who: "You" }
    : !own.node_id && own.stage === "waiting" ? { step: 2, title: "Connect this laptop", body: "Get the install command below and run it in Terminal on the laptop you want to contribute.", who: "You" }
    : !prepared(own.stage) ? { step: 3, title: own.stage === "downloading" ? "Downloading the model" : "Your helper is installing", body: own.message || "Keep Terminal open. Progress updates here every few seconds.", who: "Your helper (no action needed)" }
    : others.length ? { step: 3, title: "Your laptop is ready", body: `Waiting for ${others.length} other ${others.length === 1 ? "member" : "members"} to finish preparing the model.`, who: "Other members" }
    : approved.length < pool.expected_members ? { step: 3, title: "Your laptop is ready", body: `${approved.length} of ${pool.expected_members} laptops approved. Waiting for the rest to join and be approved.`, who: coordinator ? "You (approve members)" : "The coordinator" }
    : !available ? { step: 4, title: pool.state === "starting" ? "Loading model layers" : "Almost serving", body: availability.data ? `${availability.data.reason} ${availability.data.action}` : "Checking whether the gateway can route requests…", who: "The pool (no action needed)" }
    : { step: 5, title: "Serving", body: "The gateway can route requests to this pool.", who: "" };

  const status = <span role="status" aria-live="polite" className={`pill ${available ? "pill-ok" : pool.state === "stopped" ? "pill-idle" : "pill-warn"}`}>{available ? "Available for requests" : availability.error ? "Availability unknown" : !availability.data ? <Busy size={10}>Checking availability</Busy> : pool.state === "preparing" || pool.state === "starting" ? "Preparing" : "Unavailable"}</span>;

  const connection = <>
    <div className="provider-pool-meta"><div><span className="mono-label">POOL ID</span><div className="provider-id mono">{pool.pool_id}<CopyButton text={pool.pool_id} compact /></div></div><div><span className="mono-label">LAPTOPS</span><p>{approved.length} / {pool.expected_members} approved · {online} connected</p></div></div>
    <p className="faint" role="status">{availability.data ? <>{availability.data.reason} {availability.data.action} Last checked {fmtAgo(availability.data.checked_at, now)}.</> : availability.error ? availability.error.message : <Busy>Checking request availability…</Busy>} <button className="text-link" onClick={availability.reload}>Check again</button> · <a className="text-link" href={`/network`}>View connection details</a></p>
  </>;

  const install = own?.approved && pool.state !== "stopped" && <div className="provider-install">
    <span className="mono-label">CONNECT THIS LAPTOP</span><h3>One command. Your machine stays yours.</h3>
    <ul className="provider-reqs">
      <li><b>Hardware:</b> Apple Silicon macOS or NVIDIA Linux, Python 3.10+.</li>
      <li><b>Network:</b> Ethernet to the other laptops in this pool.</li>
      <li><b>Download:</b> {sizeGb ? `about ${sizeGb} GB for ${pool.model}` : pool.model}, once.</li>
      <li><b>While serving:</b> keep Terminal open. Close it to get your laptop back.</li>
    </ul>
    <p className="muted">The helper installs the software, discovers Ethernet and prepares the model. Approve OS network/developer prompts if requested. Marketplace signing keys stay on the gateway.</p>
    {command ? <><CodeBox code={command.command} /><p className="faint">Single use · expires {new Date(command.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. <button className="text-link" onClick={enroll} disabled={busy}>Generate a new command</button></p></> : <button className="button button-blue" onClick={enroll} disabled={busy}>{busy ? <Busy>Preparing command…</Busy> : own.node_id ? "Reconnect this laptop" : "Get install command"}<Icon name="arrow" size={14} /></button>}
  </div>;

  const members = <>
    <div className="provider-members-head"><span className="mono-label">POOL MEMBERS</span><span className="faint">Updates every 3 seconds</span></div>
    {coordinator && pool.state === "ready" && pool.members.some(m => !m.approved) && <p className="provider-notice">Approving another laptop pauses inference and starts a coordinated rebuild after the new member is prepared.</p>}
    <ol className="provider-members">{pool.members.map(member => {
      const seen = !!member.last_seen && now - member.last_seen < 30_000;
      const percentage = member.bytes_total > 0 ? Math.min(100, member.bytes_done / member.bytes_total * 100) : null;
      const mine = member.account_id === session.me?.account_id;
      return <li key={member.id} className={member.stage === "error" ? "provider-member-error" : ""}>
        <div className={`provider-member-icon ${seen ? "is-connected" : ""}`}><Icon name={member.role === "coordinator" ? "pod" : "laptop"} size={20} /></div>
        <div className="provider-member-info"><strong>{mine ? <>{machine(member)} <span className="pill pill-ok">You</span></> : member.gpu ? `${gpuShort(member.gpu)} · ${shortHash(member.account_id, 5, 3)}` : shortHash(member.account_id, 7, 4)}<span className="faint">{member.role === "coordinator" ? "Coordinator" : "Member"}</span></strong><p>{!member.approved ? "Awaiting coordinator approval" : member.message || "Waiting for the local helper"}</p>
          {member.gpu && <span className="faint">{member.gpu} · {member.mem_gb?.toFixed(1)} GB</span>}
          {percentage !== null && member.stage === "downloading" && <><progress max={100} value={percentage} aria-label="Model transfer progress" /><span className="faint">{bytes(member.bytes_done)} / {bytes(member.bytes_total)}</span></>}
        </div>
        <div className="provider-member-status"><span className={`pill ${member.stage === "error" ? "pill-bad" : member.online ? "pill-ok" : "pill-idle"}`}>{member.approved ? member.last_seen && !seen ? "Disconnected" : member.stage === "online" && !member.online ? "Checking node" : stages[member.stage] : "Approval needed"}</span>{member.last_seen && <span className="faint">{fmtAgo(member.last_seen)}</span>}
          {coordinator && member.role !== "coordinator" && (!member.approved ? <button className="text-link" disabled={busy} onClick={() => action(`members/${member.id}/approve`)}>Approve</button> : <button className="text-link" disabled={busy} onClick={() => action(`members/${member.id}/revoke`)}>Remove</button>)}
        </div>
      </li>;
    })}</ol>
  </>;

  const footer = <div className="provider-pool-footer"><span className="faint">{pool.coordinator_connected ? "Coordinator relay connected" : "Waiting for coordinator helper"}. Parallax assigns the transformer layers.</span>{coordinator && <div className="tile-actions"><button className="button button-ghost button-sm" disabled={busy} onClick={() => action(pool.state === "stopped" ? "restart" : "stop")}>{pool.state === "stopped" ? "Restart pool" : "Stop pool"}</button>{pool.state !== "stopped" && <button className="text-link" disabled={busy} onClick={() => action("restart")}>Retry setup</button>}</div>}</div>;

  if (serving && own) return <section className="panel provider-pool provider-serving" aria-label={`${pool.name}: serving`}>
    <div className="provider-pool-head"><div><span className="mono-label">{coordinator ? "YOUR POOL / COORDINATOR" : "YOUR POOL / MEMBER"}</span><h2>Your laptop is serving</h2><span className="faint">{pool.name} · <span className="mono">{pool.model}</span></span></div>{status}</div>
    <div className="stats provider-serving-stats">
      <div className="stat"><span className="mono-label">This laptop</span><p className="stat-value">{machine(own)}</p><p className="stat-note">{own.mem_gb ? `${own.mem_gb.toFixed(1)} GB · ` : ""}Connected</p></div>
      <div className="stat"><span className="mono-label">Pool</span><p className="stat-value">{approved.length} <small>laptops</small></p><p className="stat-note">{online} connected · available for requests</p></div>
      {me && <div className="stat"><span className="mono-label">Credits earned</span><p className="stat-value">{fmtNum(me.balance.earned, 1)}</p><p className="stat-note">{me.incentives.next_unlock_at ? `next unlock in ${fmtLeft(me.incentives.next_unlock_at, now)}` : "all unlocked"}</p></div>}
    </div>
    <div className="tile-actions">
      <button className="button button-blue" onClick={() => navigate(`/chat?model=${encodeURIComponent(pool.model)}&pool=${encodeURIComponent(pool.pool_id)}`)}>Try this pool <Icon name="arrow" size={14} /></button>
      <button className="button button-ghost" onClick={() => navigate("/account")}>View earnings</button>
    </div>
    {members}
    <details className="provider-more"><summary>Connection details</summary>{connection}{footer}</details>
    <details className="provider-more"><summary>Reconnect instructions</summary>{install}</details>
    {error && <ErrorBox title="That didn't work" error={error} hint="Nothing changed. Check the details and try again." />}
    {done && <Success onClose={() => setDone(null)}>{done}</Success>}
  </section>;

  return <section className="panel provider-pool" aria-label={`${pool.name} setup`}>
    <div className="provider-pool-head"><div><span className="mono-label">{coordinator ? "YOUR POOL / COORDINATOR" : "YOUR POOL / MEMBER"}</span><h2>{pool.name}</h2><span className="faint mono">{pool.model}</span></div>{status}</div>
    <ol className="provider-steps" aria-label="Setup progress">{steps.map((label, i) => <li key={label} className={i < next.step ? "is-done" : i === next.step ? "is-current" : ""} aria-current={i === next.step ? "step" : undefined}>{i < next.step ? <Icon name="check" size={12} /> : <span>{i + 1}</span>}{label}</li>)}</ol>
    <div className="provider-next" role="status" aria-live="polite"><strong>{next.title}</strong><p>{next.body}</p>{next.who && <span className="faint">Next action: {next.who}</span>}</div>
    {connection}
    {!own?.approved ? null : ownOnline ? <details className="provider-more"><summary>Reconnect instructions</summary>{install}</details> : install}
    {members}
    {error && <ErrorBox title="That didn't work" error={error} hint="Nothing changed. Check the details and try again." />}
    {done && <Success onClose={() => setDone(null)}>{done}</Success>}
    {footer}
  </section>;
}
