import { Icon } from "./Icon";
import { env } from "../config/env";

type Kind = "directory" | "explorer" | "ledger" | "swarm" | "mock";
const labels: Record<Kind, string> = { directory: "Directory", explorer: "NearBlocks", ledger: "Ledger", swarm: "Swarm", mock: "mock" };

/**
 * Shows where a piece of data comes from (spec §B11 UX rule).
 * With an href it links out; in mock mode ids are synthetic, so it renders
 * without a link and says so on hover.
 */
export default function SourceBadge({
  kind,
  href,
  seq,
  title,
}: {
  kind: Kind;
  href?: string;
  seq?: number | string;
  title?: string;
}) {
  const text = seq != null ? `${labels[kind]} #${seq}` : labels[kind];
  const cls = `badge badge-${kind === "swarm" ? "ledger" : kind}`;
  const tip = title ?? (env.dataMode === "mock" ? "Demo data. Ids are synthetic and not on chain." : undefined);
  if (href)
    return (
      <a className={cls} href={href} target="_blank" rel="noreferrer" title={tip}>
        {text} <Icon name="external" size={10} />
      </a>
    );
  return (
    <span className={cls} title={tip}>
      {text}
    </span>
  );
}
