/**
 * Canonical JSON (shared/README.md): keys sorted recursively (by UTF-16 code units, same as
 * Python's sort_keys for the ASCII keys we use), no whitespace, UTF-8, non-ASCII kept as is.
 * Python: json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).
 * Used for ledger event signatures and the prompt hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}
