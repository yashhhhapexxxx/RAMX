/** Throughput gauge: an arc from 0 to `max` tok/s, plus time to first token. */
export default function TokMeter({ tokS, ttft, max = 40 }: { tokS: number | null; ttft: number | null; max?: number }) {
  const r = 46;
  const L = Math.PI * r; // half circle
  const frac = Math.min(1, (tokS ?? 0) / max);
  return (
    <div className="tok-meter">
      <svg viewBox="0 0 120 70" role="img" aria-label={tokS != null ? `${tokS.toFixed(1)} tokens per second` : "No request yet"}>
        <path d={`M14,62 A${r},${r} 0 0 1 106,62`} className="tok-track" />
        <path d={`M14,62 A${r},${r} 0 0 1 106,62`} className="tok-fill" strokeDasharray={`${L * frac} ${L}`} />
        <text x="60" y="54" textAnchor="middle" className="tok-value">
          {tokS != null ? tokS.toFixed(1) : "—"}
        </text>
        <text x="60" y="67" textAnchor="middle" className="tok-unit">
          tok/s
        </text>
      </svg>
      <dl className="kv">
        <dt>First token</dt>
        <dd>{ttft != null ? `${ttft} ms` : "—"}</dd>
      </dl>
    </div>
  );
}
