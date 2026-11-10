import { useState } from "react";
import { CodeBox } from "../console/CopyButton";
import CopyButton from "../console/CopyButton";
import { Icon } from "../Icon";
import { env } from "../../config/env";
import { PRICES } from "../../lib/credits";

const MODEL = "Qwen/Qwen3-14B-FP8";

/** API base for snippets: the configured gateway, or this site when the gateway is same-origin. */
const apiBase = () => `${(env.gatewayUrl || (typeof location !== "undefined" ? location.origin : "")).replace(/\/$/, "")}/v1`;

function snippets(base: string) {
  return {
    curl: `# With an account: use the session token from World login.
curl ${base}/chat/completions \\
  -H "Authorization: Bearer $RAMX_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${MODEL}",
    "max_tokens": 512,
    "stream": true,
    "messages": [{ "role": "user", "content": "How does pooling work?" }]
  }'
# The gateway holds the maximum cost, streams the reply,
# then settles the real cost in credits.`,
    x402: `// Without an account: pay per request with x402 (spec §7.2).
// Illustrative. The real client lives in agent-client/.
const url = "${base}/chat/completions";
const body = JSON.stringify({ model: "${MODEL}", max_tokens: 512, messages });

// 1. No token, no payment → HTTP 402 with the price and the treasury account.
let res = await fetch(url, { method: "POST", body });
if (res.status === 402) {
  const req = await res.json();
  // 2. Sign a payment (USDC on NEAR testnet) and send the request again.
  const payment = await wallet.pay(req);
  res = await fetch(url, { method: "POST", body, headers: { "X-PAYMENT": payment } });
}
// 3. The facilitator settles on NEAR, the gateway serves the request
//    and records the payment on the ledger.`,
  };
}

/** For people (and agents) without a session: the API, x402 prices (§7.3) and code. */
export default function InferenceTile() {
  const [tab, setTab] = useState<"curl" | "x402">("curl");
  const base = apiBase();
  return (
    <section className="panel tile" aria-labelledby="tile-use">
      <span className="mono-label">
        <Icon name="bolt" size={12} /> API
      </span>
      <h2 id="tile-use">Use the API</h2>

      <div className="field">
        <span className="mono-label">API base</span>
        <div className="code-inline">
          <code className="mono">{base}</code>
          <CopyButton text={base} />
        </div>
      </div>

      <div className="field">
        <span className="mono-label">x402 price per request</span>
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">max_tokens ≤ 512</th>
                <th className="num">≤ 2048</th>
              </tr>
            </thead>
            <tbody>
              {PRICES.map((p) => (
                <tr key={p.max_params_b}>
                  <td>{p.max_params_b === 8 ? "≤ 8B" : `${p.max_params_b}B`}</td>
                  <td className="num mono">
                    {p.tier512} {p.asset}
                  </td>
                  <td className="num mono">
                    {p.tier2048} {p.asset}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="field">
        <div className="tabs" role="tablist" aria-label="Code example">
          {(["curl", "x402"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "is-active" : ""} onClick={() => setTab(t)}>
              {t === "curl" ? "curl (credits)" : "x402 agent"}
            </button>
          ))}
        </div>
        <CodeBox code={snippets(base)[tab]} />
      </div>
    </section>
  );
}
