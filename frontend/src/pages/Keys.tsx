/* /keys: API keys for OpenCode and any OpenAI client. A key spends this account's credits
   (starter first, then earned), optionally up to a cap. The gateway picks each answer's
   max_tokens from your history and balance, trims long sessions to the pool's context and
   emulates tool calls, so OpenCode's agent works on the pool. */
import { useState } from "react";
import type { FormEvent } from "react";
import type { Receipt } from "@shared/types";
import { PageHead } from "../components/ConsoleShell";
import ReceiptSheet from "../components/chat/ReceiptSheet";
import CopyButton, { CodeBox } from "../components/console/CopyButton";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading, Busy } from "../components/console/Status";
import { api } from "../data";
import type { ApiKey, NewApiKey } from "../data";
import { useSession } from "../auth/context";
import { useAsync } from "../hooks/useAsync";
import { useNetwork, useNow } from "../hooks/usePool";
import { available, liveStarter } from "../lib/credits";
import { fmtAgo, fmtNum } from "../lib/format";
import { navigate } from "../lib/router";
import { env } from "../config/env";
import config from "../../../shared/config/ramx.config.json";

const cr = (n: number) => fmtNum(n, 1);
type CatalogModel = (typeof config.models)[number];
/** Used until /v1/models answers, or when no pool serves any model. */
const DEFAULT_MODEL = config.models.find((m) => m.model_id === "Qwen/Qwen3-14B-FP8") ?? config.models[0]!;
const outLimit = (m: CatalogModel) => m.x402_prices[m.x402_prices.length - 1]!.max_tokens;
const shortName = (id: string) => (id.split("/")[1] ?? id).replace(/-FP8$/, "");
const IN_WEIGHT = config.cost.input_token_weight;

/** Gateway origin for clients outside the browser (same origin when VITE_GATEWAY_URL is empty). */
const gatewayOrigin = () => (env.gatewayUrl || location.origin).replace(/\/$/, "");
const apiBase = () => `${gatewayOrigin()}/v1`;
const TOPUP = config.topup;
const TOPUP_CMD = `cd agent-client
pnpm topup --check      # this key's credits
pnpm topup --usdc 0.5  # pay 0.5 testnet USDC on NEAR → +${0.5 * TOPUP.credits_per_usdc} credits on this key`;

function opencodeJson(model: CatalogModel, contextLength: number) {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      // The gateway already fits history to the live pool context. OpenCode's
      // default compaction reserve is too large for this 4K pool.
      compaction: { auto: false },
      provider: {
        ramx: {
          npm: "@ai-sdk/openai-compatible",
          name: "RAMX",
          options: { baseURL: apiBase(), apiKey: "{env:RAMX_API_KEY}" },
          models: { [model.model_id]: { name: `${shortName(model.model_id)} on RAMX`, limit: { context: contextLength, output: outLimit(model) } } },
        },
      },
      model: `ramx/${model.model_id}`,
    },
    null,
    2,
  );
}

function KeyRow({ k, token, onRevoked, onReceipt, now }: { k: ApiKey; token: string; onRevoked: () => void; onReceipt: (id: string) => void; now: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const usage = useAsync(() => (open ? api.keyRequests(token, k.id) : Promise.resolve([])), [open, k.spent]);
  const revoke = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.revokeKey(token, k.id);
      onRevoked();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <tr className={k.revoked ? "key-revoked" : undefined}>
        <td>
          <span>{k.name}</span>
          <span className="cell-sub mono faint">{k.id}</span>
        </td>
        <td>{fmtAgo(k.created_at, now)}</td>
        <td>{k.last_used_at ? fmtAgo(k.last_used_at, now) : <span className="faint">never</span>}</td>
        <td className="num mono">{cr(k.spent)}</td>
        <td className="num mono">{k.boughtTotal > 0 ? cr(k.bought) : <span className="faint">0</span>}</td>
        <td className="num mono">{k.cap === null ? <span className="faint">no cap</span> : cr(k.cap)}</td>
        <td className="num">
          <span className="key-actions">
            <button className="button button-sm button-ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Hide usage" : "Usage"}
            </button>
            {k.revoked ? (
              <span className="faint">revoked</span>
            ) : (
              <button className="button button-sm button-ghost" disabled={busy} onClick={() => void revoke()}>
                {busy ? <Busy size={12}>Revoking…</Busy> : "Revoke"}
              </button>
            )}
          </span>
        </td>
      </tr>
      {err && (
        <tr>
          <td colSpan={7}>
            <ErrorBox error={err} />
          </td>
        </tr>
      )}
      {open && (
        <tr className="key-usage">
          <td colSpan={7}>
            {usage.loading && !usage.data ? (
              <Loading h={48} />
            ) : usage.error ? (
              <ErrorBox error={usage.error} retry={usage.reload} />
            ) : !usage.data?.length ? (
              <Empty>No requests with this key yet.</Empty>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Status</th>
                    <th className="num">Tokens in / out</th>
                    <th className="num">Answer cap</th>
                    <th className="num">Cost</th>
                    <th>Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.data.map((r) => (
                    <tr key={r.req_id}>
                      <td>{fmtAgo(r.ts, now)}</td>
                      <td>{r.status}</td>
                      <td className="num mono">
                        {r.in_tokens ?? "—"} / {r.out_tokens ?? "—"}
                      </td>
                      <td className="num mono">{r.max_tokens ?? "—"}</td>
                      <td className="num mono">{r.cost === null ? "—" : `${cr(r.cost)} cr`}</td>
                      <td>
                        <button className="text-link mono" onClick={() => onReceipt(r.req_id)}>
                          {r.req_id.slice(0, 12)}…
                        </button>
                        {r.ledger_seq !== null && <span className="cell-sub faint">Ledger #{r.ledger_seq}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function Keys() {
  const session = useSession();
  const net = useNetwork();
  const now = useNow(30_000);
  const token = session.token;
  const me = session.me;
  const keys = useAsync(() => (token ? api.keys(token) : Promise.resolve([])), [token, me?.balance.spent_total]);
  const models = useAsync(() => api.models(), []);
  const [name, setName] = useState("opencode");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<Error | null>(null);
  const [created, setCreated] = useState<NewApiKey | null>(null);
  const [sheet, setSheet] = useState<Receipt | null>(null);
  const [sheetErr, setSheetErr] = useState<Error | null>(null);

  // OpenCode should ask for the model a pool serves right now (e.g. Qwen3-30B-A3B on the Mac pool), not a fixed one.
  const served = models.data?.find((m) => m.served);
  const MODEL = config.models.find((m) => m.model_id === served?.model.model_id) ?? DEFAULT_MODEL;
  const offer = models.data?.find((m) => m.model.model_id === MODEL.model_id);
  const factor = offer?.model.model_factor ?? MODEL.model_factor;
  const perKOut = offer?.price?.credits_per_1k_out ?? factor * 1000;
  const multiplier = offer?.price?.multiplier ?? null;
  const contextLength = offer?.context_length ?? MODEL.context_length;

  const head = <PageHead label="API KEYS · GATEWAY" title="Your API keys." sub="Use the pool from OpenCode or any OpenAI client. A key spends your credits." />;

  if (!token && !session.loading) {
    return (
      <>
        {head}
        <section className="panel tile login-tile section-bottom" aria-labelledby="keys-login-h">
          <span className="mono-label">
            <Icon name="user-check" size={12} /> World ID
          </span>
          <h2 id="keys-login-h">Log in to make an API key.</h2>
          <p className="muted">Every account starts with 10,000 credits. A key spends them from OpenCode, and earns more when your laptop serves the pool.</p>
          <div className="tile-actions">
            <button className="button button-blue" onClick={() => session.openLogin("/keys")}>
              Log in with World ID <Icon name="arrow" size={15} />
            </button>
          </div>
        </section>
      </>
    );
  }
  if (!me || !token) {
    return (
      <>
        {head}
        {session.error ? <ErrorBox error={new Error(session.error)} retry={() => void session.reload()} /> : <Loading h={240} />}
      </>
    );
  }

  const b = me.balance;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const capNum = cap.trim() === "" ? null : Number(cap);
    if (capNum !== null && (!Number.isFinite(capNum) || capNum <= 0)) {
      setFormErr(new Error("The cap must be a positive number of credits, or empty for no cap."));
      return;
    }
    setBusy(true);
    setFormErr(null);
    try {
      setCreated(await api.createKey(token, name.trim() || "opencode", capNum));
      keys.reload();
    } catch (err) {
      setFormErr(err as Error);
    } finally {
      setBusy(false);
    }
  };
  const openReceipt = async (id: string) => {
    setSheetErr(null);
    try {
      const r = await api.request(id);
      if (r) setSheet(r);
      else setSheetErr(new Error(`No receipt for ${id} yet.`));
    } catch (err) {
      setSheetErr(err as Error);
    }
  };

  return (
    <>
      {head}

      <section className="panel" aria-labelledby="keys-credits-h">
        <div className="panel-head">
          <h2 id="keys-credits-h" className="section-title">
            What a key can spend
          </h2>
          <span className="faint">
            <b className="acc-avail">{cr(available(b, now))}</b> credits available now
          </span>
        </div>
        <div className="stats">
          <div className="stat">
            <span className="mono-label">Starter</span>
            <p className="stat-value">{cr(liveStarter(b, now))}</p>
            <p className="stat-note">spent first</p>
          </div>
          <div className="stat">
            <span className="mono-label">Earned</span>
            <p className="stat-value">{cr(b.earned)}</p>
            <p className="stat-note">from serving the pool</p>
          </div>
          <div className="stat">
            <span className="mono-label">1k answer tokens</span>
            <p className="stat-value">{fmtNum(perKOut, 0)}</p>
            <p className="stat-note">credits{multiplier !== null ? ` · now ${fmtNum(multiplier, 2)}× base, locked per request` : ""} · prompt tokens cost {fmtNum(IN_WEIGHT * 100, 0)}% of that</p>
          </div>
          <div className="stat">
            <span className="mono-label">Pool context</span>
            <p className="stat-value">{fmtNum(contextLength, 0)}</p>
            <p className="stat-note">tokens{offer?.context_length ? " · smallest node in the pool" : ""} · longer sessions are trimmed</p>
          </div>
        </div>
        <p className="faint table-note">
          1 credit is not 1 token: the price depends on the model and how busy the pool is. You pay only for the tokens the pool runs. The gateway picks each answer's length from your recent answers and what your balance can pay, and says it in the <code className="mono">x-ramx-max-tokens</code> header.{" "}
          <button className="text-link" onClick={() => navigate("/account")}>
            Lend your laptop to earn more <Icon name="arrow" size={13} />
          </button>
        </p>
      </section>

      <div className="grid grid-2 section-gap">
        <section className="panel tile" aria-labelledby="keys-new-h">
          <span className="mono-label">
            <Icon name="bolt" size={12} /> New key
          </span>
          <h2 id="keys-new-h">Make an API key.</h2>
          <form className="key-form" onSubmit={(e) => void create(e)}>
            <label className="field">
              <span>Name</span>
              <input className="input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="field">
              <span>Credit cap (optional)</span>
              <input className="input" inputMode="decimal" placeholder="no cap: the whole balance" value={cap} onChange={(e) => setCap(e.target.value)} />
            </label>
            <div className="tile-actions">
              <button className="button button-blue" type="submit" disabled={busy}>
                {busy ? <Busy>Creating…</Busy> : "Create key"} <Icon name="arrow" size={15} />
              </button>
            </div>
          </form>
          {formErr && <ErrorBox error={formErr} />}
          {created && (
            <div className="world-card is-ok key-created" role="status">
              <Icon name="check" size={20} />
              <div>
                <h3>Store this key now. It is not shown again.</h3>
                <div className="code-inline">
                  <code className="mono">{created.token}</code>
                  <CopyButton text={created.token} />
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="panel tile" aria-labelledby="keys-oc-h">
          <span className="mono-label">
            <Icon name="chat" size={12} /> OpenCode
          </span>
          <h2 id="keys-oc-h">Use the pool from OpenCode.</h2>
          <ol className="key-steps muted">
            <li>
              Put your key in the environment: <code className="mono">export RAMX_API_KEY=gpa_…</code>
            </li>
            <li>
              Save this as <code className="mono">opencode.json</code> in your project.
            </li>
            <li>
              Run <code className="mono">opencode</code>, then pick the model with <code className="mono">/models</code>.
            </li>
          </ol>
          <CodeBox code={opencodeJson(MODEL, contextLength)} />
          <p className="faint table-note">Any OpenAI client works the same way: base URL {apiBase()}, the key as the API key.</p>
        </section>
      </div>

      <section className="panel tile section-gap" aria-labelledby="keys-topup-h">
        <span className="mono-label">
          <Icon name="key" size={12} /> Top up · NEAR testnet
        </span>
        <h2 id="keys-topup-h">Buy credits for one key with testnet USDC on NEAR.</h2>
        <p className="muted">
          1 USDC = {TOPUP.credits_per_usdc} credits, {TOPUP.min_usdc}–{fmtNum(TOPUP.max_usdc, 0)} USDC at a time. Bought credits belong to that key only. It spends them before your account credits, and its cap does not limit them. You pay with x402 from your own{" "}
          NEAR testnet account (USDC on NEAR). Your private key stays on your computer: the script signs a NEAR meta-transaction there and the gateway only relays the signed transfer.
        </p>
        <ol className="key-steps muted">
          <li>
            In <code className="mono">agent-client/.env</code>, set <code className="mono">GATEWAY_URL={gatewayOrigin()}</code>, <code className="mono">RAMX_API_KEY</code> (the key to top up), and your NEAR testnet account: <code className="mono">AGENT_ACCOUNT_ID=you.testnet</code>, <code className="mono">AGENT_SECRET_KEY</code> (<code className="mono">ed25519:…</code>).
          </li>
          <li>Run the top-up. It shows the key's credits before and after, and the NearBlocks link of the payment.</li>
        </ol>
        <CodeBox code={TOPUP_CMD} />
        <p className="faint table-note">
          See a key's credits from anywhere: <code className="mono">curl -H "Authorization: Bearer $RAMX_API_KEY" {gatewayOrigin()}/v1/credits</code>
        </p>
      </section>

      <section className="panel section-gap section-bottom" aria-labelledby="keys-list-h">
        <div className="panel-head">
          <h2 id="keys-list-h" className="section-title">
            Your keys
          </h2>
          <span className="faint">revoke a key to stop it at once</span>
        </div>
        {sheetErr && <ErrorBox error={sheetErr} />}
        {keys.loading && !keys.data ? (
          <Loading h={120} />
        ) : keys.error ? (
          <ErrorBox error={keys.error} retry={keys.reload} />
        ) : !keys.data?.length ? (
          <Empty>No keys yet. Make one above.</Empty>
        ) : (
          <div className="table-wrap key-table" tabIndex={0} role="region" aria-label="API keys">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th className="num">Spent</th>
                  <th className="num">Bought left</th>
                  <th className="num">Cap</th>
                  <th className="num">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.data.map((k) => (
                  <KeyRow key={k.id} k={k} token={token} now={now} onRevoked={keys.reload} onReceipt={(id) => void openReceipt(id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {sheet && <ReceiptSheet receipt={sheet} nodes={net?.nodes ?? []} onClose={() => setSheet(null)} />}
    </>
  );
}
