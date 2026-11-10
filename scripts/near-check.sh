#!/usr/bin/env bash
# RAMX Phase 0 check: read-only. Verifies accounts, contracts, USDC registration and balances, and
# that gateway/.env and agent-client/.env point at the same accounts. Prints OK / FAIL per line.
#   scripts/near-check.sh            (PARENT=ramx.testnet by default)
set -uo pipefail
PARENT="${PARENT:-ramx.testnet}"
USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
RPC=https://rpc.testnet.fastnear.com
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
ok() { printf '  OK    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; FAIL=1; }

q() { # request_type extra-json → result json (or empty)
  curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"finality\":\"final\",\"request_type\":\"$1\",$2}}"
}
view() { # contract method args-json → decoded return value
  local b64; b64=$(printf '%s' "$3" | base64 -w0)
  q call_function "\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$b64\"" | python3 -c 'import sys,json; r=json.load(sys.stdin); print(bytes(r["result"]["result"]).decode() if "result" in r else "ERR " + json.dumps(r.get("error",{}).get("cause",{})))'
}
near_balance() { q view_account "\"account_id\":\"$1\"" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("%.3f" % (int(r["result"]["amount"])/1e24) if "result" in r else "missing")'; }
getenv() { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- ; }

G="gateway.$PARENT"; T="treasury.$PARENT"; R="relayer.$PARENT"; L="ledger.$PARENT"; P="payout.$PARENT"; A="agent-1.$PARENT"

echo "accounts (NEAR balance, need gas)"
for acct in "$PARENT" "$G" "$T" "$R" "$L" "$P" "$A"; do
  b=$(near_balance "$acct")
  if [[ "$b" == missing ]]; then bad "$acct does not exist"; elif python3 -c "import sys; sys.exit(0 if float('$b') >= 0.2 else 1)"; then ok "$acct  $b NEAR"; else bad "$acct  only $b NEAR (top up from $PARENT or https://near-faucet.io)"; fi
done

echo "contracts"
w=$(view "$L" writer '{}'); [[ "$w" == "\"$G\"" ]] && ok "ledger writer = $G" || bad "ledger writer is $w, expected \"$G\""
pk=$(view "$L" pubkey '{}')
env_pk=$(cd "$ROOT/gateway" && GATEWAY_SIGNING_KEY="$(getenv "$ROOT/gateway/.env" GATEWAY_SIGNING_KEY)" node src/verify-event.ts --pubkey 2>/dev/null)
[[ "$pk" == "\"$env_pk\"" ]] && ok "ledger pubkey matches GATEWAY_SIGNING_KEY" || bad "ledger pubkey $pk ≠ key from gateway/.env ($env_pk): events would not verify"
cfg=$(view "$P" config '{}')
python3 -c "import json,sys; c=json.loads(sys.argv[1]); sys.exit(0 if c['settler']==sys.argv[2] and c['token']==sys.argv[3] else 1)" "$cfg" "$T" "$USDC" 2>/dev/null \
  && ok "payout settler = $T, token = USDC" || bad "payout config is $cfg"

echo "USDC (registered = can receive; balance in USDC)"
for acct in "$T" "$P" "$A"; do
  reg=$(view "$USDC" storage_balance_of "{\"account_id\":\"$acct\"}")
  [[ "$reg" != null && "$reg" != ERR* ]] && ok "$acct registered" || bad "$acct NOT registered on USDC (storage_deposit, step 6 of near-setup.sh)"
  bal=$(view "$USDC" ft_balance_of "{\"account_id\":\"$acct\"}" | tr -d '"')
  echo "        balance $(python3 -c "print(int('${bal:-0}' if '${bal:-0}'.isdigit() else 0)/1e6)") USDC"
done
abal=$(view "$USDC" ft_balance_of "{\"account_id\":\"$A\"}" | tr -d '"')
[[ "${abal:-0}" =~ ^[0-9]+$ && "$abal" -ge 20000 ]] && ok "$A can pay for at least 5 requests" || bad "$A has under 0.02 USDC: get testnet USDC at https://faucet.circle.com (NEAR Testnet) for $A"

echo ".env files point at the same accounts"
GE="$ROOT/gateway/.env"; AE="$ROOT/agent-client/.env"
chk() { local v; v=$(getenv "$1" "$2"); [[ "$v" == "$3" ]] && ok "$(basename "$(dirname "$1")")/.env $2=$3" || bad "$(basename "$(dirname "$1")")/.env $2 is '$v', expected '$3'"; }
chk "$GE" NEAR_GATEWAY_ACCOUNT_ID "$G"; chk "$GE" LEDGER_CONTRACT_ID "$L"; chk "$GE" X402_PAY_TO "$T"; chk "$GE" X402_RELAYER_ID "$R"
chk "$GE" PAYOUT_CONTRACT_ID "$P"; chk "$GE" SETTLER_ACCOUNT_ID "$T"; chk "$AE" AGENT_ACCOUNT_ID "$A"
for k in NEAR_GATEWAY_KEY X402_RELAYER_KEY SETTLER_KEY GATEWAY_SIGNING_KEY JWT_SECRET; do [[ -n "$(getenv "$GE" "$k")" ]] && ok "gateway/.env $k is set" || bad "gateway/.env $k is empty"; done
[[ -n "$(getenv "$AE" AGENT_SECRET_KEY)" ]] && ok "agent-client/.env AGENT_SECRET_KEY is set" || bad "agent-client/.env AGENT_SECRET_KEY is empty"
for f in gateway/.env agent-client/.env frontend/.env.local; do git -C "$ROOT" check-ignore -q "$f" && ok "$f is git-ignored" || bad "$f is NOT ignored by git"; done

echo; [[ $FAIL == 0 ]] && echo "Phase 0 complete." || { echo "Fix the FAIL lines above, then run this again."; exit 1; }
