# shellcheck shell=bash
# Shared helpers for the pool scripts. Source it; do not run it.
# Works on Linux and macOS (bash 3.2+; no GNU-only flags).

POOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$POOL_DIR/run"
LOG_DIR="$POOL_DIR/logs"

# Every Parallax process (scheduler, node, spawn_main / resource_tracker children, vllm-rs frontend).
# CLAUDE.md §6.1: after a stop, `pgrep -f "parallax/.venv/bin/python"` must be empty.
PARALLAX_PROC_PATTERN='parallax/\.venv/bin/(python|vllm-rs)'

die() { echo "error: $*" >&2; exit 1; }

# load_env <file>: export every key in the env file (shell syntax, comments allowed).
load_env() {
  local file="$1"
  [ -f "$file" ] || die "env file not found: $file (copy pool/node.env.example)"
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
}

# require KEY...: fail with a clear message if a key is empty.
require() {
  local k
  for k in "$@"; do
    [ -n "${!k:-}" ] || die "$k is not set (see pool/node.env.example)"
  done
}

# Fixed ports and LAN announce addresses (HANDOFF §2.2: no random ports, no Docker bridge IPs).
net_flags() {
  NET_FLAGS=(-u --dht-prefix "$DHT_PREFIX"
    --tcp-port "$TCP_PORT" --udp-port "$UDP_PORT"
    --announce-maddrs "/ip4/$LAN_IP/tcp/$TCP_PORT" "/ip4/$LAN_IP/udp/$UDP_PORT/quic-v1")
}

# Post-MVP P5 runtime hooks (pool/hooks, docs/POST_MVP_PLAN.md): every Parallax Python process
# imports pool/hooks/sitecustomize.py, which patches Parallax after import (never a fork).
# HOOKS=0 in the env file turns them off.
use_hooks() {
  [ "${HOOKS:-1}" = "1" ] || return 0
  export RAMX_HOOKS=1 RAMX_RUN_DIR="$RUN_DIR"
  export PYTHONPATH="$POOL_DIR/hooks${PYTHONPATH:+:$PYTHONPATH}"
}

# Privacy: at debug level Parallax logs whole chat requests (prompts) on the scheduler and the nodes
# (rpc_connection_handler / p2p server "Chat completion request: …"). Refuse it unless ALLOW_DEBUG_LOGS=1.
no_prompt_logs() {
  [ "${ALLOW_DEBUG_LOGS:-0}" = "1" ] && return 0
  case " ${EXTRA_FLAGS:-} " in
    *" --verbose "*|*" --log-level debug "*|*" --log-level DEBUG "*|*" --log-level=debug "*|*" --log-level=DEBUG "*)
      die "debug logging writes prompts to the logs; remove it from EXTRA_FLAGS (or ALLOW_DEBUG_LOGS=1)" ;;
  esac
}

# Use the Parallax venv without `source activate` (works the same in any shell).
use_venv() {
  [ -x "$PARALLAX_DIR/.venv/bin/parallax" ] || die "no Parallax venv at $PARALLAX_DIR/.venv"
  export VIRTUAL_ENV="$PARALLAX_DIR/.venv"
  export PATH="$VIRTUAL_ENV/bin:$PATH"
  [ -n "${HF_HOME:-}" ] && export HF_HOME
  return 0
}

# is_running <name>: true if the pid file's process group is still alive.
is_running() {
  local f="$RUN_DIR/$1.pgid" pgid
  [ -f "$f" ] || return 1
  pgid="$(cat "$f")"
  [ -n "$pgid" ] && kill -0 -- "-$pgid" 2>/dev/null
}

# start_group <name> <cmd...>: start the command in a NEW session / process group, log to
# logs/<name>.log, record the process group ID in run/<name>.pgid.
# Linux has setsid(1). macOS does not, so we call POSIX setsid() from perl (ships with macOS).
start_group() {
  local name="$1"; shift
  local log="$LOG_DIR/$name.log"

  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf 'DRY_RUN: cd %q &&' "$PARALLAX_DIR"
    [ -n "${HF_HUB_OFFLINE:-}" ] && printf ' HF_HUB_OFFLINE=%s' "$HF_HUB_OFFLINE"
    [ -n "${HF_HOME:-}" ] && printf ' HF_HOME=%q' "$HF_HOME"
    [ -n "${CUDA_HOME:-}" ] && printf ' CUDA_HOME=%q' "$CUDA_HOME"
    [ -n "${RAMX_HOOKS:-}" ] && printf ' RAMX_HOOKS=1 PYTHONPATH=%q' "$PYTHONPATH"
    [ -n "${RAMX_ALLOWED_PEERS:-}" ] && printf ' RAMX_ALLOWED_PEERS=%q' "$RAMX_ALLOWED_PEERS"
    printf ' setsid'
    printf ' %q' "$@"
    printf ' > %q 2>&1 &\n' "$log"
    return 0
  fi

  is_running "$name" && die "$name already running (pgid $(cat "$RUN_DIR/$name.pgid")); run pool/stop-all.sh first"
  mkdir -p "$RUN_DIR" "$LOG_DIR"

  # Start marker: the node agent ignores log lines before it (old process; P5.5 no stale layers).
  echo "=== ramx start $name $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >>"$log"
  # Record the limit actually passed to this process, rather than a possibly edited env file.
  if [ "$name" = "node" ]; then
    local arg expect_seq=0
    for arg in "$@"; do
      if [ "$expect_seq" = "1" ]; then
        case "$arg" in *[!0-9]*|"") die "invalid --max-sequence-length" ;; esac
        [ "$arg" -gt 0 ] || die "--max-sequence-length must be positive"
        echo "ramx max_seq=$arg" >>"$log"
        expect_seq=0
      elif [ "$arg" = "--max-sequence-length" ]; then
        expect_seq=1
      elif [[ "$arg" == --max-sequence-length=* ]]; then
        echo "ramx max_seq=${arg#*=}" >>"$log"
      fi
    done
    [ "$expect_seq" = "0" ] || die "missing --max-sequence-length value"
  fi
  rm -f "$RUN_DIR/node.peer-id"
  # p2p.key (scheduler identity) lives in the cwd of `parallax run`.
  cd "$PARALLAX_DIR" || die "cannot cd to $PARALLAX_DIR"
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >>"$log" 2>&1 </dev/null &
  else
    perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV or die "exec: $!"' -- "$@" >>"$log" 2>&1 </dev/null &
  fi
  local pid=$!
  # The new session leader's PID is its process group ID.
  echo "$pid" >"$RUN_DIR/$name.pgid"
  sleep 1
  kill -0 "$pid" 2>/dev/null || die "$name exited at start; see $log"
  echo "$name started: pgid $pid, log $log"
}
