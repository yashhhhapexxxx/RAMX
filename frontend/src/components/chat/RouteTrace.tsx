import type { NodeListing, RouteHop } from "@shared/types";
import { fmtLayers, gpuShort, nodeName, routeLabel, shortHash } from "../../lib/format";
import { nodeColor } from "../../lib/nodeColor";

/** The pipeline that served the current request (spec §5.3 step 9): any number of hops, in layer order. */
export default function RouteTrace({
  route,
  nodes,
  active,
  streaming,
}: {
  route: RouteHop[] | null;
  nodes: NodeListing[];
  /** Index of the hop holding the activations, -1 for none, -2 when the reply is done. */
  active: number;
  streaming: boolean;
}) {
  const find = (id: string) => nodes.find((n) => n.node_id === id);
  const label = (id: string) => {
    const n = find(id);
    return n ? gpuShort(n.gpu) : shortHash(id, 6, 4);
  };
  const total = route?.reduce((m, h) => Math.max(m, h.layers[1]), 0) ?? 0;

  return (
    <section className={`panel route-trace${streaming ? " is-streaming" : ""}`} aria-labelledby="route-h">
      <div className="panel-head">
        <h2 id="route-h" className="section-title">
          Served by
        </h2>
        {route && (
          <span className="faint mono">
            {route.length} {route.length === 1 ? "stage" : "stages"} · {total} layers
          </span>
        )}
      </div>
      {route ? (
        <>
          <p className="route-line mono" aria-live="polite">
            {routeLabel(route, label)}
          </p>
          <p className="faint route-note">
            Confirmed route: the laptops the gateway reported for this request, in layer order.
            {streaming && " The moving line is illustrative; it does not show which laptop is processing a token right now."}
          </p>
          <ol className="laptops" aria-label="Laptops serving this request, in order" style={{ ["--n" as string]: route.length }}>
            {route.map((h, i) => {
              const n = find(h.node_id);
              const done = i < active || active === -2;
              return (
                <li key={`${h.node_id}-${i}`} className={`laptop${i === active ? " is-active" : ""}${done ? " is-done" : ""}`} style={{ ["--node" as string]: nodeColor(h.node_id, i) }}>
                  <span className="laptop-screen" aria-hidden="true">
                    <span className="laptop-layers mono">{fmtLayers(h.layers)}</span>
                  </span>
                  <span className="laptop-base" aria-hidden="true" />
                  <span className="laptop-name">{nodeName(n, h.node_id)}</span>
                  <span className="laptop-gpu faint mono">{n ? `${n.mem_gb} GB · ${h.layers[1] - h.layers[0]} layers` : `${h.layers[1] - h.layers[0]} layers`}</span>
                  {i < route.length - 1 && <i className="laptop-link" aria-hidden="true" />}
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <p className="faint route-empty">Send a message to see which laptops serve it. Each one holds a slice of the model's layers, and the reply passes through them in order.</p>
      )}
    </section>
  );
}
