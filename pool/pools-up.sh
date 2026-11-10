#!/usr/bin/env bash
# SPEC §16.1 automatic pool formation + many pools, on the GATEWAY host.
# Reads the gateway's pool plan (GET /pools/plan, loopback only) and starts one Parallax scheduler for
# every formed "auto" pool that has none yet. Each scheduler gets its own private API port
# (127.0.0.1:API_BASE+i), Lattica ports (P2P_BASE+i) and the pool's private DHT prefix. Writes
# pool/run/coordinators.json (pool_id → URL); set gateway POOL_COORDINATORS_FILE to it.
# Base values (PARALLAX_DIR, LAN_IP, HF_HOME, ALLOWED_PEERS_FILE, …) come from pool/scheduler.env.
# Usage: pool/pools-up.sh [gateway-url]   (default http://127.0.0.1:8080). Run it again (or from cron)
# when new pools form. Open the new P2P ports in the firewall for the pool members (manual, sudo).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

GW="${1:-http://127.0.0.1:8080}"
BASE_ENV="${BASE_ENV:-$POOL_DIR/scheduler.env}"
[ -f "$BASE_ENV" ] || die "need $BASE_ENV as the base for pool schedulers"
API_BASE="${API_BASE:-3101}"; P2P_BASE="${P2P_BASE:-5300}"
mkdir -p "$RUN_DIR" "$POOL_DIR/schedulers"
plan="$(curl -fsS "$GW/pools/plan")" || die "cannot read $GW/pools/plan (run this on the gateway host)"

# One line per pool: pool_id model members dht_prefix index (python3: JSON without jq).
lines="$(printf '%s' "$plan" | python3 -c '
import json, sys
p = json.load(sys.stdin)
for i, pool in enumerate(sorted(p["pools"], key=lambda x: x["pool_id"])):
    print(pool["pool_id"], pool["model"], len(pool["members"]), pool["dht_prefix"], i)
')"

coord="$RUN_DIR/coordinators.json"
[ -f "$coord" ] || echo '{}' >"$coord"
while read -r pool model n prefix i; do
  [ -n "${pool:-}" ] || continue
  name="sched-$pool"
  api=$((API_BASE + i)); p2p=$((P2P_BASE + i))
  env="$POOL_DIR/schedulers/$pool.env"
  { cat "$BASE_ENV"
    echo "ROLE=scheduler"; echo "MODEL=$model"; echo "INIT_NODES=$n"; echo "DHT_PREFIX=$prefix"
    echo "TCP_PORT=$p2p"; echo "UDP_PORT=$p2p"; echo "API_PORT=$api"; echo "PROCESS_NAME=$name"; } >"$env"
  if is_running "$name"; then
    echo "$pool: scheduler already running"
  else
    "$POOL_DIR/start-scheduler.sh" "$env"
  fi
  python3 - "$coord" "$pool" "http://127.0.0.1:$api" <<'PY'
import json, sys, os
path, pool, url = sys.argv[1:]
m = json.load(open(path))
m[pool] = url
tmp = path + ".tmp"
json.dump(m, open(tmp, "w"), indent=2)
os.replace(tmp, path)
PY
done <<<"$lines"
echo "coordinators: $coord"
