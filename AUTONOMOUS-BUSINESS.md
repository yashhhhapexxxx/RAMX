# Autonomous Business

**The company of none: a compute business that prices, sells, bills and pays its suppliers by itself, while humans only set the rules.** Students' laptops sell AI inference while their owners sleep; the network sets prices from demand, splits every payment by rules in one config file, and pays providers on chain every epoch, with no payroll and no operator in the loop.

A college student's laptop sits idle for eight hours every night. RAMX turns that machine into a small business that runs while its owner sleeps. The student joins a GPU Pool once and leaves RAMX running; overnight the laptop holds its slice of an AI model, serves requests from people and AI agents, and gets paid for every answer it helps produce. It earns two ways: **money**, a share of what every customer pays, settled to the student's own account each payout period; and **compute**, credits for the same AI models, so the work the laptop does at night pays for the student's own AI use the next day. The more they share, the further up the queue they move.

The business side runs itself. Prices reset every 30 seconds from live demand, from half price when capacity is idle to double under contention, so a quiet night still fills up and a busy one earns more. Every payment is split automatically: credits 90% to the laptops by the layers each served, 5% burned and 5% to a reserve; customer payments 80% to providers, 10% to the reserve and 10% to operations. Each epoch the treasury builds a Merkle tree of what every provider earned, funds it and posts it on chain, and each provider claims its own share. The rules protect the business from its own members: earnings vest for an hour and are taken back if a laptop is caught cheating, customers are billed only for what was delivered, and their personal data is hidden from the laptops that serve them. Every money movement is a signed, public event.

## How RAMX answers the track

| The track asks for | RAMX |
|---|---|
| **Runs its own treasury** | The treasury account receives customer payments, funds each epoch's payout and keeps a reserve, by rule |
| **Sales** | An OpenAI-compatible API that sells answers to people and AI agents, priced automatically every 30 seconds |
| **Revenue sharing** | Fixed splits in one config file (`shared/config/ramx.config.json`), applied to every request and every epoch |
| **Splits revenue by rules in one config file** *(from their idea)* | `credit_split_bps` 90/5/5 and `x402_split_bps` 80/10/10 |
| **Humans only set the constraints** | Owners set the config, budgets and escrow policies; pricing, billing, splitting and payouts run on their own |

## Proof on NEAR testnet

| What | Transaction |
|---|---|
| Treasury posts the epoch payout (Merkle root + funds) | [AuYYgQ…](https://testnet.nearblocks.io/txns/AuYYgQ1kdt1wU5NGxmEt8Ah3mi5fTDMQyqb2qoVh4wRw) |
| A laptop's owner claims their share | [B8ZaniL…](https://testnet.nearblocks.io/txns/B8ZaniLqcTAva9EoWiLuDZv1iqvfSi1dQVsxPhQhGPqK) |

**Scope, stated plainly:** the business runs on rules, not on an AI agent making decisions, and providers claim their payout with one command (an automatic morning claim is next).
