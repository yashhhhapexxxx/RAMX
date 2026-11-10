/* /network (spec §12): the consumer directory, served by the gateway through GET /network.
   Every pool (models, members, layer map, status, reliability = the pool's own success + uptime record, load) and every
   node (GPU, memory, layers, tok/s, status, reliability, owner). Pick a pool here to query it. */
import type { NodeListing, PoolListing } from "@shared/types";
import { PageHead } from "../components/ConsoleShell";
import SourceBadge from "../components/SourceBadge";
import PipelineDiagram from "../components/network/PipelineDiagram";
import LayerSim from "../components/sim/LayerSim";
import { Icon } from "../components/Icon";
import UnavailableNotice from "../components/UnavailableNotice";
import { Empty, ErrorBox, Loading, StatusPill, Busy, Spinner, LiveStatus } from "../components/console/Status";
import { useModels, useNetwork, useNow, usePoolAvailability } from "../hooks/usePool";
import { fmtAgo, fmtLayers, fmtNum, shortHash } from "../lib/format";
import { nodeColor } from "../lib/nodeColor";
import { navigate } from "../lib/router";
import type { ModelOffer } from "../data";
import config from "../../../shared/config/ramx.config.json";

const short = (id: string) => id.split("/")[1] ?? id;
const layersOf = (id: string | undefined) => config.models.find((m) => m.model_id === id)?.num_layers ?? 0;

function NodesTable({ nodes, layerOf }: { nodes: NodeListing[]; layerOf?: (id: string) => [number, number] | null }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Node</th>
            <th>GPU · memory</th>
            <th>Layers</th>
            <th className="num">Tok/s</th>
            <th>Status</th>
            <th className="num">Reliability</th>
            <th>Owner</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => {
            const layers = layerOf?.(n.node_id) ?? n.layers;
            return (
              <tr key={n.node_id}>
                <td>
                  <span className="node-dot" style={{ ["--node" as string]: nodeColor(n.node_id) }} />
                  <span className="mono" title={n.node_id}>
                    {shortHash(n.node_id, 6, 4)}
                  </span>
                </td>
                <td>
                  {n.gpu} <span className="faint">· {n.mem_gb} GB</span>
                </td>
                <td className="mono">
                  {layers ? (
                    <>
                      {fmtLayers(layers)} <span className="faint">{layers[1] - layers[0]}</span>
                    </>
                  ) : (
                    <span className="faint">none yet</span>
                  )}
                </td>
                <td className="num mono">{n.tok_s ? n.tok_s.toFixed(1) : <span className="faint">—</span>}</td>
                <td>
                  <StatusPill status={n.status} />
                </td>
                <td className="num">
                  <span className="rep-bar" style={{ ["--rep" as string]: `${Math.round(n.reliability * 100)}%` }} />
                  <span className="mono">{n.reliability.toFixed(2)}</span>
                </td>
                <td className="mono faint" title={n.owner_account}>
                  {shortHash(n.owner_account, 8, 4)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PoolCard({ pool, nodes, offers }: { pool: PoolListing; nodes: NodeListing[]; offers: ModelOffer[] }) {
  const members = pool.members.map((id) => nodes.find((n) => n.node_id === id));
  const listed = members.filter((n): n is NodeListing => !!n);
  const pooledGb = listed.reduce((s, n) => s + n.mem_gb, 0);
  const model = pool.models[0];
  const factor = offers.find((o) => o.model.model_id === model)?.model.model_factor ?? config.models.find((m) => m.model_id === model)?.model_factor;
  const score = pool.reliability * (1 - pool.load);
  const availability = usePoolAvailability(pool.pool_id, model);
  const usable = availability.data?.available === true;
  const layerOf = (id: string) => pool.layer_map.find((h) => h.node_id === id)?.layers ?? null;
  return (
    <article className="pool-card" aria-labelledby={`pool-${pool.pool_id}`}>
      <header className="pool-card-head">
        <div className="pool-id">
          <h3 id={`pool-${pool.pool_id}`} className="mono">
            {pool.pool_id}
          </h3>
          <span className={`pill ${usable ? "pill-ok" : "pill-warn"}`}>{usable ? "Available for requests" : !model ? "Unavailable" : availability.error ? "Availability unknown" : !availability.data ? <Busy size={10}>Checking availability</Busy> : pool.status === "forming" ? "Preparing" : "Unavailable"}</span>
          {pool.restarting && <span className="pill pill-warn">restarting</span>}
          {pool.route_dispute && (
            <span className="pill pill-warn" title="Node-reported sessions disagree with the scheduler's routes in the last hour. Flag only; no credits change.">
              route check flagged
            </span>
          )}
        </div>
        <div className="pool-models">
          {pool.models.map((m) => (
            <span key={m} className="mono">
              {short(m)}
            </span>
          ))}
          {factor != null && <span className="faint">×{factor} credits per token</span>}
        </div>
        <button
          className="button button-blue button-sm"
          disabled={!usable}
          title={usable ? "Open the playground pinned to this pool" : availability.data?.reason ?? "Checking request availability"}
          onClick={() => navigate(`/chat?model=${encodeURIComponent(model)}&pool=${encodeURIComponent(pool.pool_id)}`)}
        >
          Query this pool <Icon name="arrow" size={13} />
        </button>
      </header>
      <p className="faint" role="status">{!model ? "The pool does not advertise a model." : availability.data ? <>{availability.data.reason} {availability.data.action} Last checked {fmtAgo(availability.data.checked_at)}.</> : availability.error ? availability.error.message : <Busy>Checking request availability…</Busy>} <button className="text-link" onClick={availability.reload}>Check again</button></p>
      <div className="stats pool-stats">
        <div className="stat">
          <span className="mono-label">Members</span>
          <p className="stat-value">{pool.members.length}</p>
          <p className="stat-note">{listed.length === pool.members.length ? "all listed in the directory" : `${listed.length} with a node listing`}</p>
        </div>
        <div className="stat">
          <span className="mono-label">Pooled memory</span>
          <p className="stat-value">
            {pooledGb}
            <small>GB</small>
          </p>
          <p className="stat-note">{layersOf(model) ? `${layersOf(model)} layers to place` : " "}</p>
        </div>
        <div className="stat">
          <span className="mono-label">Reliability</span>
          <p className="stat-value">{pool.reliability.toFixed(2)}</p>
          <p className="stat-note">pool success + uptime</p>
        </div>
        <div className="stat">
          <span className="mono-label">Load</span>
          <p className="stat-value">
            {Math.round(pool.load * 100)}
            <small>%</small>
          </p>
          <p className="stat-note">router score {score.toFixed(2)}</p>
        </div>
      </div>
      <details className="pool-inspect">
        <summary className="text-link">Technical details: layers, nodes, addresses</summary>
        <div className="pool-inspect-body">
      <PipelineDiagram pool={pool} nodes={nodes} totalLayers={layersOf(model)} />
          {pool.members.length > 0 && (
            <>
              <NodesTable nodes={[...listed].sort((a, b) => (layerOf(a.node_id)?.[0] ?? 1e9) - (layerOf(b.node_id)?.[0] ?? 1e9))} layerOf={layerOf} />
              {listed.length < pool.members.length && (
                <p className="faint table-note">
                  No node listing for {members.map((n, i) => (n ? null : shortHash(pool.members[i], 6, 4))).filter(Boolean).join(", ")}. Its listing may have expired.
                </p>
              )}
            </>
          )}
        </div>
      </details>
    </article>
  );
}

export default function Network() {
  const net = useNetwork();
  const models = useModels();
  const now = useNow(1000);
  const offers = models.data ?? [];
  const pools = net?.pools ?? [];
  const nodes = net?.nodes ?? [];
  const inPool = new Set(pools.flatMap((p) => p.members));
  const loose = nodes.filter((n) => !inPool.has(n.node_id));
  const hasNetwork = !!net && net.updated_at > 0;

  return (
    <div className="network-page">
      <PageHead
        label="DIRECTORY"
        title={<>Pick a pool. <em>Live laptops, one model.</em></>}
        aside={
          (
            <span className="faint">
              <LiveStatus loading={net?.loading} error={net?.error} hasData={!!net && net.updated_at > 0} /> Source: gateway directory <SourceBadge kind="directory" /> {net?.updated_at ? <>· updated {fmtAgo(net.updated_at, now)} </> : null}·{" "}
              <a className="text-link" href="/ledger">Network activity</a>
            </span>
          )
        }
      />

      {net?.error && (
        <ErrorBox
          title="Couldn't load the network directory"
          error={net.error}
          hint="The gateway directory did not answer. The numbers below may be missing or out of date. This page retries every 5 seconds."
          command="cd gateway && npm run dev   # gateway on :8080, or set VITE_GATEWAY_URL in frontend/.env"
          retry={net.reload}
          retrying={net.loading}
        />
      )}

      <div className="stats section-bottom">
        <div className="stat">
          <span className="mono-label">Pools</span>
          <p className="stat-value">
            {hasNetwork ? pools.length : <Spinner size={22} />}
            <small>{hasNetwork ? "listed" : "Checking…"}</small>
          </p>
        </div>
        <div className="stat">
          <span className="mono-label">Nodes</span>
          <p className="stat-value">
            {hasNetwork ? nodes.filter((n) => n.status === "online").length : <Spinner size={22} />}
            <small>{hasNetwork ? `/ ${nodes.length} online` : "Checking…"}</small>
          </p>
        </div>
        <div className="stat">
          <span className="mono-label">Pooled memory</span>
          <p className="stat-value">
            {hasNetwork ? fmtNum(nodes.reduce((s, n) => s + n.mem_gb, 0)) : <Spinner size={22} />}
            <small>GB</small>
          </p>
        </div>
        <div className="stat">
          <span className="mono-label">Models served</span>
          <p className="stat-value">{models.data && !models.error ? offers.filter((o) => o.pools > 0).length : models.error ? "—" : <Spinner size={22} />}</p>
        </div>
      </div>

      <section className="panel" aria-labelledby="pools-h">
        <div className="panel-head">
          <h2 id="pools-h" className="section-title">
            Pools <SourceBadge kind="directory" />
          </h2>
                  </div>
        {!hasNetwork ? (
          net?.error ? <Empty>Pools can't be shown until the directory loads. Use "Try again" above.</Empty> : <Loading h={200} label="Loading pools…" />
        ) : pools.length === 0 ? (
          <Empty>No pool is listed right now. Pools appear here once their laptops are online.</Empty>
        ) : (
          <div className="pool-list">
            {[...pools]
              .sort((a, b) => b.reliability * (1 - b.load) - a.reliability * (1 - a.load))
              .map((p) => (
                <PoolCard key={p.pool_id} pool={p} nodes={nodes} offers={offers} />
              ))}
          </div>
        )}
      </section>

      {loose.length > 0 && (
        <section className="panel section-gap" aria-labelledby="loose-h">
          <div className="panel-head">
            <h2 id="loose-h" className="section-title">
              Nodes not in a listed pool <SourceBadge kind="directory" />
            </h2>
            <span className="faint">waiting to form a pool, loading, or offline</span>
          </div>
          <NodesTable nodes={loose} />
        </section>
      )}

      <section className="panel section-gap" aria-labelledby="sim-h">
        <div className="panel-head">
          <h2 id="sim-h" className="section-title">
            How a pool splits a model
          </h2>
          <span className="faint">{pools.some((p) => p.layer_map.length) ? "live layer maps from the directory, or a simulated pool" : hasNetwork ? "simulated pool (no live layer map right now)" : <Busy>Checking live layer maps…</Busy>}</span>
        </div>
        <LayerSim pools={pools} nodes={nodes} preferLive={pools.some((p) => p.layer_map.length)} />
      </section>

      <div className="grid grid-2 section-gap net-tables">
        <section className="panel" aria-labelledby="models-h">
          <div className="panel-head">
            <h2 id="models-h" className="section-title">
              Models <SourceBadge kind="directory" />
            </h2>
                      </div>
          {models.error && !models.data ? (
            <ErrorBox title="Couldn't load models" error={models.error} hint="The gateway's /v1/models did not answer. Requests can't be priced until it does." command="cd gateway && npm run dev   # gateway on :8080, or set VITE_GATEWAY_URL in frontend/.env" retry={models.reload} retrying={models.loading} />
          ) : !models.data ? (
            <Loading h={120} label="Loading models…" />
          ) : models.data.length === 0 ? (
            <UnavailableNotice pools={pools} nodes={nodes} loaded={hasNetwork} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Layers</th>
                    <th className="num">Factor</th>
                    <th className="num">Pools</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {models.data.map(({ model: m, pools: n }) => (
                    <tr key={m.model_id}>
                      <td>
                        <span className="mono">{short(m.model_id)}</span>
                        <span className="cell-sub mono faint">
                          {m.size_gb} GB · {m.license}
                        </span>
                      </td>
                      <td className="num mono">{m.total_layers || "—"}</td>
                      <td className="num mono">×{m.model_factor}</td>
                      <td className="num mono">{n}</td>
                      <td>
                        <button className="text-link" onClick={() => navigate(`/chat?model=${encodeURIComponent(m.model_id)}`)}>
                          Chat <Icon name="arrow" size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="stats-h">
          <div className="panel-head">
            <h2 id="stats-h" className="section-title">
              Contributors <SourceBadge kind="directory" />
            </h2>
                      </div>
          {!net ? (
            <Loading h={120} label="Loading contributors…" />
          ) : net.error && net.stats.length === 0 ? (
            <Empty>Contributors can't be shown until the directory loads.</Empty>
          ) : net.stats.length === 0 ? (
            <Empty>No account stats yet.</Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th className="num">Earned</th>
                      <th className="num">Spent</th>
                      <th className="num">Ratio</th>
                      <th className="num">Reliability</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...net.stats]
                      .sort((a, b) => b.ratio - a.ratio)
                      .map((s) => (
                        <tr key={s.account_id}>
                          <td className="mono">{shortHash(s.account_id, 8, 4)}</td>
                          <td className="num mono">{fmtNum(s.earned, 1)}</td>
                          <td className="num mono">{fmtNum(s.spent, 1)}</td>
                          <td className="num mono">{s.ratio.toFixed(2)}</td>
                          <td className="num mono">{s.reliability ? s.reliability.toFixed(2) : "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

