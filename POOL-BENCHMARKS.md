# GPU Pool benchmarks: real laptops, real runs

RAMX's distributed inference is not a simulation. The pools below were run by our team on our own laptops, connected over a local network with [Parallax](https://github.com/GradientHQ/parallax), each machine holding only a slice of the model's layers. Every number here was measured on those machines.

**Where these numbers come from.** All runs were measured during this hackathon. 

## Hardware

| Machine | Memory | Backend | Role |
|---|---|---|---|
| Linux laptop with NVIDIA **RTX 4060** | 8 GB VRAM | Parallax, FP8 (CUDA) | Coordinator and node |
| Apple **M4** MacBook Air | 16 GB unified | Parallax, MLX 8-bit | Node |
| Apple **M5** MacBook Air | 16 GB unified | Parallax, MLX 8-bit (≈ 10.9 GB usable by the GPU by default) | Node |

## Results

| # | Laptops in the pool | Model | How the model is split | Speed | What it proves |
|---|---|---|---|---|---|
| 1 | **1** · RTX 4060 | Qwen3-0.6B | whole model on the 4060 | **≈ 135 tok/s** | One NVIDIA laptop serves a model on its own |
| 2 | **1** · M4 MacBook Air | Qwen3-8B (MLX 8-bit) | whole model on the M4 | **≈ 7.9 tok/s** | A Mac joins the pool over the local network |
| 3 | **2** · M4 + RTX 4060 | Qwen3-14B | M4: layers 0–28 → 4060: layers 29–39 | **5.2–6.0 tok/s** · first token 0.65–1.2 s | Apple + NVIDIA run one model **neither laptop can run alone** |
| 4 | **3** · M4 + M5 + RTX 4060 | Qwen3-14B | M4: 0–13 → M5: 14–28 → 4060: 29–39 | **7.92 tok/s** (median) · first token 0.43 s | Three-laptop pipeline, 5 of 5 runs passed |
| 5 | **1** · RTX 4060 with llama.cpp (reference, not a pool) | Qwen2.5-7B (4-bit) | whole model | **53.5 tok/s** | The single-GPU speed limit, for comparison |
| 6 | **PROOF** | Qwen3-8B | chosen by Parallax | 3 paid answers | Paid with x402 ([Gpxq3h…](https://testnet.nearblocks.io/txns/Gpxq3hxD4JVWvgmAS2Ps6Y4j4DG2CyQWoSssWYvzk1j3)), ledger events #24–26 verified, provider payout claimed ([B8ZaniL…](https://testnet.nearblocks.io/txns/B8ZaniLqcTAva9EoWiLuDZv1iqvfSi1dQVsxPhQhGPqK)) |

*tok/s = tokens generated per second. Layer numbers are the model layers each laptop holds (Qwen3-14B has 40).*

## What we learned on real hardware

- **Memory pressure is the main enemy on 16 GB Macs.** The baseline M4 + 4060 run swapped 2.7 GiB and stalled 12 times (> 400 ms). With `--kv-cache-memory-fraction 0.25 --max-sequence-length 4096` on the Mac, swap fell to 0.32 GiB, stalls to 2, and speed nearly doubled.
- **One request at a time leaves each stage idle about 2/3 of the time** in a 3-stage pipeline; decode is bounded by weight reads (≈ 95 ms/token, ≈ 10.5 tok/s ceiling for Qwen3-14B on this pool). Batching several requests per pool is the next throughput step.
- **Apple and NVIDIA need different weight formats** (MLX 8-bit vs FP8) of the same model, but serve one pipeline; the coordinator keeps both formats and each Mac only its own.
- **Network:** a 100 Mbps adapter is enough for inference (hidden states are small) but slow for copying model files; use gigabit Ethernet for setup.

## Next

-We have already started onboarding campus students laptops for testing our RAMX product and will move on forward to generating revenue  