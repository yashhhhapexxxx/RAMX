/* NEAR wallet login (NEP-413 signMessage). The gateway hands out a single-use nonce; the wallet
   signs {message, nonce, recipient}; the gateway checks the signature and that the key is a
   full-access key of the account, then returns the usual session. A new account gets starter
   credits (daily cap on the gateway). Popup wallets (Meteor) answer in place; redirect wallets
   (MyNearWallet) come back to callbackUrl with the signature in the URL hash, which
   `completeNearRedirect` finishes on the next page load. Lazy-loaded with the login sheet. */
import { useState } from "react";
import { Buffer } from "buffer";
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupSender } from "@near-wallet-selector/sender";
import { setupNightly } from "@near-wallet-selector/nightly";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupOKXWallet } from "@near-wallet-selector/okx-wallet";
import { setupCoin98Wallet } from "@near-wallet-selector/coin98-wallet";
import { setupWelldoneWallet } from "@near-wallet-selector/welldone-wallet";
import { setupNearSnap } from "@near-wallet-selector/near-snap";
import { setupLedger } from "@near-wallet-selector/ledger";

/**
 * Every wallet module that can sign a NEP-413 login message on testnet. Left out on purpose: Math and
 * Bitte (no working message signing), Arepa (message signing unsupported), Unity and WalletConnect
 * (need a WalletConnect project id), NEAR Mobile (heavy native build tools).
 */
const walletModules = () => [
  setupMeteorWallet(), setupMyNearWallet(), setupHereWallet(), setupSender(), setupNightly(), setupIntearWallet(),
  setupHotWallet(), setupOKXWallet(), setupCoin98Wallet(), setupWelldoneWallet(), setupNearSnap(), setupLedger(),
];
import "@near-wallet-selector/modal-ui/styles.css";
import { api } from "../data";
import type { LoginResult, NearNonce } from "../data";
import { Icon } from "../components/Icon";
import { Busy } from "../components/console/Status";

const PENDING = "ramx.near-login.v1";

type Pending = { nonce: string; callbackUrl: string };
function savePending(p: Pending) { try { sessionStorage.setItem(PENDING, JSON.stringify(p)); } catch { /* private window */ } }
function takePending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(PENDING);
    sessionStorage.removeItem(PENDING);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

/** After a redirect wallet returns: finish the login if the URL hash carries a signature. */
export async function completeNearRedirect(): Promise<LoginResult | null> {
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  const signature = h.get("signature");
  const accountId = h.get("accountId");
  const publicKey = h.get("publicKey");
  if (!signature || !accountId || !publicKey) return null;
  history.replaceState(null, "", location.pathname + location.search);
  const p = takePending();
  if (!p) throw new Error("This NEAR login was started in another tab or has expired. Log in again.");
  return api.auth.nearVerify({ account_id: accountId, public_key: publicKey, signature, nonce: p.nonce, callback_url: p.callbackUrl });
}

export default function NearLogin({ onLogin, onError }: { onLogin: (r: LoginResult) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const n: NearNonce = await api.auth.nearNonce();
      const selector = await setupWalletSelector({ network: "testnet", modules: walletModules() });
      const modal = setupModal(selector, { contractId: "", description: "Log in to RAMX with your NEAR testnet account. No transaction, no fee: the wallet only signs a login message." });
      // A wallet connected in an earlier attempt stays selected: go straight to signing.
      const walletId = selector.store.getState().selectedWalletId ?? await new Promise<string>((resolve, reject) => {
        let done = false;
        let sub: { unsubscribe(): void } | undefined;
        const finish = (fn: () => void) => { if (done) return; done = true; sub?.unsubscribe(); fn(); };
        // The store can emit synchronously inside subscribe(), before `sub` is assigned.
        sub = selector.store.observable.subscribe((state) => {
          const id = state.selectedWalletId;
          if (id) finish(() => { modal.hide(); resolve(id); });
        });
        if (done) sub.unsubscribe();
        modal.on("onHide", ({ hideReason }) => { if (hideReason === "user-triggered") finish(() => reject(new Error("cancelled"))); });
        modal.show();
      });
      const wallet = await selector.wallet(walletId);
      if (!wallet.signMessage) throw new Error(`${walletId} cannot sign messages; pick another wallet.`);
      const callbackUrl = `${location.origin}${location.pathname}`;
      savePending({ nonce: n.nonce, callbackUrl });
      const signed = await wallet.signMessage({ message: n.message, recipient: n.recipient, nonce: Buffer.from(n.nonce, "base64"), callbackUrl });
      if (!signed) return; // redirect wallet: the page comes back with the signature (completeNearRedirect)
      takePending();
      onLogin(await api.auth.nearVerify({ account_id: signed.accountId, public_key: signed.publicKey, signature: signed.signature, nonce: n.nonce, callback_url: callbackUrl }));
    } catch (e) {
      const m = (e as Error).message;
      if (m !== "cancelled") { console.error("NEAR login failed:", e); onError(m); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="button" disabled={busy} onClick={() => void start()}>
      <Icon name="wallet" size={15} /> {busy ? <Busy>Waiting for the wallet…</Busy> : "Continue with a NEAR wallet"}
    </button>
  );
}
