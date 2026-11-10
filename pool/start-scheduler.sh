#!/usr/bin/env bash
# Start the Parallax scheduler on the coordinator (SPEC §3.2 step 2).
# Usage: pool/start-scheduler.sh [env-file]   (default pool/scheduler.env, ROLE=scheduler)
#        DRY_RUN=1 pool/start-scheduler.sh    prints the command only
# The scheduler HTTP API binds 127.0.0.1:3001. Only the gateway calls it.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

load_env "${1:-$POOL_DIR/scheduler.env}"
require PARALLAX_DIR ROLE MODEL INIT_NODES DHT_PREFIX LAN_IP TCP_PORT UDP_PORT
[ "$ROLE" = "scheduler" ] || die "ROLE must be 'scheduler' in this env file (got '$ROLE')"

# The scheduler downloads small model config files: never HF_HUB_OFFLINE here (HANDOFF §2.2).
unset HF_HUB_OFFLINE
[ "${DRY_RUN:-0}" = "1" ] || use_venv
use_hooks
no_prompt_logs
# P5.4 admission: only peers the gateway lists (registered nodes with a fresh signed heartbeat) may
# join. The gateway on this machine writes the file (gateway env PARALLAX_ALLOWED_PEERS_FILE).
if [ -n "${ALLOWED_PEERS_FILE:-}" ]; then export RAMX_ALLOWED_PEERS="$ALLOWED_PEERS_FILE"; fi
# §16.1 node leave: cool-down before Parallax reloads every node (pool/hooks).
if [ -n "${REBALANCE_COOLDOWN_S:-}" ]; then export RAMX_REBALANCE_COOLDOWN_S="$REBALANCE_COOLDOWN_S"; fi
# Equal layer split across N members (pool/hooks): set by the website onboarding for same-memory pools.
if [ -n "${EQUAL_LAYERS_NODES:-}" ]; then export RAMX_EQUAL_LAYERS_NODES="$EQUAL_LAYERS_NODES"; fi
net_flags
# §16.1 many pools: one scheduler per pool on this host, each with its own private API port (127.0.0.1).
# §16.1 WAN: your own relay servers / initial peers (multiaddrs). Empty = LAN only (MVP).
SCHED_FLAGS=()
[ -n "${API_PORT:-}" ] && SCHED_FLAGS+=(--port "$API_PORT")
# shellcheck disable=SC2206 # space-separated multiaddr lists
[ -n "${RELAY_SERVERS:-}" ] && SCHED_FLAGS+=(--relay-servers $RELAY_SERVERS)
# shellcheck disable=SC2206
[ -n "${INITIAL_PEERS:-}" ] && SCHED_FLAGS+=(--initial-peers $INITIAL_PEERS)

# shellcheck disable=SC2086 # EXTRA_FLAGS is a list of flags: word-split on purpose.
start_group "${PROCESS_NAME:-scheduler}" parallax run -m "$MODEL" -n "$INIT_NODES" "${NET_FLAGS[@]}" "${SCHED_FLAGS[@]}" ${EXTRA_FLAGS:-}
