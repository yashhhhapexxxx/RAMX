# AI Security & Defense

**Give AI money without handing it the keys to everything.** In RAMX, an AI agent can pay for its own inference, and a prompt-injected agent still cannot pay a stranger, overspend or rewrite its limits, because the limits are enforced by a NEAR contract, not by the agent.

The weak point of every agent with a wallet is the agent itself: one prompt injection and it pays whoever the attacker names. On NEAR it is worse than it looks, because an x402 payment is signed with a full-access key that could move all of the agent's USDC. RAMX does not try to make the model behave; it takes the power away. A **guarded agent** holds only a NEAR **function-call key** that can call `escrow.pay` on `escrow.ramx.testnet` and nothing else, and the escrow contract enforces the owner's policy on chain: an **allow list of payees, a per-call maximum, a total budget and a pause switch** that only the owner controls. Our attack demo plays a fully compromised agent and makes five attempts: pay a stranger, exceed the per-call cap, drain the budget, call the USDC contract directly with the key, and rewrite its own policy. **All five are refused by the chain**, next to a legitimate payment that goes through and gets its answer.

The same "trust, but verify" rule runs through the rest of the system. Pools of strangers' laptops invite cheating, so billing is capped at what the gateway observed, a pool that over-reports loses reliability and therefore traffic, and a NEAR AI Cloud model in a **TEE** spot-checks pool answers with a fresh-nonce **attestation** and a signed verdict. Answers served by the enclave carry its signature over the exact request and answer. Earnings vest for an hour and can be clawed back. Every balance change is an ed25519-signed event on a ledger contract that refuses gaps and duplicates, logins are checked against on-chain keys, and secrets an agent pastes into a prompt (API or private keys) are swapped for placeholders before any untrusted laptop sees them.

## How RAMX answers the track

| The track asks for | RAMX |
|---|---|
| **Spending limits** | Per-call maximum and total budget, enforced by `escrow.ramx.testnet`; API keys with credit caps; x402 agents with a client-side budget |
| **Policy engines** | The escrow policy (allowed payees, per-call cap, budget, pause), changeable only by the owner |
| **Sandboxed wallets** | The guarded agent's key is a function-call key limited to `escrow.pay`: it cannot transfer USDC or touch any other contract |
| **Blocks a prompt-injected payment** *(their idea)* | Paying anyone outside the allow list is refused on chain, live |
| **Reputation and scam detection** | Pool reliability (success and uptime) drives routing; the TEE judge flags implausible answers; over-reporting and cheating cost reliability and vested earnings |
| Tags: agent security · **function-call keys** · **TEE attestation** | All three, live on NEAR testnet |

## Proof on NEAR testnet

| What | Transaction |
|---|---|
| Refused: payee not on the allow list | [J4YypM…](https://testnet.nearblocks.io/txns/J4YypMMUmYSDv87xA4bAjUTTUELAaFofrzy5zS7J3hja) |
| Refused: above the per-call limit | [EKwP6t…](https://testnet.nearblocks.io/txns/EKwP6tQZLgaHQNFS9ALqJavzjpUD73t4VrZH1TAJxTFG) |
| Allowed: guarded agent pays through the escrow and gets its answer | [9gFGWr…](https://testnet.nearblocks.io/txns/9gFGWr23xEkdqPXF97T5Y5FHNgP6caHTaqA7sEyRXaPh) |

## Try it

```bash
pnpm --filter @ramx/agent-client attack       # five attacks by a compromised agent, five on-chain refusals
node gateway/src/verify-event.ts <tx>         # check any ledger event's signature yourself
```

**Scope, stated plainly:** the gateway still produces the records; the chain makes them tamper-evident, and the escrow makes agent spending provably bounded.
