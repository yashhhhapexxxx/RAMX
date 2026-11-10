/* /swarm (Phase 7): the capacity market. AI agents (each its own NEAR account) bid for priority
   inference slots in 30 s sealed-bid rounds: commit → reveal → one uniform price per model. Winning
   buyers form a group order; each pays units × price. Every cleared order is a signed swarm_cleared
   event on the NEAR ledger contract. Rules: swarm-sim/RULES.md. Data: GET /swarm/rounds. */
import { useEffect, useState } from "react";
import { SwarmRoundsResponse } from "@ramx/shared";
import { PageHead } from "../components/ConsoleShell";
import { Empty, ErrorBox, Loading } from "../components/console/Status";
import { useNow } from "../hooks/usePool";
import { env } from "../config/env";
import { explorerTx } from "../lib/links";
import { shortHash } from "../lib/format";

const cr = (mc: number) => `${(mc / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })} cr`;
const short = (agent: string) => agent.split(".")[0];

function useRounds() {
  const [data, setData] = useState<SwarmRoundsResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${env.gatewayUrl.replace(/\/$/, "")}/swarm/rounds`, { headers: { accept: "application/json" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = SwarmRoundsResponse.parse(await r.json());
        if (alive) { setData(d); setError(null); }
      } catch (e) {
        if (alive) setError(e as Error);
      }
    };
    void load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return { data, error };
}

export default function Swarm() {
  const { data, error } = useRounds();
  const now = useNow(1000);
  const ms = data?.round_ms ?? 30_000;
  const current = Math.floor(now / ms);
  const left = Math.max(0, Math.ceil(((current + 1) * ms - now) / 1000));
  const phase = now - current * ms < (ms * 2) / 3 ? "commit" : "reveal";
  const trades = (data?.rounds ?? []).flatMap((r) => r.orders.map((o) => ({ round: r.round_id, ...o })));

  return (
    <>
      <PageHead label="AI agents" title="Capacity market" sub="AI agents bid for priority inference slots in sealed-bid rounds. One uniform price per model; winners share a group order. Every result is signed and written to the NEAR ledger." />
      <section className="panel tile">
        <span className="mono-label">Round {current}</span>
        <p>
          <strong>{phase === "commit" ? "Commit phase" : "Reveal phase"}</strong>: {left} s left. Agents send{" "}
          {phase === "commit" ? "a sealed sha256 commitment of their bid" : "their bid and salt, checked against the commitment"}, signed with their own NEAR key.
        </p>
      </section>

      {error && <ErrorBox error={error} title="Could not load market rounds" />}
      {!data && !error && <Loading />}
      {data && trades.length === 0 && <Empty>No cleared trades yet. Run the simulation: <code>pnpm --filter @ramx/swarm-sim start</code>.</Empty>}

      {trades.length > 0 && (
        <section className="panel tile">
          <span className="mono-label">Group orders</span>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Round</th><th>Model</th><th className="num">Slots</th><th className="num">Price / slot</th><th>Buyers (share)</th><th>Sellers</th><th>Ledger</th></tr>
              </thead>
              <tbody>
                {trades.map((t) => {
                  const buyers = t.allocations.filter((a) => a.role === "buyer");
                  const sellers = t.allocations.filter((a) => a.role === "seller");
                  const link = explorerTx(t.ledger_tx);
                  return (
                    <tr key={`${t.round}-${t.model}`}>
                      <td className="mono">{t.round}</td>
                      <td className="mono">{t.model}</td>
                      <td className="num mono">{t.units}</td>
                      <td className="num mono">{cr(t.price_mc)}</td>
                      <td>{buyers.map((b) => `${short(b.agent)} ${b.units}× (${cr(b.amount_mc)})`).join(", ")}</td>
                      <td>{sellers.map((s) => `${short(s.agent)} ${s.units}×`).join(", ")}</td>
                      <td className="mono">{link ? <a href={link} target="_blank" rel="noreferrer">{shortHash(t.ledger_tx, 6, 4)}</a> : t.ledger_seq !== null ? `#${t.ledger_seq}` : "pending"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="faint">Shares are pro-rata to slots won. In the simulation buyers have no credits, so payments are recorded as due; nothing moves.</p>
        </section>
      )}

      {data && data.rounds.length > 0 && (
        <section className="panel tile">
          <span className="mono-label">Recent rounds</span>
          <ul className="plain-list">
            {data.rounds.map((r) => (
              <li key={r.round_id}>
                <span className="mono">{r.round_id}</span>: {r.commits.length} commits, {r.commits.filter((c) => c.revealed).length} revealed, {r.orders.length} order{r.orders.length === 1 ? "" : "s"}
                {r.commits_sha256 ? <span className="faint mono"> · commits {shortHash(r.commits_sha256, 8, 4)}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
