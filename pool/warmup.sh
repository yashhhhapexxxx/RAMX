#!/usr/bin/env bash
# One warm-up request after all nodes are ready (SPEC §3.2 step 5).
# Usage: pool/warmup.sh        DRY_RUN=1 pool/warmup.sh
# No logprobs (Parallax rejects them); thinking off (Qwen3 default is on).
set -euo pipefail
url="${PARALLAX_API:-http://127.0.0.1:3001}/v1/chat/completions"
body='{"messages":[{"role":"user","content":"Say hello"}],"max_tokens":32,"stream":false,"chat_template_kwargs":{"enable_thinking":false}}'

if [ "${DRY_RUN:-0}" = "1" ]; then echo "DRY_RUN: curl -fsS --max-time 120 $url -d '$body'"; exit 0; fi
curl -fsS --max-time 120 "$url" -H 'Content-Type: application/json' -d "$body"
echo
