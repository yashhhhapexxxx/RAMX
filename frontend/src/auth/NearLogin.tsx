/* NEAR wallet login (NEP-413 signMessage). The gateway hands out a single-use nonce; the wallet
   signs {message, nonce, recipient}; the gateway checks the signature and that the key is a
   full-access key of the account, then returns the usual session. A NEAR-only account gets no
   starter credits (they need World ID). Popup wallets (Meteor) answer in place; redirect wallets
   (MyNearWallet) come back to callbackUrl with the signature in the URL hash, which
   `completeNearRedirect` finishes on the next page load. Lazy-loaded with the login sheet. */
import { useState } from "react";
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import { api } from "../data";
import type { LoginResult, NearNonce } from "../data";
import { Icon } from "../components/Icon";
import { Busy } from "../components/console/Status";

const PENDING = "ramx.near-login.v1";
const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

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
      const selector = await setupWalletSelector({ network: "testnet", modules: [setupMeteorWallet(), setupMyNearWallet()] });
      const modal = setupModal(selector, { contractId: "", description: "Log in to RAMX with your NEAR testnet account. No transaction, no fee: the wallet only signs a login message." });
      modal.show();
      const walletId = await new Promise<string>((resolve, reject) => {
        const sub = selector.store.observable.subscribe((state) => {
          if (state.selectedWalletId) { sub.unsubscribe(); modal.hide(); resolve(state.selectedWalletId); }
        });
        modal.on("onHide", ({ hideReason }) => { if (hideReason === "user-triggered") { sub.unsubscribe(); reject(new Error("cancelled")); } });
      });
      const wallet = await selector.wallet(walletId);
      if (!wallet.signMessage) throw new Error(`${walletId} cannot sign messages; pick another wallet.`);
      const callbackUrl = `${location.origin}${location.pathname}`;
      savePending({ nonce: n.nonce, callbackUrl });
      const signed = await wallet.signMessage({ message: n.message, recipient: n.recipient, nonce: b64ToBytes(n.nonce) as unknown as Buffer, callbackUrl });
      if (!signed) return; // redirect wallet: the page comes back with the signature (completeNearRedirect)
      takePending();
      onLogin(await api.auth.nearVerify({ account_id: signed.accountId, public_key: signed.publicKey, signature: signed.signature, nonce: n.nonce, callback_url: callbackUrl }));
    } catch (e) {
      const m = (e as Error).message;
      if (m !== "cancelled") onError(m);
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
