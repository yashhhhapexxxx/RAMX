import type { NodeListing, PoolListing } from "@shared/types";
import { fmtLayers, gpuShort, shortHash } from "../../lib/format";
import { nodeColor } from "../../lib/nodeColor";

/** The pool's layer map as one bar: one slice per pipeline stage, sized by layers, any number of stages. */
export default function PipelineDiagram({ pool, nodes, totalLayers }: { pool: PoolListing; nodes: NodeListing[]; totalLayers: number }) {
  const find = (id: string) => nodes.find((n) => n.node_id === id);
  const total = totalLayers || pool.layer_map.reduce((m, h) => Math.max(m, h.layers[1]), 0);
  if (!pool.layer_map.length) return <p className="faint pipeline-empty">No layer map yet. The pool lists one when its members' layer ranges cover every layer exactly once.</p>;
  return (
    <div className="pipelines">
      <div className={`pipeline${pool.status === "ready" ? "" : " is-down"}`}>
        <div className="pipeline-bar" role="img" aria-label={pool.layer_map.map((h) => `${find(h.node_id)?.gpu ?? shortHash(h.node_id, 6, 4)} layers ${h.layers[0]} to ${h.layers[1]}`).join(", then ")}>
          {pool.layer_map.map((h, i) => {
            const n = find(h.node_id);
            const w = ((h.layers[1] - h.layers[0]) / total) * 100;
            return (
              <div className={`pipeline-seg${n ? "" : " is-down"}`} key={h.node_id} style={{ width: `${w}%`, ["--seg" as string]: nodeColor(h.node_id, i), ["--k" as string]: h.layers[1] - h.layers[0] }} title={`${n?.gpu ?? "no listing"} · ${shortHash(h.node_id, 6, 4)} · ${fmtLayers(h.layers)}`}>
                <span className="pipeline-seg-name">{n ? gpuShort(n.gpu) : "no listing"}</span>
                <span className="pipeline-seg-sub mono">{fmtLayers(h.layers)}</span>
                {i < pool.layer_map.length - 1 && (
                  <i className="pipeline-arrow" aria-hidden="true">
                    →
                  </i>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
