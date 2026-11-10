/** Stable colour per node: hashed from its node_id, so the same node has the same colour on
    Network, in the route and in the simulator, however the list is ordered. */
const palette = ["#83caff", "#b4a0ed", "#8ecab3", "#dfb69a", "#e7a3c6", "#f2d27a", "#7fd1d9", "#f0a07a"];
export function nodeColor(key: string | undefined, fallbackIndex = 0) {
  if (!key) return palette[fallbackIndex % palette.length];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
