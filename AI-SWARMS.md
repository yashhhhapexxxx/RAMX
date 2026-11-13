# AI Swarms

**Many agents, one economy.** In RAMX, a swarm of AI agents, each on its own NEAR sub-account, **pools demand and runs sealed-bid rounds against sellers** to buy priority inference capacity: one fair price per model, every round recorded on chain, and nothing any agent has to take on trust.

When many agents share scarce compute, someone has to decide who goes first, and a first-come queue rewards whoever spams fastest. RAMX lets the swarm decide with a market. 25 autonomous agents (`buyer-1…20.swarm.ramx.testnet`, `seller-1…5.swarm.ramx.testnet`) trade priority slots in 30-second rounds. In the first 20 seconds each agent commits `sha256(bid ‖ salt ‖ agent)`, so no one can see and undercut another's bid; in the last 10 it reveals, and the gateway checks the commit and the agent's NEP-413 signature against its on-chain keys. Each model clears at **one uniform price**, ties are broken by a hash rather than by arrival time, and all winning buyers of a model are pooled into one **group order** that fills the sellers' capacity together, each paying pro rata. Winners get real priority in the inference queue for the next 10 minutes.

What makes it a swarm rather than one bot is that no agent trusts the coordinator. Every cleared round is written to the NEAR ledger as a signed `swarm_cleared` event with the price, the units, the number of buyers and sellers, and the sha256 of the full allocation list and of every commit. The full lists are public at `GET /swarm/rounds/:id`, so any agent can recompute both hashes and rerun the clearing to confirm it was not cheated. The `/swarm` page shows rounds, group orders, prices and each buyer's share live.

## How RAMX answers the track

| The track asks for | RAMX |
|---|---|
| **A group-buying swarm: buyer agents pool demand and run sealed-bid rounds against sellers, each on its own sub-account** *(their idea)* | Built: 20 buyers and 5 sellers on `*.swarm.ramx.testnet` sub-accounts, sealed commit-reveal rounds, pooled group orders |
| **Coordination markets, bidding** | 30-second rounds, one uniform clearing price per model, hash tie-breaks |
| **Collective purchasing** | All winners of a model form one group order, shares pro rata |
| **Economies that emerge between agents** | Prices move with the agents' own demand and supply each round |
| Tags: **multi-agent systems** · **sub-accounts** · NEAR Intents | Multi-agent and sub-accounts live; Intents has no testnet (see scope) |

## Proof on NEAR testnet

| What | Transaction |
|---|---|
| A capacity-market round cleared and recorded | [GfbcX7…](https://testnet.nearblocks.io/txns/GfbcX7ofwgcJHVG2Q2meXCjpEGdXn3zZ1dypo2QP88jz) |

## Try it

```bash
pnpm --filter @ramx/swarm-sim start    # 25 agents sign and bid for 10 rounds; watch /swarm in the app
```
Rules: [swarm-sim/RULES.md](swarm-sim/RULES.md).

**Scope, stated plainly:** in the simulation, buyers' allocations are recorded as obligations (`payment: "due"`). Settling them in USDC through the escrow contract, so a swarm of guarded agents trades within on-chain limits, is next; NEAR Intents settlement waits for an Intents testnet.
