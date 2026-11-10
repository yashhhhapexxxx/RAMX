/* /chat (spec §12): the playground. Logged in, a request spends credits (hold → stream →
   settle → split) and leaves a receipt on the NEAR ledger. Logged out, it shows World login and
   how an agent pays per request with x402 instead. */
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
import type { ChatBody } from "../data";
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
    const body: ChatBody = { model: chosen, messages: history, max_tokens: maxTokens, pool_id: pin };
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
        {pin && (
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
              Served across {receipt.route.length || route?.length || 0} {(receipt.route.length || route?.length) === 1 ? "laptop" : "laptops"} · {cr(receipt.cost)} credits charged
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
          <label htmlFor="chat-q" className="sr-only">
            Message
          </label>
          <textarea
            id="chat-q"
            className="input"
            rows={2}
            placeholder={chosen ? `Ask ${short(chosen)} a question…` : "No pool is serving a model right now"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
