import { Busy } from "./console/Status";
import type { NodeListing, PoolListing } from "../shared/types";
import { usePoolAvailability, useNow } from "../hooks/usePool";
import { fmtAgo } from "../lib/format";

/** Why no model is available, from the gateway's routing check on the first listed pool. */
export default function UnavailableNotice({ pools, nodes, loaded }: { pools: PoolListing[]; nodes: NodeListing[]; loaded: boolean }) {
  const pool = pools.find((p) => p.models.length > 0);
  const availability = usePoolAvailability(pool?.pool_id, pool?.models[0]);
  const now = useNow(1000);
  if (!loaded) return <p className="faint"><Busy>Checking availability…</Busy></p>;
  const online = nodes.filter((n) => n.status !== "offline").length;
  const a = availability.data;
  return (
    <p className="faint" role="status">
      {online} {online === 1 ? "laptop" : "laptops"} connected. Requests temporarily unavailable.{" "}
      {!pool ? "No pool is listed in the marketplace directory yet." : a ? <>{a.reason} {a.action} Last checked {fmtAgo(a.checked_at, now)}.</> : availability.error ? availability.error.message : <Busy>Checking availability…</Busy>}{" "}
      {pool && <><button className="text-link" onClick={availability.reload}>Check again</button> · </>}
      <a className="text-link" href="/network">View connection details</a>
    </p>
  );
}
