#!/usr/bin/env bash
# Pool status from the scheduler on the coordinator (SPEC §3.3).
# Usage: pool/status.sh        DRY_RUN=1 pool/status.sh
# Env: PARALLAX_API (default http://127.0.0.1:3001). The API stays on 127.0.0.1.
set -euo pipefail
url="${PARALLAX_API:-http://127.0.0.1:3001}/cluster/status_json"

if [ "${DRY_RUN:-0}" = "1" ]; then echo "DRY_RUN: curl -fsS --max-time 5 $url"; exit 0; fi

body="$(curl -fsS --max-time 5 "$url")" || { echo "error: scheduler not reachable at $url" >&2; exit 1; }
if command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$body" | jq '.data | {status, model_name, init_nodes_num, nodes: [.node_list[] | {node_id, status, gpu_name, gpu_memory}]}'
else
  printf '%s\n' "$body"
fi
