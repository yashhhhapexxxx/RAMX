import { serve } from "@hono/node-server";
import { createServer as createHttpsServer } from "node:https";
import { purgeExpiredTranscripts, tlsOptions } from "./privacy.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { createPoolQueue } from "./queue.ts";
import { createRouter } from "./router.ts";
import { gatewayDirectory } from "./directory.ts";
import { logCompletion } from "./chat.ts";
import { signerFromSeed } from "./events.ts";
import { nearLedgerChain, startLedgerWriter } from "./ledger-chain.ts";
import { expireStarterCredits } from "./ledger.ts";
import { refreshReliability } from "./reliability.ts";
import { expireEarned, payAvailability, runPenalties, unlockDue } from "./incentives.ts";
import { createSettlement, startSettlementWorker } from "./settlement.ts";
import { nearSettlementChain } from "./payout-near.ts";
import { legalGate } from "./legal.ts";
import { createX402, httpFacilitator, localNearFacilitator } from "./x402.ts";
import { nearAiClient, sampleForJudge, startTeeJudge } from "./tee-judge.ts";
import { attestServed, NEARAI_POOL_ID, nearAiBase, nearAiFallbackOn, signServed } from "./nearai-upstream.ts";
import { startMarket } from "./market.ts";
import { maybeQueueVerification, startCanaryWorker, startVerificationWorker } from "./verification.ts";

let cfg: Config;
let signer;
try {
  cfg = loadConfig();
  if (!cfg.env.GATEWAY_SIGNING_KEY) throw new Error("GATEWAY_SIGNING_KEY is required (signs ledger events)");
  signer = signerFromSeed(cfg.env.GATEWAY_SIGNING_KEY);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const e = cfg.env;
legalGate(cfg);
const db = openDb(e.DATABASE_PATH, { resetOnMismatch: e.DB_RESET_ON_MISMATCH === "true" });

// x402 on NEAR: an in-process facilitator with our relayer account (default), or a remote facilitator URL.
const facilitator = e.X402_RELAYER_ID && e.X402_RELAYER_KEY
  ? localNearFacilitator({ network: cfg.net.x402_near.network, relayerId: e.X402_RELAYER_ID, relayerKey: e.X402_RELAYER_KEY, rpcUrl: e.NEAR_RPC_URL })
  : e.X402_FACILITATOR_URL ? httpFacilitator(e.X402_FACILITATOR_URL) : null;
const x402 = facilitator && e.X402_PAY_TO ? createX402({ cfg: cfg.net, facilitator, payTo: e.X402_PAY_TO, publicUrl: e.PUBLIC_URL }) : null;
if (!x402) console.warn("x402 not configured (X402_PAY_TO + X402_RELAYER_ID/X402_RELAYER_KEY or X402_FACILITATOR_URL): requests without a session get 402");

// NEAR ledger writer: async, never blocks a request (CLAUDE.md §4.9). Without the gateway NEAR account, events stay unsent in SQLite.
let stopLedger = () => {};
if (e.LEDGER_CONTRACT_ID && e.NEAR_GATEWAY_ACCOUNT_ID && e.NEAR_GATEWAY_KEY) {
  stopLedger = startLedgerWriter(db, nearLedgerChain({ contractId: e.LEDGER_CONTRACT_ID, writerId: e.NEAR_GATEWAY_ACCOUNT_ID, writerKey: e.NEAR_GATEWAY_KEY, rpcUrl: e.NEAR_RPC_URL }));
} else {
  console.warn("NEAR ledger not configured (LEDGER_CONTRACT_ID / NEAR_GATEWAY_ACCOUNT_ID / NEAR_GATEWAY_KEY): ledger events stay in SQLite only");
}

// Starter credit expiry (SPEC §8.2) and transcript deletion after 7 days, once a minute.
const expiry = setInterval(() => {
  try {
    const n = expireStarterCredits(db, signer);
    if (n > 0) console.log(JSON.stringify({ msg: "starter_expired", accounts: n }));
  } catch (err) {
    console.error(`starter expiry failed: ${(err as Error).message}`);
  }
  try {
    const t = purgeExpiredTranscripts(db);
    if (t > 0) console.log(JSON.stringify({ msg: "transcripts_deleted", rows: t }));
  } catch (err) {
    console.error(`transcript purge failed: ${(err as Error).message}`);
  }
}, 60_000);

/** SPEC §16.2 verification is a planned feature; off unless VERIFICATION_ENABLED=true. */
const verificationOn = cfg.env.VERIFICATION_ENABLED === "true";

// SPEC §16.3 incentives: unlock vested credits, expire old earnings, act on final fraud verdicts,
// pay standby rewards for the last epoch. Local SQLite + ledger events (async writer); once a minute.
const incentiveTick = () => {
  try {
    unlockDue(db);
    expireEarned(db, cfg.net, signer);
    if (verificationOn) runPenalties(db, cfg.net, signer); // penalties need verification verdicts
    const paid = payAvailability(db, cfg, signer);
    if (paid > 0) console.log(JSON.stringify({ msg: "availability_paid", mc: paid }));
  } catch (err) {
    console.error(`incentives tick failed: ${(err as Error).message}`);
  }
};
incentiveTick();
const incentivesTimer = setInterval(incentiveTick, 60_000);

refreshReliability(db, cfg);
const reliabilityTimer = setInterval(() => {
  try { refreshReliability(db, cfg); }
  catch (err) { console.error(`reliability refresh failed: ${(err as Error).message}`); }
}, cfg.env.HEARTBEAT_SECONDS * 1000);

let stopSettlement = () => {};
if (e.PAYOUT_CONTRACT_ID) {
  if (!e.LEDGER_CONTRACT_ID || !e.NEAR_GATEWAY_ACCOUNT_ID || !e.NEAR_GATEWAY_KEY) throw new Error("epoch settlement requires the NEAR ledger writer configuration");
  const chain = nearSettlementChain(cfg);
  stopSettlement = startSettlementWorker(createSettlement(db, cfg, signer, chain));
} else {
  console.warn("epoch settlement disabled: set PAYOUT_CONTRACT_ID, SETTLER_ACCOUNT_ID and SETTLER_KEY to enable");
}

const directory = gatewayDirectory(cfg, db);
const router = createRouter(cfg, db, directory);
const queue = createPoolQueue(cfg.net.router.max_concurrent_per_pool);
let stopVerification = () => {};
let stopCanaries = () => {};
if (verificationOn && e.VERIFIER_URL && e.VERIFIER_OWNER_ACCOUNT) {
  stopVerification = startVerificationWorker(db, cfg, signer);
  stopCanaries = startCanaryWorker(db, cfg, signer, router, queue);
} else {
  console.warn(verificationOn ? "output verification disabled: configure a trusted VERIFIER_URL and VERIFIER_OWNER_ACCOUNT" : "output verification disabled (VERIFICATION_ENABLED=false; planned feature)");
}

const stopMarket = startMarket(db, cfg, signer);
// Phase 6.2: TEE spot-check of a sample of answers (NEAR AI Cloud).
const teeRate = e.TEE_JUDGE_RATE ?? 0.1;
const nearAi = e.NEARAI_API_KEY ? nearAiClient(e.NEARAI_API_KEY, nearAiBase(cfg)) : null;
const stopTee = nearAi ? startTeeJudge(db, cfg, signer, nearAi, e.TEE_JUDGE_MODEL) : () => {};
if (!nearAi) console.warn("TEE spot-check and judge mode off (NEARAI_API_KEY not set)");
else if (nearAiFallbackOn(cfg)) console.log("judge mode on: requests with no ready pool (or x-ramx-privacy: tee) are served by NEAR AI Cloud");
const app = createApp({ cfg, db, signer, x402, router, queue, directory, onComplete: (completion) => {
  logCompletion(completion);
  if (nearAi && completion.poolId !== NEARAI_POOL_ID && sampleForJudge(db, completion, teeRate)) console.log(JSON.stringify({ msg: "tee_check_queued", req_id: completion.reqId }));
  // Judge mode: attest the NEAR AI model that served this answer (fresh nonce), off the request path.
  if (nearAi && completion.ok && completion.poolId === NEARAI_POOL_ID) {
    attestServed(db, cfg, nearAi, completion)
      .then(async (a) => {
        if (!a) return;
        console.log(JSON.stringify({ msg: "tee_attested", req_id: completion.reqId, model: a.model, signing_address: a.signing_address }));
        // #8: bind this exact answer to the attested key (NEAR AI's per-chat signature).
        const s = await signServed(db, signer, nearAi, completion.reqId, a);
        if (s) console.log(JSON.stringify({ msg: "tee_answer_signed", req_id: completion.reqId, ...s }));
      })
      .catch((err) => console.warn(`tee attestation ${completion.reqId} failed: ${(err as Error).message}`));
  }
  if (completion.ok && verificationOn) {
    const id = maybeQueueVerification(db, cfg, completion.reqId);
    if (id) console.log(JSON.stringify({ msg: "verification_queued", verification_id: id, req_id: completion.reqId }));
  }
} });
// Privacy: HTTPS when TLS_CERT_FILE + TLS_KEY_FILE are set (src/privacy.ts); else HTTP (MVP).
let tls: ReturnType<typeof tlsOptions> = null;
try { tls = tlsOptions(cfg); } catch (err) { console.error((err as Error).message); process.exit(1); }
const server = serve({ fetch: app.fetch, port: e.PORT, hostname: e.HOST, ...(tls ? { createServer: createHttpsServer, serverOptions: tls } : {}) }, (info) => {
  console.log(`gateway listening on ${tls ? "https" : "http"}://${info.address}:${info.port} → pool ${e.POOL_COORDINATOR_URL}; gateway pubkey ${signer.publicKeyHex}`);
});

const shutdown = () => {
  clearInterval(expiry);
  clearInterval(reliabilityTimer);
  clearInterval(incentivesTimer);
  stopSettlement();
  stopVerification();
  stopCanaries();
  stopLedger();
  stopTee();
  stopMarket();
  server.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
