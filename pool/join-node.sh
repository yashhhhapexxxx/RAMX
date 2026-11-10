#!/usr/bin/env bash
# Join this machine to the pool as a Parallax node (SPEC §3.2 step 3).
# Usage: pool/join-node.sh [env-file]   (default pool/node.env, ROLE=node)
#        DRY_RUN=1 pool/join-node.sh    prints the command only
# Start every node join within 30 s of the others (a slow joiner is dropped at placement).
# Download the model BEFORE joining: nodes run with HF_HUB_OFFLINE=1.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

load_env "${1:-$POOL_DIR/node.env}"
require PARALLAX_DIR ROLE DHT_PREFIX LAN_IP TCP_PORT UDP_PORT
[ "$ROLE" = "node" ] || die "ROLE must be 'node' in this env file (got '$ROLE')"

export HF_HUB_OFFLINE=1
# CUDA nodes: FlashInfer/deep_gemm JIT needs nvcc from the venv (HANDOFF §2.2).
if [ -n "${CUDA_HOME:-}" ]; then
  [ "${DRY_RUN:-0}" = "1" ] || [ -x "$CUDA_HOME/bin/nvcc" ] || die "no nvcc at $CUDA_HOME/bin/nvcc"
  export CUDA_HOME PATH="$CUDA_HOME/bin:$PATH"
fi
[ "${DRY_RUN:-0}" = "1" ] || use_venv
use_hooks
no_prompt_logs
net_flags

# P5.7 memory: a 16 GB Mac without these limits plans for all its memory and swaps (CLAUDE.md §6.4).
if [ "$(uname -s)" = "Darwin" ] && [ "${ALLOW_MAC_DEFAULT_MEMORY:-0}" != "1" ]; then
  case " ${EXTRA_FLAGS:-} " in
    *" --kv-cache-memory-fraction "*" --max-sequence-length "*|*" --max-sequence-length "*" --kv-cache-memory-fraction "*) ;;
    *) die "Mac nodes need EXTRA_FLAGS=\"--kv-cache-memory-fraction 0.25 --max-sequence-length 4096\"" ;;
  esac
fi

# P5.9: the node agent counts the requests this node serves from Parallax's --notify-url events.
NOTIFY_FLAGS=()
if [ -n "${NOTIFY_PORT:-}" ]; then NOTIFY_FLAGS=(--notify-url "http://127.0.0.1:$NOTIFY_PORT/notify"); fi

# §16.1 options (all empty = MVP behaviour):
#  SCHEDULER_ADDR  scheduler multiaddr (/ip4/…/tcp/…/p2p/<peer>) for a pool over the internet (WAN);
#  RELAY_SERVERS / INITIAL_PEERS  your own relay / bootstrap multiaddrs (never the public ones by default);
#  START_LAYER / END_LAYER  pin this node to [start, end) (privacy: trusted first/last layers);
#  MAX_BATCH_SIZE  requests Parallax batches on this node (batching tuning);
#  MICRO_BATCH_RATIO  micro batch = MAX_BATCH_SIZE / ratio (pipeline stages overlap; Parallax default 1);
#  SCHEDULER_WAIT_MS  time to gather a batch before it runs (Parallax default 500; adds first-token delay).
OPT_FLAGS=()
[ -n "${SCHEDULER_ADDR:-}" ] && OPT_FLAGS+=(-s "$SCHEDULER_ADDR")
# shellcheck disable=SC2206
[ -n "${RELAY_SERVERS:-}" ] && OPT_FLAGS+=(--relay-servers $RELAY_SERVERS)
# shellcheck disable=SC2206
[ -n "${INITIAL_PEERS:-}" ] && OPT_FLAGS+=(--initial-peers $INITIAL_PEERS)
if [ -n "${START_LAYER:-}" ] || [ -n "${END_LAYER:-}" ]; then
  [ -n "${START_LAYER:-}" ] && [ -n "${END_LAYER:-}" ] || die "set both START_LAYER and END_LAYER"
  OPT_FLAGS+=(--start-layer "$START_LAYER" --end-layer "$END_LAYER")
fi
[ -n "${MAX_BATCH_SIZE:-}" ] && OPT_FLAGS+=(--max-batch-size "$MAX_BATCH_SIZE")
[ -n "${MICRO_BATCH_RATIO:-}" ] && OPT_FLAGS+=(--micro-batch-ratio "$MICRO_BATCH_RATIO")
[ -n "${SCHEDULER_WAIT_MS:-}" ] && OPT_FLAGS+=(--scheduler-wait-ms "$SCHEDULER_WAIT_MS")

# Mac: EXTRA_FLAGS="--kv-cache-memory-fraction 0.25 --max-sequence-length 4096"
# shellcheck disable=SC2086 # EXTRA_FLAGS is a list of flags: word-split on purpose.
start_group node parallax join "${NET_FLAGS[@]}" "${NOTIFY_FLAGS[@]}" "${OPT_FLAGS[@]}" ${EXTRA_FLAGS:-}
