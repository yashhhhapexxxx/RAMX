import { useEffect, useState } from "react";
import { PageHead } from "../components/ConsoleShell";
import { Icon } from "../components/Icon";
import { ErrorBox, Loading, Success, LiveStatus } from "../components/console/Status";
import ProviderForm from "../components/provider/ProviderForm";
import PoolSetup from "../components/provider/PoolSetup";
import SetupCycle from "../components/provider/SetupCycle";
import { useSession } from "../auth/context";
import { useAsync } from "../hooks/useAsync";
import { navigate } from "../lib/router";
import { providerApi } from "../data/provider";
import { SessionExpired } from "../data/api";

export default function GettingStarted({ query }: { query: URLSearchParams }) {
  const session = useSession();
  const [notice, setNotice] = useState<string | null>(null);
  const { token, logout, openLogin } = session;
  const rawMode = query.get("mode"), mode = rawMode === "create" || rawMode === "join" ? rawMode : null;
  const data = useAsync(() => session.token ? providerApi.overview(session.token) : Promise.resolve(null), [session.token], { refreshMs: session.token ? 3000 : undefined });
  useEffect(() => {
    if (token && data.error instanceof SessionExpired) { logout(); openLogin(`/getting-started${mode ? `?mode=${mode}` : ""}`); }
  }, [data.error, token, mode, logout, openLogin]);
  function choose(choice: "create" | "join") {
    const path = `/getting-started?mode=${choice}`;
    navigate(path);
    if (!session.token) session.openLogin(path);
  }
  const pools = session.token ? data.data?.pools ?? [] : [];
  const returning = pools.length > 0 && !mode;
  const sizeOf = (model: string) => data.data?.models.find(m => m.model_id === model)?.size_gb;
  const choices = <div className="provider-choices" aria-label="Choose how to contribute">
    <button className={`provider-choice ${mode === "create" ? "is-selected" : ""}`} onClick={() => choose("create")} aria-pressed={mode === "create"}>
      <span className="mono-label">01 / START SOMETHING</span><span className="provider-choice-title"><Icon name="pod" size={27} />Create a pool<Icon name="arrow-up" size={22} /></span><span className="muted">Choose a model, invite your members and coordinate the pipeline.</span><span className="provider-choice-note">You become the coordinator</span>
    </button>
    <button className={`provider-choice ${mode === "join" ? "is-selected" : ""}`} onClick={() => choose("join")} aria-pressed={mode === "join"}>
      <span className="mono-label">02 / BRING YOUR COMPUTE</span><span className="provider-choice-title"><Icon name="laptop" size={27} />Join a pool<Icon name="arrow-up" size={22} /></span><span className="muted">Have a Pool ID? Request a place and let your laptop do its part.</span><span className="provider-choice-note">Your own account. Your own earnings.</span>
    </button>
  </div>;
  const form = session.token && mode && data.data && <ProviderForm key={mode} mode={mode} models={data.data.models} done={() => { setNotice(mode === "create" ? "Pool created. Share its Pool ID with your members, then connect your laptop below." : "Request sent. The coordinator approves it; the install command appears here after approval."); data.reload(); navigate("/getting-started"); }} />;
  const login = session.loading ? <Loading /> : mode && !session.token ? <section className="panel provider-login"><Icon name="user-check" size={26} /><div><h2>One human. Your own contribution.</h2><p className="muted">Log in with World ID to {mode === "create" ? "create your pool" : "request membership"}. Your choice stays here after verification.</p></div><button className="button button-blue" onClick={() => session.openLogin(`/getting-started?mode=${mode}`)}>Continue with World ID<Icon name="arrow" size={14} /></button></section> : null;
  const poolViews = pools.map(pool => <PoolSetup key={pool.pool_id} pool={pool} refresh={data.reload} sizeGb={sizeOf(pool.model)} />);

  // Returning contributor: their pool and machine first; create/join stays one click away.
  if (returning) return <div className="provider-page">
    <PageHead label="CONTRIBUTE" title="Your contribution" aside={<LiveStatus loading={data.loading} error={data.error} hasData={!!data.data} label="Live · updates every 3 s" />} />
    {data.error && !(data.error instanceof SessionExpired) && <ErrorBox title="Couldn't load your pools" error={data.error} hint="The gateway did not answer. Your pools and setup progress can't be shown until it does. This page retries every 3 seconds." command="cd gateway && npm run dev   # gateway on :8080, or set VITE_GATEWAY_URL in frontend/.env" retry={data.reload} retrying={data.loading} />}
    {notice && <Success onClose={() => setNotice(null)}>{notice}</Success>}
    {poolViews}
    <details className="provider-more"><summary>Create or join another pool</summary>{choices}</details>
  </div>;

  return <div className="provider-page">
    <PageHead label="CONTRIBUTE / GETTING STARTED" title={<>Your laptop.<br />A bigger possibility.</>} sub="Bring your compute to the network. Start a pool with your crew, or add your laptop to one that already exists." />
    {choices}
    {login}
    {data.error && !(data.error instanceof SessionExpired) && <ErrorBox title="Couldn't load your pools" error={data.error} hint="The gateway did not answer. Your pools and setup progress can't be shown until it does. This page retries every 3 seconds." command="cd gateway && npm run dev   # gateway on :8080, or set VITE_GATEWAY_URL in frontend/.env" retry={data.reload} retrying={data.loading} />}
    {notice && <Success onClose={() => setNotice(null)}>{notice}</Success>}
    {session.token && !data.data && !data.error && <Loading label="Loading your pools…" />}
    {form}
    <SetupCycle />
    {poolViews}
  </div>;
}
