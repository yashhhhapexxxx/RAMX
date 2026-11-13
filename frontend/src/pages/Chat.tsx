/* /chat (spec §12): the playground. Logged in, a request spends credits (hold → stream →
   settle → split) and leaves a receipt on the NEAR ledger. Logged out, it shows World login and
   how an agent pays per request with x402 instead. */
import TokMeter from "../components/chat/TokMeter";
import { useEffect, useRef, useState } from "react";
import type { ModelEntry, Receipt, RouteHop } from "@shared/types";
import RouteTrace from "../components/chat/RouteTrace";
import Markdown from "../components/chat/Markdown";
import ReceiptSheet from "../components/chat/ReceiptSheet";
import SourceBadge from "../components/SourceBadge";
import { Icon } from "../components/Icon";
import InferenceTile from "../components/chat/InferenceTile";
import UnavailableNotice from "../components/UnavailableNotice";
import { ErrorBox, Busy } from "../components/console/Status";
import { api, InsufficientCredits, PaymentRequired, SessionExpired } from "../data";
import type { ChatBody, PrivacyMode } from "../data";
import { attestEnclave, newClientKey, shortKey, type ClientKey, type EnclaveKey } from "../lib/e2ee";
import { useModels, useNetwork, usePoolAvailability } from "../hooks/usePool";
import { useSession } from "../auth/context";
import { available, estimateTokens, holdFor } from "../lib/credits";
import { fmtNum } from "../lib/format";
import { navigate } from "../lib/router";
import { explorerEvent } from "../lib/links";
import { env } from "../config/env";

type Msg = { role: "user" | "assistant"; content: string };
const SUGGESTIONS = ["How does a pool split one model across laptops?", "What does this answer cost in credits?", "How do laptop owners earn credits?"];
const cr = (n: number) => fmtNum(n, 1);
const short = (id: string) => id.split("/")[1] ?? id;

type Privacy = "normal" | PrivacyMode;
const PRIVACY_OPTIONS: { value: Privacy; label: string; hint: string }[] = [
  { value: "normal", label: "Normal", hint: "Any laptop in the GPU Pool; emails, phone numbers, cards and keys are hidden from it" },
  { value: "trusted-all", label: "Trusted laptops", hint: "Only your own or trusted laptops; if none is online, the secure enclave" },
  { value: "tee", label: "Secure hardware (TEE)", hint: "Only a NEAR AI Cloud enclave; no laptop sees the prompt" },
];
/** Remembered per browser; storage can be unavailable (private mode), so every access is guarded. */
const remembered = <T extends string>(key: string, ok: readonly T[], fallback: T): T => {
  try { const v = localStorage.getItem(key) as T | null; return v && ok.includes(v) ? v : fallback; } catch { return fallback; }
};
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* not persisted */ } };
/** Re-attest the enclave after this long, so the key in use is always freshly vouched for. */
const ATTESTATION_TTL_MS = 10 * 60_000;

function LoginCard({ onLogin }: { onLogin: () => void }) {
  return (
    <section className="panel tile" aria-labelledby="login-h">
      <span className="mono-label">
        <Icon name="user-check" size={12} /> Credits
      </span>
      <h2 id="login-h">Log in to talk to the pool.</h2>
      <div className="tile-actions">
        <button className="button button-blue" onClick={onLogin}>
          Log in with World ID <Icon name="arrow" size={15} />
        </button>
      </div>
    </section>
  );
}

export default function Chat({ query }: { query: URLSearchParams }) {
  const session = useSession();
  const models = useModels();
  const net = useNetwork();
  const [picked, setModel] = useState<string | null>(null);
  // A new ?model= (e.g. "Query this pool" from /network) wins until the user picks again.
  const [lastQuery, setLastQuery] = useState(query.get("model"));
  if (query.get("model") !== lastQuery) {
    setLastQuery(query.get("model"));
    setModel(null);
  }
  const model = picked ?? query.get("model") ?? "";
  const pin = query.get("pool") ?? undefined;
  const [maxTokens, setMaxTokens] = useState<512 | 2048>(512);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  // After a message is sent the prompt box empties: shrink it back to one centred line.
  useEffect(() => {
    if (input) return;
    const box = document.getElementById("chat-q") as HTMLTextAreaElement | null;
    if (box) box.style.height = "";
  }, [input]);
  const [streaming, setStreaming] = useState(false);
  const [route, setRoute] = useState<RouteHop[] | null>(null);
  const [active, setActive] = useState(-1);
  /** What the request is doing now: sent, waiting for the first token (queue/prefill), streaming. */
  const [phase, setPhase] = useState<"preparing" | "waiting" | "generating" | null>(null);
  /** The prompt of a failed request, kept for "Try again". */
  const [failed, setFailed] = useState<string | null>(null);
  const [tokS, setTokS] = useState<number | null>(null);
  const [ttft, setTtft] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [sheet, setSheet] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  // Privacy: the mode is the user's choice; end-to-end encryption applies to the enclave mode only.
  const [privacy, setPrivacyState] = useState<Privacy>(() => remembered<Privacy>("ramx.privacy", ["normal", "trusted-all", "tee"], "normal"));
  const [e2eeOn, setE2eeState] = useState<boolean>(() => remembered("ramx.e2ee", ["on", "off"], "on") === "on");
  const setPrivacy = (p: Privacy) => { setPrivacyState(p); remember("ramx.privacy", p); };
  const setE2ee = (on: boolean) => { setE2eeState(on); remember("ramx.e2ee", on ? "on" : "off"); };
  /** This tab's key pair: in memory only, never stored or sent (only its public half). */
  const clientKey = useRef<ClientKey | null>(null);
  const enclaves = useRef(new Map<string, EnclaveKey>());
  const [enclave, setEnclave] = useState<{ status: "attesting" | "ok" | "error"; key?: EnclaveKey; message?: string } | null>(null);
  const privacyOn = api.mode === "live" && privacy !== "normal";
  const encrypting = api.mode === "live" && privacy === "tee" && e2eeOn;

  const offers = models.data ?? [];
  const served = offers.filter((o) => o.served).map((o) => o.model);
  const entry: ModelEntry | undefined = served.find((m) => m.model_id === model) ?? served.find((m) => m.params_b >= 14) ?? served[0];
  const chosen = entry?.model_id ?? "";
  const pinnedAvailability = usePoolAvailability(pin, chosen || query.get("model") || undefined);
  const canUsePool = !pin || pinnedAvailability.data?.available === true;
  const nodes = net?.nodes ?? [];
  const me = session.me;

  const draft: Msg[] = [...msgs, ...(input.trim() ? [{ role: "user" as const, content: input.trim() }] : [])];
  const hold = entry ? holdFor(entry.model_factor, maxTokens, estimateTokens(draft.length ? draft : [{ content: "" }])) : 0;

  useEffect(() => () => abort.current?.abort(), []);
  /* Follow new text only while the reader is at the bottom; scrolling up stops the follow. */
  const [atBottom, setAtBottom] = useState(true);
  const onLogScroll = () => {
    const el = log.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };
  const toLatest = () => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  };
  useEffect(() => {
    if (atBottom) log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [msgs, atBottom]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || streaming || !entry || !session.token || !me || !canUsePool) return;
    const history: Msg[] = [...msgs, { role: "user", content }];
    const need = holdFor(entry.model_factor, maxTokens, estimateTokens(history));
    // §5.3 step 4: the hold must fit; check before sending so nothing is held or charged.
    if (need > available(me.balance)) {
      setError(new InsufficientCredits(need, available(me.balance)));
      return;
    }
    setMsgs([...history, { role: "assistant", content: "" }]);
    setInput("");
    setError(null);
    setReceipt(null);
    setTokS(null);
    setTtft(null);
    setActive(-1);
    setFailed(null);
    setPhase("preparing");
    setStreaming(true);
    const ctl = new AbortController();
    abort.current = ctl;
    let e2ee: ChatBody["e2ee"];
    if (encrypting) {
      const teeModel = offers.find((o) => o.model.model_id === chosen)?.tee_model;
      try {
        if (!teeModel) throw new Error(`The gateway names no enclave model for ${short(chosen)}`);
        let key = enclaves.current.get(teeModel);
        if (!key || Date.now() - key.attestedAt > ATTESTATION_TTL_MS) {
          setEnclave({ status: "attesting" });
          key = await attestEnclave(teeModel);
          enclaves.current.set(teeModel, key);
        }
        setEnclave({ status: "ok", key });
        clientKey.current ??= newClientKey();
        e2ee = { client: clientKey.current, enclave: key };
      } catch (err) {
        // Never send in plain text when encryption was asked for.
        const message = `${(err as Error).message}. Nothing was sent; you paid nothing.`;
        setEnclave({ status: "error", message });
        setError(new Error(message));
        setMsgs((m) => m.slice(0, -2));
        setInput(content);
        setFailed(content);
        setStreaming(false);
        setPhase(null);
        return;
      }
    }
    const body: ChatBody = {
      model: chosen, messages: history, max_tokens: maxTokens,
      ...(privacyOn ? { privacy: privacy as PrivacyMode } : { pool_id: pin }),
      ...(e2ee ? { e2ee } : {}),
    };
    try {
      for await (const c of api.chat(body, session.token, ctl.signal)) {
        if (c.route) {
          setRoute(c.route);
          setPhase("waiting");
          void session.reload(); // shows the hold
        }
        if (c.ttft_ms != null) setTtft(c.ttft_ms);
        if (c.tok_s != null) setTokS(c.tok_s);
        if (c.delta) {
          // No per-token telemetry: the route is confirmed, but which laptop holds a token now is not.
          setPhase("generating");
          setMsgs((m) => {
            const next = m.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, content: last.content + c.delta };
            return next;
          });
        }
        if (c.done) {
          setActive(-2);
          if (ctl.signal.aborted) markStopped();
          if (c.receipt_id) {
            const rc = await api.request(c.receipt_id);
            setReceipt(rc);
            if (rc?.route.length) setRoute(rc.route);
            if (rc && rc.ledger_seq == null) void waitForHcs(c.receipt_id);
          }
        }
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        markStopped();
      } else if (err instanceof SessionExpired || err instanceof PaymentRequired) {
        session.logout();
        setError(err);
      } else {
        // §5.3 step 11: a failed request costs nothing.
        setError(err instanceof InsufficientCredits || /paid nothing/i.test(err.message) ? err : new Error(`${err.message} You paid nothing.`));
        // Keep the prompt: drop the unanswered turn and put the text back for a retry.
        setMsgs((m) => (m.at(-1)?.content === "" ? m.slice(0, -2) : m));
        setInput(content);
        setFailed(content);
      }
      setActive(-1);
    } finally {
      setStreaming(false);
      setPhase(null);
      abort.current = null;
      void session.reload();
    }
  }

  /** The receipt is appended to the ledger contract asynchronously; poll until it has a sequence number. */
  async function waitForHcs(id: string) {
    for (let i = 0; i < 20; i++) {
      await new Promise((ok) => setTimeout(ok, 3000));
      const rc = await api.request(id).catch(() => null);
      if (rc?.ledger_seq != null) {
        setReceipt((cur) => (cur && cur.req_id === rc.req_id ? rc : cur));
        return;
      }
    }
  }

  function markStopped() {
    setMsgs((m) => {
      const next = m.slice();
      const last = next[next.length - 1];
      if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content ? `${last.content} …` : "(stopped)" };
      return next;
    });
  }

  const balance = me ? available(me.balance) : null;
  const head = (
    <div className="play-head">
      <h1>Playground</h1>
      <div className="play-head-aside">
        <a className="text-link" href="/keys">
          <Icon name="key" size={13} /> API access
        </a>
        {balance != null && (
          <a className="play-balance" href="/account" title="Credits, vesting and contribution ratio">
            <b>{fmtNum(balance, 0)}</b> credits
          </a>
        )}
      </div>
    </div>
  );

  if (!session.token && !session.loading) {
    return (
      <div className="playground">
        {head}
        <div className="grid grid-2 chat-out">
          <LoginCard onLogin={() => session.openLogin("/chat")} />
          <InferenceTile />
        </div>
      </div>
    );
  }

  const poolsForModel = (net?.pools ?? []).filter((p) => chosen && p.models.includes(chosen));
  const readyPools = poolsForModel.filter((p) => p.status === "ready" && !p.restarting);
  const laptops = new Set(readyPools.flatMap((p) => p.members)).size;
  const choose = (poolId: string) =>
    navigate(`/chat?model=${encodeURIComponent(chosen)}${poolId ? `&pool=${encodeURIComponent(poolId)}` : ""}`, { replace: true });
  const phaseText = phase === "preparing" ? "Sending to the gateway…" : phase === "waiting" ? "Pool is preparing the answer (queue and prompt processing)…" : phase === "generating" ? "Generating…" : null;
  const lastDone = !streaming && receipt;

  return (
    <div className="playground">
      {head}
      <section className="panel play" aria-label="Playground">
        <div className="play-bar">
          {models.error && !models.data ? (
            <ErrorBox error={models.error} retry={models.reload} />
          ) : !models.data ? (
            <Busy>Checking available models…</Busy>
          ) : served.length === 0 ? (
            <UnavailableNotice pools={net?.pools ?? []} nodes={nodes} loaded={!!net && net.updated_at > 0} />
          ) : (
            <>
              <label className="play-select">
                <span className="sr-only">Model</span>
                <select className="input" value={chosen} disabled={streaming} onChange={(e) => setModel(e.target.value)}>
                  {offers.map(({ model: m, served: ok }) => (
                    <option key={m.model_id} value={m.model_id} disabled={!ok}>
                      {short(m.model_id)}
                      {ok ? "" : " (no live pool)"}
                    </option>
                  ))}
                </select>
              </label>
              {pin ? (
                <span className={`pill ${canUsePool ? "pill-ok" : "pill-warn"}`}>{canUsePool ? "Available" : pinnedAvailability.data ? "Unavailable" : <Busy size={10}>Checking</Busy>}</span>
              ) : (
                <span className="pill pill-ok">
                  Available{laptops ? ` · ${laptops} ${laptops === 1 ? "laptop" : "laptops"}` : ""}
                </span>
              )}
              <label className="play-select">
                <span className="faint">Pool</span>
                <select className="input" value={pin ?? ""} disabled={streaming} onChange={(e) => choose(e.target.value)}>
                  <option value="">Automatic</option>
                  {pin && !poolsForModel.some((p) => p.pool_id === pin) && <option value={pin}>{pin}</option>}
                  {poolsForModel.map((p) => (
                    <option key={p.pool_id} value={p.pool_id}>
                      {p.pool_id} · {p.members.length} laptops
                    </option>
                  ))}
                </select>
              </label>
              <SourceBadge kind="directory" />
            </>
          )}
        </div>
        {api.mode === "live" && (
          <div className="play-privacy">
            <span className="faint">Privacy</span>
            <div className="tabs" role="radiogroup" aria-label="Privacy">
              {PRIVACY_OPTIONS.map((o) => (
                <button key={o.value} type="button" role="radio" aria-checked={privacy === o.value} title={o.hint}
                  className={privacy === o.value ? "is-active" : ""} onClick={() => setPrivacy(o.value)} disabled={streaming}>
                  {o.label}
                </button>
              ))}
            </div>
            {privacy === "tee" && (
              <label className="play-e2ee" title="Encrypt the prompt in this browser to the enclave's attested key; RAMX only relays ciphertext">
                <input type="checkbox" checked={e2eeOn} onChange={(e) => setE2ee(e.target.checked)} disabled={streaming} /> End-to-end encrypted
              </label>
            )}
          </div>
        )}
        {privacyOn && (
          <p className="faint play-pin play-privacy-note" role="status">
            {PRIVACY_OPTIONS.find((o) => o.value === privacy)?.hint}.
            {pin && " The pool choice is not used in this mode."}
            {encrypting && (
              <>
                {" "}
                {enclave?.status === "attesting" ? <Busy size={10}>Attesting the enclave from this browser</Busy>
                  : enclave?.status === "ok" && enclave.key ? <>Encrypted in this browser for enclave key <span className="mono">{shortKey(enclave.key.publicKeyHex)}</span>, attested ✓ (Intel TDX quote, your nonce).</>
                  : enclave?.status === "error" ? <span className="pill pill-warn">{enclave.message}</span>
                  : <>Your prompt is encrypted in this browser before it leaves; the enclave is attested on send.</>}
              </>
            )}
          </p>
        )}
        {pin && !privacyOn && (
          <p className="faint play-pin" role="status">
            {pinnedAvailability.data ? <>{pinnedAvailability.data.reason} {pinnedAvailability.data.action}</> : pinnedAvailability.error ? pinnedAvailability.error.message : <Busy>Checking request availability…</Busy>}{" "}
            <button className="text-link" onClick={pinnedAvailability.reload}>Check again</button> ·{" "}
            <button className="text-link" onClick={() => choose("")} disabled={streaming}>Let the router pick</button>
          </p>
        )}

        <div className="chat-log-wrap">
        <div className="chat-log" ref={log} onScroll={onLogScroll} aria-live="polite">
          {msgs.length === 0 ? (
            <div className="chat-empty">
              <p className="muted">Ask anything. Or try one of these:</p>
              <div className="suggestions">
                {SUGGESTIONS.map((q) => (
                  <button key={q} className="suggestion" onClick={() => send(q)} disabled={!chosen || !me || !canUsePool}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            msgs.map((m, i) => (
              <div key={i} className={`msg msg-${m.role}`}>
                <span className="mono-label">{m.role === "user" ? "You" : short(chosen)}</span>
                {m.role === "assistant" ? (
                  <div className="msg-body">
                    <Markdown text={m.content} />
                    {streaming && i === msgs.length - 1 && <i className="caret" aria-hidden="true" />}
                  </div>
                ) : (
                  <p>{m.content}</p>
                )}
              </div>
            ))
          )}
        </div>
        {!atBottom && msgs.length > 0 && (
          <button className="chat-jump" onClick={toLatest}>
            {streaming ? "New text below" : "Jump to latest"} ↓
          </button>
        )}
        </div>
        {phaseText && (
          <p className="faint play-phase">
            <Busy>{phaseText}</Busy>
          </p>
        )}
        {error && (
          <div className="play-error">
            <ErrorBox error={error} />
            {failed && !streaming && (
              <button className="button button-ghost button-sm" onClick={() => void send(failed)} disabled={!chosen || !canUsePool}>
                Try again
              </button>
            )}
          </div>
        )}
        {lastDone && (
          <div className="play-result" role="status">
            <span>
              {receipt.backend === "near-ai-cloud" ? (
                <>
                  Served in a NEAR AI Cloud enclave (TEE)
                  {receipt.e2ee && " · end-to-end encrypted"}
                  {receipt.tee_signature && (receipt.tee_signature.signature_ok && receipt.tee_signature.hashes_match ? " · enclave signature ✓" : " · enclave signature not verified")}
                </>
              ) : (
                <>Served across {receipt.route.length || route?.length || 0} {(receipt.route.length || route?.length) === 1 ? "laptop" : "laptops"}</>
              )}{" "}
              · {cr(receipt.cost)} credits charged
              {receipt.split && <> · {cr(receipt.split.nodes.reduce((sum, n) => sum + n.credits, 0))} earned by those laptops</>}
              {tokS != null && <span className="faint"> · {tokS.toFixed(1)} tok/s</span>}
              {ttft != null && <span className="faint"> · first token {ttft} ms</span>}
            </span>
            <span>
              {receipt.ledger_seq != null ? (
                <SourceBadge kind="ledger" seq={receipt.ledger_seq} href={explorerEvent(env.ledgerContract, receipt.ledger_seq)} />
              ) : (
                <Busy size={10}>Receipt pending publication</Busy>
              )}{" "}
              <button className="text-link" onClick={() => setSheet(true)}>
                View receipt <Icon name="file" size={12} />
              </button>
            </span>
          </div>
        )}
        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <TokMeter tokS={tokS} ttft={ttft} compact />
          <label htmlFor="chat-q" className="sr-only">
            Message
          </label>
          <textarea
            id="chat-q"
            className="input"
            rows={1}
            placeholder={chosen ? `Message ${short(chosen)}…` : "No pool is serving a model right now"}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Grow with the text, up to about 8 lines; one line stays vertically centred.
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            disabled={!chosen || !canUsePool}
          />
          {streaming ? (
            <button type="button" className="button button-ghost" onClick={() => abort.current?.abort()}>
              <Icon name="pause" size={14} /> Stop
            </button>
          ) : (
            <button className="button button-blue" disabled={!input.trim() || !chosen || !me || !canUsePool}>
              Send <Icon name="arrow-up" size={14} />
            </button>
          )}
        </form>
        <div className="play-foot">
          {entry && (
            <p className="faint" title={`${entry.model_factor} × (${maxTokens} + 0.2 × input tokens)`}>
              Maximum charge: {fmtNum(hold, 0)} credits · Unused credits released
            </p>
          )}
          <details className="play-options">
            <summary className="text-link">Response options</summary>
            <div className="tabs" role="radiogroup" aria-label="Response length">
              {([[512, "Short"], [2048, "Long"]] as const).map(([n, label]) => (
                <button key={n} type="button" role="radio" aria-checked={maxTokens === n} className={maxTokens === n ? "is-active" : ""} onClick={() => setMaxTokens(n)} disabled={streaming}>
                  {label} <span className="faint">· up to {n} tokens</span>
                </button>
              ))}
            </div>
          </details>
        </div>
      </section>

      <RouteTrace route={route} nodes={nodes} active={streaming ? -1 : active === -2 ? -2 : -1} streaming={streaming} />
      {sheet && receipt && <ReceiptSheet receipt={receipt} nodes={nodes} onClose={() => setSheet(false)} />}
    </div>
  );
}
