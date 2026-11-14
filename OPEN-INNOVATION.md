# Open Innovation

**Something we haven't seen: the spare memory of everyday laptops, pooled into one AI model and sold as an open, paid, verifiable utility on NEAR.** Several ordinary laptops, Apple and NVIDIA together, serve a model none of them could load alone, behind an OpenAI-compatible API, with every payment and payout settled on chain.

Most laptops spend the day with gigabytes of RAM and GPU memory sitting idle, yet the models people want are too large for any single one of them. RAMX turns that idle memory into a shared resource: each laptop holds only the slice of model layers it can spare, and a **GPU Pool** of nearby machines serves the whole model. Apple laptops (MLX) and NVIDIA laptops (FP8) join the same pipeline, so the hardware people already own becomes inference capacity, with no data centre and no new GPUs. Distributed inference tools exist, but they stop at the cluster: they don't answer who may join, who gets paid, or how anyone can check the accounting. RAMX adds that missing layer and makes idle consumer memory an open market.

NEAR is what keeps that market open instead of run by one company. Anyone can join with a NEAR account; people and AI agents pay per request in USDC with x402; every balance change is signed and written to a NEAR contract, so anyone can verify the accounting; providers are paid from an on-chain Merkle payout; agents can be limited by an escrow contract the chain enforces; and a NEAR AI Cloud model in a TEE spot-checks answers, serves private requests and keeps the service answering when no laptops are online. The result is a new kind of public utility: **money, intelligence and ownership working together**, owned by the people whose laptops power it.

## Earn while you sleep

**Our aim is simple: a college student goes to sleep, and their laptop goes to work.** Every night, millions of student laptops sit in hostel rooms with gigabytes of RAM doing nothing. With RAMX, the student leaves the laptop on and in the pool. Overnight it holds a slice of a model and serves people and AI agents alongside the other laptops on the network. **In the morning, the student wakes up to earnings they can see and claim.**

| While the student sleeps | What they wake up to |
|---|---|
| The laptop serves the model layers it holds | **Credits** for every layer it served (90% of each request's credits go to the serving laptops, split by layers) |
| The laptop stays online and ready | A **readiness bonus** in credits, just for being available |
| AI agents pay for answers in USDC with x402 | **USDC**: 80% of that income is posted on chain each epoch, and the student claims their share with a Merkle proof, straight to their own NEAR account |
| The network gets busy | A higher **share ratio** (earned ÷ spent), so their own requests go to the front of the queue |

The credits pay for the student's own AI the next day, and the USDC is theirs to keep. No one has to trust a spreadsheet: every payment is a signed event on NEAR, and every payout is claimed by the provider itself. The rules keep it honest. Serving your own requests earns nothing, earnings unlock after an hour, and a laptop caught cheating loses them. This is the loop we ran on testnet three times, end to end: agents paid, a laptop answered, and its owner claimed exactly 80% of the income (see Proof below).

**Idle RAM becomes income, and the people who own the hardware own the network.**

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
| Agent pays, a laptop pool answers (Run 1 and the recorded Run 3) | [TSu5Cy…](https://testnet.nearblocks.io/txns/TSu5CyYnuLC8G4wAFmkPR1h3DJytX42LJ1rggfgUmfc), [CdHtTp…](https://testnet.nearblocks.io/txns/CdHtTp8EiMx1Yr5aRNLdwDceykVERCEfbTMpNFCJmeYJ) |
| Providers' epoch payout posted and claimed on chain, three separate times (4,800 of 4,800 units each) | [AuYYgQ…](https://testnet.nearblocks.io/txns/AuYYgQ1kdt1wU5NGxmEt8Ah3mi5fTDMQyqb2qoVh4wRw) → [B8ZaniL…](https://testnet.nearblocks.io/txns/B8ZaniLqcTAva9EoWiLuDZv1iqvfSi1dQVsxPhQhGPqK), [ALznCv…](https://testnet.nearblocks.io/txns/ALznCvBs2YqV3FHuNHzH3wYeFvczha4ZAwvAzspj1uBB) → [59jHuV…](https://testnet.nearblocks.io/txns/59jHuVDEJqiWqPw5eR76hjubuqQqRSQuQA3bKJ74T6Hd), [E7xsCi…](https://testnet.nearblocks.io/txns/E7xsCinFzbNFKCgSobtUQcF5mxKhK2tqwUPwYFG742pD) → [2MojW4…](https://testnet.nearblocks.io/txns/2MojW4wAUr7SWR46cdmd4eNfwA3Qo53dc35onPHquEdC) |
| A NEAR AI Cloud judge in a TEE checks a pool's answer; its signed verdict is on chain | [ApqcNg…](https://testnet.nearblocks.io/txns/ApqcNg5LjVMNY9KLJChtf4dmHvA4ZVex9vjLdbccjKpi) |
| 25 agents, each bidding with an LLM, buy pool capacity in sealed-bid rounds | [3R9Xui…](https://testnet.nearblocks.io/txns/3R9XuivrPFPEXTYoh8gSsEqU6J7aurQBB83o5gUN9ucQ), [z4HWQ8…](https://testnet.nearblocks.io/txns/z4HWQ8pKxZBQskzxjZTCrZqBVD4XK4C9pUVAAvMst97) |

## Try it

Open [ramx-eight.vercel.app](https://ramx-eight.vercel.app) and ask a question, or point any OpenAI client at `https://ramx-gateway.onrender.com/v1`.
