# contracts-near

RAMX smart contracts on NEAR (Rust, `near-sdk` 5.30). Testnet only.

| Contract | Account | What it does |
|---|---|---|
| `ledger` | `ledger.ramx.testnet` | Ordered, append-only audit log. The gateway appends every signed balance-change event (`append_batch(first_seq, events)`); each one is published as a NEP-297 log `EVENT_JSON:{"standard":"ramx","event":"ledger","data":[{"seq":N,"event":{…}}]}`. Sequence = gateway event id, so a retried batch is rejected instead of duplicated. |
| `payout` | `payout.ramx.testnet` | Epoch payouts in USDC. The settler posts a Merkle root and funds it in one `ft_transfer_call`; providers claim with a proof. |

## Build and test

```bash
cd contracts-near
cargo test                                   # unit tests (native)
cd ledger && cargo near build non-reproducible-wasm   # → ../target/near/ramx_ledger/ramx_ledger.wasm
```

Tools: `rustup target add wasm32-unknown-unknown`, `cargo-near` and `near` (near-cli-rs), from their GitHub releases.

## Deploy the ledger (testnet)

```bash
# 1. The gateway's signing public key (the ledger publishes it so anyone can verify events)
PUBKEY=$(cd ../gateway && node --env-file=.env src/verify-event.ts --pubkey)

# 2. Create the contract account and deploy + init in one go
near account create-account fund-myself ledger.ramx.testnet '3 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as ramx.testnet network-config testnet sign-with-legacy-keychain send
near contract deploy ledger.ramx.testnet use-file target/near/ramx_ledger/ramx_ledger.wasm \
  with-init-call new json-args "{\"writer\":\"gateway.ramx.testnet\",\"pubkey\":\"$PUBKEY\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send

# 3. Check
near contract call-function as-read-only ledger.ramx.testnet seq json-args {} network-config testnet now
```

Then set `LEDGER_CONTRACT_ID=ledger.ramx.testnet`, `NEAR_GATEWAY_ACCOUNT_ID=gateway.ramx.testnet` and `NEAR_GATEWAY_KEY=ed25519:…` in `gateway/.env`. Verify any ledger transaction with `node gateway/src/verify-event.ts <tx_hash>`.

A fresh gateway database starts its event ids at 1 again: deploy a new ledger account for it (the writer stops with a clear error if the contract and the database do not match).
