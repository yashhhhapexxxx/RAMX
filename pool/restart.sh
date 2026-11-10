#!/usr/bin/env bash
# Clean restart of this machine's Parallax processes (post-MVP P5.5 / P5.6).
# The node agent runs this when the gateway orders a pool restart after a live re-placement, or when
# this machine's LAN IP changed. Never trust a live reassignment: stop the whole process group, then
# join again with the weights already on disk (HF_HUB_OFFLINE=1).
# Usage: pool/restart.sh [--coordinator] [--join-delay S] [--lan-ip IP]
#   --coordinator  also restart the scheduler (this machine runs it; pool/scheduler.env)
#   --join-delay   seconds to wait before `join` (members wait for the scheduler)
#   --lan-ip       write this LAN_IP into pool/node.env (and scheduler.env) first
#   --dht-prefix   write this DHT_PREFIX into pool/node.env first (§16.1: the gateway put this node in a pool)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

coordinator=0; delay=0; ip=""; prefix=""
while [ $# -gt 0 ]; do
  case "$1" in
    --coordinator) coordinator=1 ;;
    --join-delay) delay="$2"; shift ;;
    --lan-ip) ip="$2"; shift ;;
    --dht-prefix) prefix="$2"; shift ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

set_key() { # set_key <file> <KEY> <value>: replace or add the KEY line (portable, no sed -i)
  local f="$1" k="$2" v="$3" tmp
  [ -f "$f" ] || return 0
  tmp="$(mktemp)"
  if grep -q "^$k=" "$f"; then sed "s|^$k=.*|$k=$v|" "$f" >"$tmp"; else cat "$f" >"$tmp"; echo "$k=$v" >>"$tmp"; fi
  cat "$tmp" >"$f" && rm -f "$tmp"
  echo "$k=$v written to $f"
}
set_ip() { set_key "$1" LAN_IP "$ip"; }
if [ -n "$ip" ]; then
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "bad --lan-ip $ip"
  set_ip "$POOL_DIR/node.env"
  [ "$coordinator" = "1" ] && set_ip "$POOL_DIR/scheduler.env"
fi

if [ -n "$prefix" ]; then
  [[ "$prefix" =~ ^[A-Za-z0-9_-]+$ ]] || die "bad --dht-prefix $prefix"
  set_key "$POOL_DIR/node.env" DHT_PREFIX "$prefix"
fi

"$POOL_DIR/stop-all.sh"
if [ "$coordinator" = "1" ]; then
  "$POOL_DIR/start-scheduler.sh"
fi
[ "$delay" -gt 0 ] && sleep "$delay"
"$POOL_DIR/join-node.sh"
