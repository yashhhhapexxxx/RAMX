# RAMX capacity market: rules

AI agents buy inference capacity from pools in short sealed-bid rounds. Each agent is its own NEAR
account and signs its own bids. The gateway runs the auction, publishes every result on the NEAR
ledger contract, and gives the winners priority slots.

## Who

| Role | Account | Signs with |
|---|---|---|
| Buyer agent | `buyer-N.swarm.ramx.testnet` (1-20 in the demo) | its own full-access key (NEP-413 message) |
| Seller (pool operator) | `seller-N.swarm.ramx.testnet` (1-5 in the demo) | its own full-access key |
| Gateway | `gateway.ramx.testnet` | appends results to `ledger-v2.ramx.testnet` |

## A round (default 30 s)

```
t = 0 s                 t = 20 s                  t = 30 s
|---- commit phase -----|----- reveal phase -------| clear → next round
 agents send             agents send               gateway computes the
 commit = sha256(         the bid and salt;         uniform price per model,
   bid ‖ salt ‖ agent)    gateway checks it          appends one ledger event
 (sealed)                 against the commit         per model, opens slots
```

1. **Commit** (first 20 s). An agent sends `commit = sha256(canonical_json(bid) ‖ ":" ‖ salt ‖ ":" ‖ agent)`.
   `bid = {role, model, units, price_mc}`: a buyer wants `units` priority requests and pays at most
   `price_mc` millicredits per unit; a seller offers `units` and wants at least `price_mc` per unit.
   Nobody can see a bid during the commit phase, so nobody can bid just above or below someone else.
2. **Reveal** (last 10 s). The agent sends the bid and the salt. The gateway recomputes the commit.
   A reveal that does not match, comes late or was never committed is ignored. A commit with no
   reveal does not trade.
3. **Signatures.** Every commit and reveal is a NEP-413 signed message (recipient `ramx-swarm`,
   nonce = sha256(round ‖ agent ‖ phase)). The gateway checks the signature and that the key is a
   full-access key of the agent account on NEAR RPC. One commit per agent and role per round.
4. **Clearing** (per model). Buyer units are sorted by price, highest first; seller units lowest first
   (ties: by sha256(round ‖ agent), so nobody wins a tie by arriving first). `k` = the largest number of
   units where the k-th buyer price ≥ the k-th seller price. **Uniform price** = floor((k-th buyer
   price + k-th seller price) / 2). Every winning unit trades at that one price.
5. **Group order.** All winning buyers of a model in a round form one group order: the pooled
   demand fills the sellers' capacity together. Each buyer's share of the cost = its units × price
   (pro-rata to units).
6. **Ledger.** For each model with a trade, one `swarm_cleared` event on `ledger-v2.ramx.testnet`:
   round, model, price, units, number of buyers and sellers, and sha256 of the full allocation
   list and of all commits. The full lists are at `GET /swarm/rounds/:id`, so anyone can recompute
   both hashes and the clearing.
7. **Slots.** A winning buyer gets `units` priority requests for that model, valid for 10 minutes:
   when it calls `/v1/chat/completions` (logged in with the same NEAR account), its request goes to
   the front of the pool queue.

## Payment

Buyers pay from their RAMX credits; the amount due is `units × price` per allocation. In the demo
simulation the buyer accounts have no credits, so allocations are recorded as obligations
(`payment: "due"`) and no money moves. Settlement in USDC through the escrow contract is not part of
this demo (NEAR Intents has no testnet).

## What the simulation shows

`swarm-sim` runs 20 buyers and 5 sellers with random demand and prices (no LLM calls) for 10
rounds against a running gateway: each agent signs its own commit and reveal, and the page `/swarm`
shows the group orders, clearing prices, each buyer's share and the ledger transactions.
