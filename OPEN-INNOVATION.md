# Open Innovation

**Something we haven't seen: the spare memory of everyday laptops, pooled into one AI model and sold as an open, paid, verifiable utility on NEAR.** Several ordinary laptops, Apple and NVIDIA together, serve a model none of them could load alone, behind an OpenAI-compatible API, with every payment and payout settled on chain.

Most laptops spend the day with gigabytes of RAM and GPU memory sitting idle, yet the models people want are too large for any single one of them. RAMX turns that idle memory into a shared resource: each laptop holds only the slice of model layers it can spare, and a **GPU Pool** of nearby machines serves the whole model. Apple laptops (MLX) and NVIDIA laptops (FP8) join the same pipeline, so the hardware people already own becomes inference capacity, with no data centre and no new GPUs. Distributed inference tools exist, but they stop at the cluster: they don't answer who may join, who gets paid, or how anyone can check the accounting. RAMX adds that missing layer and makes idle consumer memory an open market.

NEAR is what keeps that market open instead of run by one company. Anyone can join with a NEAR account; people and AI agents pay per request in USDC with x402; every balance change is signed and written to a NEAR contract, so anyone can verify the accounting; providers are paid from an on-chain Merkle payout; agents can be limited by an escrow contract the chain enforces; and a NEAR AI Cloud model in a TEE spot-checks answers, serves private requests and keeps the service answering when no laptops are online. The result is a new kind of public utility: **money, intelligence and ownership working together**, owned by the people whose laptops power it.

## Why it is new

| Existing approach | What RAMX adds |
|---|---|
| Cloud AI APIs | Capacity from laptops people already own; providers earn |
| Distributed inference tools | Open membership, payments, payouts and a public, verifiable ledger |
| Crypto compute markets | Consumer laptops (Mac + NVIDIA) splitting one model, OpenAI-compatible, with per-request privacy and TEE checks |

## Proof

| What | Evidence |
|---|---|
| One model across three laptops (M4 + M5 + RTX 4060, Qwen3-14B) | 5 of 5 runs, median 7.92 tok/s: [POOL-BENCHMARKS.md](POOL-BENCHMARKS.md) |
| Agent pays, a laptop pool answers | [TSu5Cy…](https://testnet.nearblocks.io/txns/TSu5CyYnuLC8G4wAFmkPR1h3DJytX42LJ1rggfgUmfc) |
| Providers' epoch payout posted and claimed on chain | [AuYYgQ…](https://testnet.nearblocks.io/txns/AuYYgQ1kdt1wU5NGxmEt8Ah3mi5fTDMQyqb2qoVh4wRw), [B8ZaniL…](https://testnet.nearblocks.io/txns/B8ZaniLqcTAva9EoWiLuDZv1iqvfSi1dQVsxPhQhGPqK) |

## Try it

Open [ramx-eight.vercel.app](https://ramx-eight.vercel.app) and ask a question, or point any OpenAI client at `https://ramx-gateway.onrender.com/v1`.
