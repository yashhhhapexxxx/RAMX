#!/usr/bin/env bash
# RAMX NEAR setup: create every testnet account, deploy + init the contracts (ledger, payout, escrow),
# register USDC storage, lock the guarded agent to a function-call key, and write the NEAR part of
# gateway/.env and agent-client/.env. Testnet only.
#
#   scripts/near-setup.sh                 # uses PARENT=ramx.testnet
#   PARENT=myteam.testnet scripts/near-setup.sh
#
# Needs: near (near-cli-rs), cargo-near, node 24, openssl. Safe to re-run: existing accounts are
# skipped, a deployed contract is not redeployed. Keys go to ~/.near-credentials/testnet/ (never git).
set -euo pipefail

PARENT="${PARENT:-ramx.testnet}"
NET=testnet
USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af   # Circle USDC, NEAR testnet, 6 decimals
STORAGE_DEPOSIT="0.00125 NEAR"                                           # USDC storage_balance_bounds (checked)
CLAIM_DELAY_S="${CLAIM_DELAY_S:-60}"
SWEEP_DELAY_S="${SWEEP_DELAY_S:-604800}"
RPC=https://rpc.testnet.fastnear.com

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CREDS="$HOME/.near-credentials/$NET"
die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

for tool in near cargo-near node openssl python3 curl; do command -v "$tool" >/dev/null || die "$tool is not installed (see docs/PHASE0.md step 1)"; done
[[ "$PARENT" == *.testnet ]] || die "PARENT must end with .testnet"

# Name every account once. Everything below and every .env uses these.
GATEWAY="gateway.$PARENT"     # writes the ledger contract (NEAR_GATEWAY_ACCOUNT_ID)
TREASURY="treasury.$PARENT"   # receives x402 USDC, posts epochs (X402_PAY_TO = SETTLER_ACCOUNT_ID)
RELAYER="relayer.$PARENT"     # in-process x402 facilitator, pays gas (X402_RELAYER_ID)
LEDGER="ledger.$PARENT"       # contracts-near/ledger
PAYOUT="payout.$PARENT"       # contracts-near/payout
AGENT="agent-1.$PARENT"       # open agent: full-access key, pays per request with x402
ESCROW="escrow.$PARENT"       # contracts-near/escrow (guarded agent wallet)
AGENT2="agent-2.$PARENT"      # guarded agent: only a function-call key on escrow.pay
AGENT2_BUDGET="${AGENT2_BUDGET:-2000000}"        # 2 USDC total
AGENT2_PER_CALL="${AGENT2_PER_CALL:-500000}"     # 0.5 USDC per payment
AGENT2_FUND="${AGENT2_FUND:-3000000}"            # 3 USDC funded by the owner ($PARENT)

rpc() { curl -s "$RPC" -H 'content-type: application/json' -d "$1"; }
exists() { rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" | grep -q '"result"'; }
has_code() { rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" | python3 -c 'import sys,json; r=json.load(sys.stdin); sys.exit(0 if r.get("result",{}).get("code_hash","1"*32)!="1"*32 else 1)'; }
key_of() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["private_key"])' "$CREDS/$1.json"; }

step "1/7 parent account $PARENT"
if exists "$PARENT"; then
  [[ -f "$CREDS/$PARENT.json" ]] || die "$PARENT exists but its key is not in $CREDS (someone else owns it, or import it first)"
  echo "exists, key found"
else
  near account create-account sponsor-by-faucet-service "$PARENT" autogenerate-new-keypair save-to-legacy-keychain network-config "$NET" create
fi

step "2/7 sub-accounts (funded by $PARENT)"
sub() { # name amount
  if exists "$1"; then echo "$1 exists"; return; fi
  near account create-account fund-myself "$1" "$2" autogenerate-new-keypair save-to-legacy-keychain sign-as "$PARENT" network-config "$NET" sign-with-legacy-keychain send
}
sub "$GATEWAY" '1 NEAR'
sub "$TREASURY" '1 NEAR'
sub "$RELAYER" '1 NEAR'
sub "$LEDGER" '2 NEAR'     # 125 KB wasm ≈ 1.3 NEAR of storage staking
sub "$PAYOUT" '2.5 NEAR'   # 173 KB wasm ≈ 1.8 NEAR + claim records
sub "$AGENT" '0.5 NEAR'
sub "$ESCROW" '2.2 NEAR'  # 170 KB wasm ≈ 1.7 NEAR + agent records
sub "$AGENT2" '0.3 NEAR'  # gas for its function-call key

step "3/7 gateway secrets (generated once, kept in gateway/.env)"
ENV="$ROOT/gateway/.env"
[[ -f "$ENV" ]] || cp "$ROOT/gateway/.env.example" "$ENV"
setenv() { # file key value: replace or append, never print secrets
  python3 - "$1" "$2" "$3" <<'PY'
import sys, re, pathlib
f, k, v = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
s = f.read_text() if f.exists() else ""
line = f"{k}={v}"
s = re.sub(rf"^{re.escape(k)}=.*$", line, s, flags=re.M) if re.search(rf"^{re.escape(k)}=", s, flags=re.M) else s.rstrip("\n") + "\n" + line + "\n"
f.write_text(s)
PY
}
getenv() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2- || true; }
[[ -n "$(getenv "$ENV" GATEWAY_SIGNING_KEY)" ]] || setenv "$ENV" GATEWAY_SIGNING_KEY "$(openssl rand -hex 32)"
[[ -n "$(getenv "$ENV" JWT_SECRET)" ]] || setenv "$ENV" JWT_SECRET "$(openssl rand -hex 32)"
[[ -n "$(getenv "$ENV" TRANSCRIPT_KEY)" ]] || setenv "$ENV" TRANSCRIPT_KEY "$(openssl rand -hex 32)"
PUBKEY=$(cd "$ROOT/gateway" && GATEWAY_SIGNING_KEY="$(getenv "$ENV" GATEWAY_SIGNING_KEY)" node src/verify-event.ts --pubkey)
echo "gateway event-signing public key: $PUBKEY"

step "4/7 build contracts"
(cd "$ROOT/contracts-near/ledger" && cargo near build non-reproducible-wasm >/dev/null)
(cd "$ROOT/contracts-near/payout" && cargo near build non-reproducible-wasm >/dev/null)
(cd "$ROOT/contracts-near/escrow" && cargo near build non-reproducible-wasm >/dev/null)
WASM="$ROOT/contracts-near/target/near"

step "5/7 deploy + init"
if has_code "$LEDGER"; then echo "$LEDGER already has code (not redeployed)"; else
  near contract deploy "$LEDGER" use-file "$WASM/ramx_ledger/ramx_ledger.wasm" with-init-call new \
    json-args "{\"writer\":\"$GATEWAY\",\"pubkey\":\"$PUBKEY\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    network-config "$NET" sign-with-legacy-keychain send
fi
if has_code "$PAYOUT"; then echo "$PAYOUT already has code (not redeployed)"; else
  near contract deploy "$PAYOUT" use-file "$WASM/ramx_payout/ramx_payout.wasm" with-init-call new \
    json-args "{\"settler\":\"$TREASURY\",\"token\":\"$USDC\",\"claim_delay_s\":$CLAIM_DELAY_S,\"sweep_delay_s\":$SWEEP_DELAY_S}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config "$NET" sign-with-legacy-keychain send
fi
if has_code "$ESCROW"; then echo "$ESCROW already has code (not redeployed)"; else
  near contract deploy "$ESCROW" use-file "$WASM/ramx_escrow/ramx_escrow.wasm" with-init-call new \
    json-args "{\"token\":\"$USDC\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config "$NET" sign-with-legacy-keychain send
fi

step "6/7 USDC storage_deposit (an account must be registered before it can receive USDC)"
registered() { rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$USDC\",\"method_name\":\"storage_balance_of\",\"args_base64\":\"$(printf '{"account_id":"%s"}' "$1" | base64 -w0)\"}}" | python3 -c 'import sys,json; r=json.load(sys.stdin); sys.exit(0 if "result" in r and bytes(r["result"]["result"])!=b"null" else 1)'; }
for acct in "$TREASURY" "$PAYOUT" "$AGENT" "$ESCROW" "$PARENT"; do
  if registered "$acct"; then echo "$acct registered on USDC"; continue; fi
  near contract call-function as-transaction "$USDC" storage_deposit json-args "{\"account_id\":\"$acct\",\"registration_only\":true}" \
    prepaid-gas '30 Tgas' attached-deposit "$STORAGE_DEPOSIT" sign-as "$PARENT" network-config "$NET" sign-with-legacy-keychain send
done

step "6b guarded agent $AGENT2: function-call key on $ESCROW.pay only, full-access key removed"
FC="$CREDS/$AGENT2.fc.json"
if [[ ! -f "$FC" ]]; then
  (cd "$ROOT/gateway" && node -e 'const {KeyPair}=require("@near-js/crypto"); const k=KeyPair.fromRandom("ed25519"); require("fs").writeFileSync(process.argv[1], JSON.stringify({account_id:process.argv[2], public_key:k.getPublicKey().toString(), private_key:k.toString()}), {mode:0o600})' "$FC" "$AGENT2")
  near account add-key "$AGENT2" grant-function-call-access --allowance '0.25 NEAR' --contract-account-id "$ESCROW" --function-names pay \
    use-manually-provided-public-key "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_key"])' "$FC")" \
    network-config "$NET" sign-with-legacy-keychain send
fi
if [[ -f "$CREDS/$AGENT2.json" ]]; then
  FAK=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_key"])' "$CREDS/$AGENT2.json")
  near account delete-keys "$AGENT2" public-keys "$FAK" network-config "$NET" sign-with-legacy-keychain send
  mv "$CREDS/$AGENT2.json" "$CREDS/$AGENT2.deleted-full-access.json"   # no longer valid on chain
fi
funded=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$ESCROW\",\"method_name\":\"get_agent\",\"args_base64\":\"$(printf '{"agent":"%s"}' "$AGENT2" | base64 -w0)\"}}" | python3 -c 'import sys,json; r=json.load(sys.stdin); print(bytes(r["result"]["result"]).decode())')
if [[ "$funded" == null ]]; then
  echo "owner $PARENT funds $AGENT2 with $AGENT2_FUND USDC units (needs USDC on $PARENT)"
  have=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$USDC\",\"method_name\":\"ft_balance_of\",\"args_base64\":\"$(printf '{"account_id":"%s"}' "$PARENT" | base64 -w0)\"}}" | python3 -c 'import sys,json; r=json.load(sys.stdin); print(json.loads(bytes(r["result"]["result"]).decode()))')
  if (( have < AGENT2_FUND )); then # testnet demo: move the owner's USDC from the treasury (faucet USDC)
    near contract call-function as-transaction "$USDC" ft_transfer json-args "{\"receiver_id\":\"$PARENT\",\"amount\":\"$AGENT2_FUND\"}" \
      prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$TREASURY" network-config "$NET" sign-with-legacy-keychain send
  fi
  near contract call-function as-transaction "$USDC" ft_transfer_call \
    json-args "{\"receiver_id\":\"$ESCROW\",\"amount\":\"$AGENT2_FUND\",\"msg\":\"{\\\"agent\\\":\\\"$AGENT2\\\"}\"}" \
    prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$PARENT" network-config "$NET" sign-with-legacy-keychain send
  near contract call-function as-transaction "$ESCROW" set_policy \
    json-args "{\"agent\":\"$AGENT2\",\"policy\":{\"budget\":\"$AGENT2_BUDGET\",\"per_call_max\":\"$AGENT2_PER_CALL\",\"allow\":[\"$TREASURY\"]}}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$PARENT" network-config "$NET" sign-with-legacy-keychain send
else
  echo "$AGENT2 already funded: $funded"
fi

step "7/7 write .env files (keys come from $CREDS, never printed)"
setenv "$ENV" NEAR_GATEWAY_ACCOUNT_ID "$GATEWAY"
setenv "$ENV" NEAR_GATEWAY_KEY "$(key_of "$GATEWAY")"
setenv "$ENV" LEDGER_CONTRACT_ID "$LEDGER"
setenv "$ENV" X402_PAY_TO "$TREASURY"
setenv "$ENV" X402_RELAYER_ID "$RELAYER"
setenv "$ENV" X402_RELAYER_KEY "$(key_of "$RELAYER")"
setenv "$ENV" PAYOUT_CONTRACT_ID "$PAYOUT"
setenv "$ENV" SETTLER_ACCOUNT_ID "$TREASURY"
setenv "$ENV" SETTLER_KEY "$(key_of "$TREASURY")"
AENV="$ROOT/agent-client/.env"
[[ -f "$AENV" ]] || cp "$ROOT/agent-client/.env.example" "$AENV"
setenv "$AENV" AGENT_ACCOUNT_ID "$AGENT"
setenv "$AENV" AGENT_SECRET_KEY "$(key_of "$AGENT")"
setenv "$AENV" ESCROW_CONTRACT_ID "$ESCROW"
setenv "$AENV" GUARDED_AGENT_ID "$AGENT2"
setenv "$AENV" GUARDED_AGENT_FC_KEY "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["private_key"])' "$FC")"
setenv "$ENV" ESCROW_CONTRACT_ID "$ESCROW"
setenv "$ENV" USDC_CONTRACT_ID "$USDC"
FENV="$ROOT/frontend/.env.local"
setenv "$FENV" VITE_LEDGER_CONTRACT "$LEDGER"
setenv "$FENV" VITE_PAYOUT_CONTRACT "$PAYOUT"
chmod 600 "$ENV" "$AENV"

cat <<EOF

Done. Accounts on NEAR testnet:
  parent    $PARENT
  gateway   $GATEWAY     (ledger writer)
  treasury  $TREASURY    (x402 payTo + epoch settler)
  relayer   $RELAYER     (x402 gas sponsor)
  ledger    $LEDGER      https://testnet.nearblocks.io/address/$LEDGER
  payout    $PAYOUT      https://testnet.nearblocks.io/address/$PAYOUT
  agent     $AGENT       (open: full-access key, x402)
  escrow    $ESCROW      https://testnet.nearblocks.io/address/$ESCROW
  agent-2   $AGENT2      (guarded: function-call key on $ESCROW.pay only)
Next: get testnet USDC for $AGENT (and a little for $TREASURY) at https://faucet.circle.com (NEAR Testnet),
then run scripts/near-check.sh.
EOF
