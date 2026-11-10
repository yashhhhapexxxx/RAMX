#!/usr/bin/env bash
# Stop every Parallax process on this machine (SPEC §3.2 step 1, CLAUDE.md §6.1).
# 1. TERM each recorded process group (run/*.pgid), wait, then KILL.
# 2. Sweep leftovers (spawn_main / resource_tracker children, vllm-rs) that left the group:
#    they keep heartbeating and become ghost nodes.
# Usage: pool/stop-all.sh          DRY_RUN=1 pool/stop-all.sh  (lists what it would stop)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

dry() { [ "${DRY_RUN:-0}" = "1" ]; }

# wait_gone <seconds> <test-cmd...>: poll until the test fails (no `timeout`: not on macOS).
wait_gone() {
  local n=$(( $1 * 2 )); shift
  while [ "$n" -gt 0 ] && "$@"; do sleep 0.5; n=$((n - 1)); done
  ! "$@"
}
group_alive() { kill -0 -- "-$1" 2>/dev/null; }
procs_alive() { pgrep -f "$PARALLAX_PROC_PATTERN" >/dev/null 2>&1; }

for f in "$RUN_DIR"/*.pgid; do
  [ -f "$f" ] || continue
  pgid="$(cat "$f")"
  if dry; then echo "DRY_RUN: kill -TERM -- -$pgid   # $(basename "$f" .pgid)"; continue; fi
  if [ -n "$pgid" ] && group_alive "$pgid"; then
    echo "stopping $(basename "$f" .pgid) (pgid $pgid)"
    kill -TERM -- "-$pgid" 2>/dev/null || true
    wait_gone 15 group_alive "$pgid" || kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  rm -f "$f"
done

if dry; then
  echo "DRY_RUN: pkill -TERM -f '$PARALLAX_PROC_PATTERN' (then -KILL). Matching now:"
  pgrep -fl "$PARALLAX_PROC_PATTERN" || echo "  (none)"
  exit 0
fi

if procs_alive; then
  echo "sweeping leftover Parallax processes"
  pkill -TERM -f "$PARALLAX_PROC_PATTERN" || true
  wait_gone 10 procs_alive || pkill -KILL -f "$PARALLAX_PROC_PATTERN" || true
  wait_gone 5 procs_alive || true
fi

if pgrep -f "parallax/.venv/bin/python" >/dev/null 2>&1; then
  pgrep -fl "parallax/.venv/bin/python" >&2
  die "Parallax processes still alive (see above)"
fi
echo "all Parallax processes stopped"
