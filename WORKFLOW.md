# RAMX workflow

```
┌──────────────────────────────────────────────┐
│ 1. PROVIDER JOINS                            │
│ Laptop owner logs in (World ID / NEAR wallet)│
│ → Create / Join pool → run helper            │
│ → Parallax loads model layers on the laptop  │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ 2. NODE IS LISTED                            │
│ Node agent sends signed heartbeats           │
│ → gateway directory: pool ready, layers,     │
│   reliability, payout account (NEAR)         │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ 3. USER / AI AGENT GETS ACCESS               │
│ a) World ID   → 10,000 free starter credits  │
│ b) NEAR wallet→ 0 credits, top up with USDC  │
│ c) API key    → spends credits within a cap  │
│ d) no login   → pays per request (x402)      │
│ e) guarded agent → pays via escrow contract  │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ 4. REQUEST → GATEWAY                         │
│ OpenAI-style /v1/chat/completions            │
│ → hold credits, or 402 → USDC x402 payment   │
│   (relayer submits it on NEAR, pays gas)     │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ 5. ROUTING                                   │
│ Router picks a ready pool                    │
│ (reliability × free capacity)                │
│ → no pool ready? → NEAR AI Cloud (TEE model) │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ 6. INFERENCE                                 │
│ Parallax: M4 → M5 → RTX 4060                 │
│ each laptop runs its layers, passes hidden   │
│ states on → tokens stream back (SSE)         │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ 7. BILLING                                   │
│ bill = min(reported tokens, observed + 8)    │
│ credits split: 90% nodes · 5% burn · 5% rsv  │
│ receipt: model, route, cost, payment tx      │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ 8. CHECKS                                    │
│ 10% of pool answers → NEAR AI Cloud TEE judge│
│ (attestation + signed verdict on receipt)    │
│ over-reporting pool → loses reliability      │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ 9. AUDIT LEDGER (async)                      │
│ every balance change = signed event          │
│ → appended to ledger-v2.ramx.testnet         │
│ → anyone verifies: verify-event.ts <tx>      │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ 10. EPOCH PAYOUT                             │
│ every epoch: 80% of x402 USDC → providers    │
│ treasury posts Merkle root + USDC            │
│ → payout.ramx.testnet                        │
└──────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────┐
│ 11. PROVIDER CLAIMS                          │
│ claim-payout.ts → Merkle proof               │
│ → USDC lands in the provider's NEAR account  │
└──────────────────────────────────────────────┘
```

## Side flows

```
┌──────────────────────────────────────────────┐
│ GUARDED AGENT (security)                     │
│ owner funds escrow + sets policy             │
│ (payees, per-call max, budget, pause)        │
│ agent key = function-call on escrow.pay only │
│ → bad payment? contract refuses on chain     │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ CAPACITY MARKET (AI swarms)                  │
│ 30 s rounds: agents commit sealed bids       │
│ → reveal → one clearing price per model      │
│ → winners get priority slots                 │
│ → result written to the ledger               │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ PRIVACY                                      │
│ chain stores salted hashes, never text       │
│ x-ramx-privacy → trusted nodes or TEE        │
│ transcripts encrypted, deleted after 7 days  │
└──────────────────────────────────────────────┘
```
