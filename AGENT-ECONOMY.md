# Agent Economy

**Give AI a wallet, and something worth buying.** RAMX is a market where AI agents pay for compute with crypto directly: an agent calls an OpenAI-compatible API, gets an HTTP 402 with a price, pays in USDC on NEAR with x402, and receives its answer, with no sign-up, no subscription and no human in the loop.

AI agents are becoming customers, but most AI services still expect a human with a credit card. RAMX lets an agent buy inference on its own. The gateway runs its own x402 facilitator: a relayer submits the agent's signed USDC transfer and pays the gas, so the agent needs no NEAR for fees, and every payment lands on the ledger contract with a receipt the agent can check. On the other side of the market, laptop owners earn USDC for the answers their machines serve, paid each epoch through an on-chain Merkle payout. **Agents pay machines, machines get paid, and nobody has to trust a middleman's spreadsheet**: it runs on real USDC on NEAR testnet, with live transactions from payment to provider claim.

An agent economy also needs limits and price discovery. Owners choose how much freedom an agent gets: an **open agent** pays per request with x402 under a budget cap, and a **guarded agent** holds only a function-call key for `escrow.pay`, so a contract enforces its payees and budget. Owners can also issue API keys with credit caps. Agents **negotiate** for scarce capacity in a sealed-bid market, where 25 agents with their own NEAR accounts clear one fair price per model each round. And because the API speaks OpenAI's protocol, existing agents and tools such as **OpenCode** use RAMX by changing two settings, while API keys and other secrets in a prompt are replaced by placeholders before any untrusted machine sees them.

## How RAMX answers the track

| The track asks for | RAMX |
|---|---|
| Agents that **pay for compute with crypto directly** | x402 payments in USDC (NEP-141) on NEAR, per request, gas paid by a relayer |
| Agents that **spend** within limits | Budget caps, API keys with credit limits, escrow-limited guarded agents |
| Agents that **negotiate** | Sealed-bid capacity market: commit, reveal, one uniform price per model |
| Agents that **earn** | The laptops serving agents earn USDC every epoch, claimed with a Merkle proof |
| **Give AI a wallet** | Open wallet (x402) or a guarded wallet the chain limits |
| Tag: **agent commerce** | Every agent purchase is a NEAR transaction and a signed ledger event |

## Proof on NEAR testnet

| What | Transaction |
|---|---|
| Agent pays per request with x402 | [G3rzbD…](https://testnet.nearblocks.io/txns/G3rzbD1y6sEfAfJA79tH8aQmBYsj3jYDEEM5XphzNJY4), [2v7At7…](https://testnet.nearblocks.io/txns/2v7At7Ez6x31TtsaZyntsBSPrwnuBVmoygSDPXgMgdth) |
| Agent pays, answer served by a laptop pool | [Gpxq3h…](https://testnet.nearblocks.io/txns/Gpxq3hxD4JVWvgmAS2Ps6Y4j4DG2CyQWoSssWYvzk1j3) |
| Guarded agent pays through the escrow | [9gFGWr…](https://testnet.nearblocks.io/txns/9gFGWr23xEkdqPXF97T5Y5FHNgP6caHTaqA7sEyRXaPh) |
| The provider claims what agents paid | [B8ZaniL…](https://testnet.nearblocks.io/txns/B8ZaniLqcTAva9EoWiLuDZv1iqvfSi1dQVsxPhQhGPqK) |

## Try it

```bash
pnpm --filter @ramx/agent-client start --questions 1   # an agent pays with x402 and gets an answer
pnpm --filter @ramx/agent-client start --goal "Can three 16 GB laptops run a 14B model?"   # the model decides each purchase
pnpm --filter @ramx/swarm-sim start                    # 25 agents bid for capacity
```

**Scope, stated plainly:** `agent-client` has two modes. By default it asks a fixed list of questions (the recorded runs above). With `--goal`, before each purchase it asks the model, in a paid request, what to buy next or whether it is done, sees what it already bought and its budget, and stops on its own. Any OpenAI-compatible agent can pay the same way. NEAR Intents has no testnet, so agents pay with x402 and our own escrow contract rather than Intents.
