import { Busy, Loading } from "../components/console/Status";
/* World ID login (spec §6). Lazy-loaded so the landing does not ship IDKit.
   Real flow: rp_context from the gateway → IDKit widget → result sent to
   /auth/world/verify unchanged → JWT. There is no mock login: in staging, the human
   verifies with the World ID Simulator (the sheet says how). */
import { useEffect, useState } from "react";
import { IDKitRequestWidget, CredentialRequest, any } from "@worldcoin/idkit";
import type { IDKitErrorCodes } from "@worldcoin/idkit";
import { Sheet } from "../components/Shared";
import { Icon } from "../components/Icon";
import { api } from "../data";
import type { LoginResult, WorldRpContext } from "../data";
import { env } from "../config/env";
import { navigate } from "../lib/router";
import { fmtNum } from "../lib/format";
import { STARTER_CREDITS } from "../lib/credits";
import { useSession } from "./context";
import NearLogin, { completeNearRedirect } from "./NearLogin";


type Outcome = { kind: "ok"; result: LoginResult } | { kind: "cancelled" } | { kind: "error"; message: string };

function fromIdkitError(code: IDKitErrorCodes): Outcome {
  if (code === "user_rejected") return { kind: "cancelled" };
  return { kind: "error", message: `World ID stopped with "${code}". Nothing changed. Try again.` };
}

export default function LoginSheet() {
  const s = useSession();
  const [rp, setRp] = useState<WorldRpContext | null | undefined>(undefined);
  const [rpError, setRpError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const appId = env.worldAppId.startsWith("app_") ? (env.worldAppId as `app_${string}`) : null;

  // A redirect wallet (MyNearWallet) came back with a signed login message.
  useEffect(() => {
    completeNearRedirect().then(
      (r) => { if (r) { s.login(r); setOutcome({ kind: "ok", result: r }); } },
      (e: Error) => setOutcome({ kind: "error", message: e.message }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    api.auth.rpContext().then(
      (c) => live && setRp(c),
      (e: Error) => {
        if (!live) return;
        setRp(null);
        setRpError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const real = !!rp;

  async function verify(result: unknown) {
    setBusy(true);
    setOutcome(null);
    try {
      const r = await api.auth.verify(result);
      s.login(r);
      setOutcome({ kind: "ok", result: r });
    } catch (e) {
      setOutcome({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  function done() {
    s.closeLogin();
    if (s.next) navigate(s.next);
  }

  return (
    <Sheet title={s.method === "near" ? "Connect a NEAR wallet" : s.method === "world" ? "Log in with World ID" : "Log in"} onClose={s.closeLogin}>
      <div className="login-body">
        {s.method !== "near" && (
          <p className="muted">
            One human, one account. <strong>Only World ID gives starter credits:</strong> a new account gets {fmtNum(STARTER_CREDITS)} credits (valid for 14 days) to spend on any pool. Verify with the Orb or Selfie Check. To earn more, link a laptop and serve layers.
          </p>
        )}
        {s.method === "near" && (
          <p className="login-note" role="note">
            <Icon name="coins" size={13} /> Free credits only by proving you're a human with a World ID scan.
          </p>
        )}

        {outcome?.kind === "ok" ? (
          <div className="world-card is-ok" role="status">
            <Icon name="user-check" size={22} />
            <div>
              {outcome.result.created && outcome.result.me.balance.starter === 0 ? (
                <>
                  <h3>Welcome. Your NEAR account is linked.</h3>
                  <p className="muted">No starter credits for wallet-only accounts (those need World ID). Top up with USDC on the Credits page.</p>
                </>
              ) : outcome.result.created ? (
                <>
                  <h3>Welcome. {fmtNum(STARTER_CREDITS)} starter credits.</h3>
                  <p className="muted">Your account is ready. The grant is recorded on the ledger.</p>
                </>
              ) : (
                <>
                  <h3>Already registered.</h3>
                  <p className="muted">This human already has an account. You are logged in to it. No new starter credits.</p>
                </>
              )}
              <p className="faint mono">{outcome.result.me.account_id}</p>
            </div>
          </div>
        ) : s.method === "near" ? null : rp === undefined ? (
          <Loading h={80} />
        ) : real ? (
          <div className="world-actions">
            <button className="button button-blue" disabled={busy} onClick={() => setOpen(true)}>
              <Icon name="user-check" size={15} /> {busy ? <Busy>Checking…</Busy> : "Continue with World ID"}
            </button>
            {rp!.environment === "staging" && (
              <p className="login-sim-note" role="note">
                <Icon name="shield" size={13} /> This is the World ID staging app. In the World ID window choose <b>Testing in staging? Use the simulator</b>, open the World ID Simulator, and verify with its <b>Human</b> credential. Each simulator identity is one human, so it gets one account.
              </p>
            )}
            <IDKitRequestWidget
              open={open}
              onOpenChange={setOpen}
              app_id={rp!.app_id}
              action={rp!.action}
              environment={rp!.environment}
              rp_context={rp!}
              allow_legacy_proofs={false}
              constraints={any(CredentialRequest("proof_of_human"), CredentialRequest("selfie"))}
              onSuccess={(result) => verify(result)}
              onError={(code) => setOutcome(fromIdkitError(code))}
            />
          </div>
        ) : (
          <div className="world-card is-bad" role="alert">
            <Icon name="shield" size={22} />
            <div>
              <h3>World login is not available</h3>
              <p className="muted">{rpError ?? (appId ? "The gateway did not return a signed request." : "No World ID app id is set (VITE_WORLD_APP_ID).")}</p>
            </div>
          </div>
        )}

        {outcome?.kind !== "ok" && s.method !== "world" && (
          <div className="world-actions">
            <p className="muted">{s.method === "near" ? "Log in" : "Or log in"} with a NEAR testnet wallet (Meteor, MyNearWallet). The wallet signs a login message; no transaction.{s.method === "near" ? "" : " No starter credits: those need World ID; top up with USDC instead."}</p>
            <NearLogin onLogin={(r) => { s.login(r); setOutcome({ kind: "ok", result: r }); }} onError={(message) => setOutcome({ kind: "error", message })} />
          </div>
        )}

        {outcome?.kind === "cancelled" && (
          <div className="world-card is-idle" role="status">
            <Icon name="back" size={22} />
            <div>
              <h3>Login cancelled</h3>
              <p className="muted">Nothing changed.</p>
            </div>
          </div>
        )}
        {outcome?.kind === "error" && (
          <div className="world-card is-bad" role="alert">
            <Icon name="shield" size={22} />
            <div>
              <h3>Couldn't verify</h3>
              <p className="muted">{outcome.message}</p>
            </div>
          </div>
        )}

        {outcome?.kind === "ok" && (
          <button className="button button-blue" onClick={done}>
            {s.next ? "Continue" : "Done"} <Icon name="arrow" size={15} />
          </button>
        )}
      </div>
    </Sheet>
  );
}
