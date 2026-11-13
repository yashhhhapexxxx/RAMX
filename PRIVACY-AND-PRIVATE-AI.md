# Privacy & Private AI

**RAMX runs AI inference on other people's laptops and settles every request on a public blockchain, yet the words of a prompt never have to leave the people and hardware the user chooses.** Privacy is set per request, enforced by the gateway, proven by hardware attestations and signed ledger events, and checkable by the user on their own machine.

Pooling strangers' laptops is the opposite of private, and public accountability usually leaks content. RAMX treats both as design constraints. The caller decides who may see each request: their own and trusted laptops, or only a NEAR AI Cloud model inside secure hardware (a TEE), optionally **end-to-end encrypted** so that even the RAMX gateway relays nothing but ciphertext. Ordinary requests are protected too: personal data is replaced with placeholders before an untrusted laptop sees it. Meanwhile the NEAR ledger records every paid request as salted hashes only, so payments and accounting stay fully public while the text stays with its author, or inside hardware that can prove it.


## How RAMX answers the track

| The track asks for | RAMX |
|---|---|
| **AI that works on sensitive data without exposing it to anyone, including you** | End-to-end encryption to the enclave: the client encrypts to a key it attested itself, and the RAMX gateway relays only ciphertext |
| **See proof the model ran in a TEE** *(from their idea)* | Every enclave answer carries a fresh-nonce Intel TDX attestation and the enclave's signature over the exact request and answer, recorded as a signed ledger event and checkable with one command |
| **Confidential computation** | `tee` mode runs the request only inside NEAR AI Cloud secure hardware; `trusted-all` never falls back to an untrusted laptop |
| **Private by design** | Personal data is replaced before untrusted laptops see a prompt; the public ledger holds salted hashes, never text |
| Tags: **Private AI** · **TEE** · **NEAR AI Cloud** | All three, live on the hosted gateway |

---

## Privacy modes

Set per request with the `x-ramx-privacy` header.

| Mode | Where the prompt is processed | When to use it |
|---|---|---|
| *(none)* | Any laptop in the GPU Pool; emails, phone numbers, card numbers and secrets are replaced by placeholders first | Everyday prompts |
| `trusted-ends` | The first and last model layers (where readable text enters and leaves) run only on the requester's own or trusted accounts' laptops | Pools mixing trusted and untrusted laptops |
| `trusted-all` | Every layer runs on trusted laptops; if none is online, the request goes to secure hardware, never to an untrusted laptop | Sensitive prompts inside a known group |
| `tee` | A NEAR AI Cloud model inside an Intel TDX + NVIDIA enclave; no laptop sees it | Sensitive prompts, anywhere |
| `tee` + end-to-end encryption | As `tee`, but the client encrypts every message to the enclave's attested key; only the enclave can decrypt | Prompts that must not be readable even by RAMX |

## Protections

| Protection | How it works |
|---|---|
| **End-to-end encryption to the enclave** | The client fetches the enclave's attestation report itself (public endpoint, its own random nonce, Intel TDX quote), encrypts each message to the attested Ed25519 key (X25519 + HKDF-SHA256 + XChaCha20-Poly1305), and decrypts the answer locally. The gateway accepts encryption only with `tee` and forwards the ciphertext unchanged, so it can never reach a laptop. |
| **Personal data stays off untrusted laptops** | Before a prompt reaches a laptop pool, emails, phone numbers, card numbers (checksum-validated) and secrets such as API or private keys become placeholders like `[EMAIL_1]`; the real values are restored in the answer, including across streamed chunks. Nothing about the mapping is stored. |
| **Attested, signed answers** | Every answer from the enclave carries a fresh-nonce attestation on its receipt and the enclave's signature over the exact request and answer bytes, verified against an attested key (the model's, or NEAR AI's gateway enclave for streamed answers) and recorded as a signed ledger event. |
| **Salted hashes on chain** | Ledger events hold `sha256(salt:prompt)` and `sha256(salt:answer)` with a fresh 16-byte salt per request, returned only to the caller. The caller can prove their receipt matches the chain; nobody can search the ledger for short, guessable prompts. |
| **Signed privacy mode** | The mode, and `e2ee: true` for encrypted requests, is signed into the request's ledger event, so a user can prove on chain how their request was handled. |
| **Minimal retention** | Private requests keep no transcript. Ordinary transcripts are encrypted at rest with AES-256-GCM and deleted after 7 days. Private requests are never sampled by the TEE spot-check. |

## Who sees your prompt

| Who | Normal | `trusted-ends` | `trusted-all` | `tee` | `tee` + end-to-end encryption |
|---|---|---|---|---|---|
| **RAMX gateway** | In memory only | In memory only | In memory only | In memory only, passed to the enclave | **Ciphertext only** |
| **First and last layer laptop** (reads the text) | Any pool member, personal data replaced by placeholders | Only you or trusted accounts | Only you or trusted accounts | No laptop | No laptop |
| **Middle layer laptops** (intermediate numbers, not text) | Any pool member | Any pool member | Only you or trusted accounts | No laptop | No laptop |
| **NEAR AI Cloud enclave (TEE)** | Only when no pool is ready | Only when no trusted pool is ready | Only when no trusted pool is ready | Always, attested | Always; the only place the text is decrypted |
| **TEE spot-check** (10% of pool answers) | May be sampled | Never | Never | Never | Never |
| **Stored transcript** | Encrypted, deleted after 7 days | None | None | None | None |
| **Public receipt and NEAR ledger** | Salted hashes, payer, model, cost | + signed mode | + signed mode | + signed mode, enclave answer signature | + signed `e2ee: true` |

## Verify it yourself

Nothing here asks the user to trust the gateway. The agent client checks every claim on the user's own machine:

```bash
pnpm --filter @ramx/agent-client private --mode tee   # private request
pnpm --filter @ramx/agent-client private --e2ee       # end-to-end encrypted
```

It confirms that the public receipt holds no text and no salt; recomputes the prompt and answer hashes and matches them to the receipt; finds the NEAR ledger event, verifies its signature against the key the contract publishes, and confirms it contains no word of the prompt; and fetches the enclave's attestation with its own nonce. With `--e2ee` it also attests the enclave before sending, sends only ciphertext, and decrypts the answer locally.

## Evidence

| What | Result |
|---|---|
| `tee` request on the hosted gateway | Served in secure hardware with attestation; caller recomputed both salted hashes; the ledger event contains no text. Payment [GWcfcW…](https://testnet.nearblocks.io/txns/GWcfcW9BQF8q59UernT5zcc8utbH4m9fymNpyX1NtQg), ledger event [Cmsm3o…](https://testnet.nearblocks.io/txns/Cmsm3oEZxPbhiQK2DmrFTmHD8rvJozLRuQA5sBMi8L9g) |
| `trusted-all` with no trusted laptop online | Sent to secure hardware instead of an untrusted laptop. Payment [4Tbba2…](https://testnet.nearblocks.io/txns/4Tbba2xTADjtnE8KCC1PVDcjg6UAehNktecnC4ssQ36b), ledger event [BjBAz9…](https://testnet.nearblocks.io/txns/BjBAz9RrLiLJuCwaNSjkpnTAYQ2xvapcGabHs3HVnQdm) |
| Self-check run | All 11 checks passed on the user's machine. Ledger event [6EsV1Y…](https://testnet.nearblocks.io/txns/6EsV1YRJGcyuPdtrN6BHiML7vgQexXzdDnBYcnqi8fxD) |
| End-to-end encrypted request on the hosted gateway | The client attested the enclave, RAMX relayed only ciphertext, the answer was decrypted on the client; the signed ledger event says `e2ee: true` and contains no text; the enclave's signature over the exact bytes is valid; all 16 self-checks passed. Payment [HJTFzc…](https://testnet.nearblocks.io/txns/HJTFzcamXQFZ8pm4DxS3U2vgy8bsSDqTBHtibLWP4pRH), ledger event [yhGjQC…](https://testnet.nearblocks.io/txns/yhGjQC65PQGnE17wmZuC7auC8mypBpHnbZCfudrj9rR) |

## Limits

- **Without encryption, the gateway reads prompts in memory** to route and bill them; end-to-end encryption removes that.
- **Placeholders are pattern-based:** they cover emails, phone numbers, card numbers and secrets, not names or other free-text details.
- **Trust in the enclave** rests on Intel TDX and NVIDIA attestation and on NEAR AI Cloud's attested code.
- **"Trusted" laptops** are trusted by the user's choice; RAMX adds no encryption between pool laptops, so pools should run on a private network.
- **The browser chat** does not use end-to-end encryption yet; the API and agent client do.
