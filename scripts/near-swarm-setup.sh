#!/usr/bin/env bash
# Phase 7: create the capacity-market agents on NEAR testnet, each its own account with its own key:
#   swarm.$PARENT, buyer-1..$BUYERS.swarm.$PARENT, seller-1..$SELLERS.swarm.$PARENT
# Agents sign their bids off chain (NEP-413), so they need only the minimum balance. Keys go to
# ~/.near-credentials/testnet/ (never git). Safe to re-run: existing accounts are skipped.
set -euo pipefail
PARENT="${PARENT:-ramx.testnet}"; NET=testnet
BUYERS="${BUYERS:-20}"; SELLERS="${SELLERS:-5}"
SWARM="swarm.$PARENT"
RPC="${NEAR_RPC_URL:-https://rpc.testnet.fastnear.com}"
CREDS="$HOME/.near-credentials/$NET"
exists() { curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" | grep -q '"result"'; }
sub() { # account amount signer
  if exists "$1"; then echo "$1 exists"; return; fi
  near account create-account fund-myself "$1" "$2" autogenerate-new-keypair save-to-legacy-keychain sign-as "$3" network-config "$NET" sign-with-legacy-keychain send >/dev/null 2>&1 \
    && echo "created $1" || { echo "FAILED $1" >&2; return 1; }
}
sub "$SWARM" '1 NEAR' "$PARENT"
for i in $(seq 1 "$BUYERS"); do sub "buyer-$i.$SWARM" '0.02 NEAR' "$SWARM"; done
for i in $(seq 1 "$SELLERS"); do sub "seller-$i.$SWARM" '0.02 NEAR' "$SWARM"; done
n=$(ls "$CREDS" | grep -cE "^(buyer|seller)-[0-9]+\.$SWARM\.json$" || true)
echo "keys on this machine for $n agents (expected $((BUYERS + SELLERS)))"
