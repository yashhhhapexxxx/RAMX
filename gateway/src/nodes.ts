import type { Context } from "hono";
import { verifyMessage, type Hex } from "viem";
import { HeartbeatResponse, NodeHeartbeat, NodeRegisterRequest, NODE_SIGNATURE_HEADER, type NodeRegisterResponse } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errorResponse } from "./errors.ts";
import { recordHeartbeat, recordPoolUp } from "./reliability.ts";
import { poolState } from "./route.ts";
import { recordEvent, type Signer } from "./events.ts";
import { orderRestart, restartId, writeAllowedPeers } from "./pools.ts";
import { isBanned, nodeCap } from "./incentives.ts";
import { dhtPrefix, formPools, probeList } from "./formation.ts";
import { challengeForHeartbeat, recordChallengeReply } from "./verification.ts";
import { providerPool } from "./provider-state.ts";

/** shared/README.md "Signatures": the exact string the node key signs at registration. */
export const registerMessage = (nodeId: string, poolId: string, ts: number): string => `ramx-register:${nodeId}:${poolId}:${ts}`;

const REGISTER_MAX_AGE_MS = 24 * 3600 * 1000;
const HEARTBEAT_SKEW_MS = 60_000;

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) =>
  e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

/**
 * POST /nodes/register (session). Links a node key to the account (SPEC §6.3: max 3 nodes).
 * Re-registering the same node by the same account updates it (idempotent). A node owned by
 * another account → 409. Sets the payout address (required once) → payout_address_set event.
 */
export function registerHandler(db: Db, cfg: Config, signer: Signer, supplied?: NodeRegisterRequest) {
  return async (c: Context): Promise<Response> => {
    const accountId = c.get("accountId") as string;
    const parsed = NodeRegisterRequest.safeParse(supplied ?? await c.req.json().catch(() => undefined));
    if (!parsed.success) return errorResponse(c, 400, "bad_request", issues(parsed.error));
    const r = parsed.data;
    if (providerPool(db, r.pool_id) && !db.prepare("SELECT id FROM provider_members WHERE pool_id=? AND account_id=? AND node_id=? AND approved=1 AND revoked=0").get(r.pool_id, accountId, r.node_id)) {
      return errorResponse(c, 403, "unauthorized", "Join this pool through provider onboarding and obtain coordinator approval");
    }
    const now = Date.now();
    if (r.ts > now + HEARTBEAT_SKEW_MS || now - r.ts > REGISTER_MAX_AGE_MS) return errorResponse(c, 400, "bad_request", "registration link is older than 24 hours (run ramx-node init again)");
    let sigOk = false;
    try {
      sigOk = await verifyMessage({ address: r.node_id as Hex, message: registerMessage(r.node_id, r.pool_id, r.ts), signature: r.node_sig as Hex });
    } catch {
      sigOk = false;
    }
    if (!sigOk) return errorResponse(c, 401, "unauthorized", "node_sig is not a signature of the node key over ramx-register:<node_id>:<pool_id>:<ts>");

    const result = db.transaction((): Response | NodeRegisterResponse => {
      const acc = db.prepare("SELECT payout_address FROM accounts WHERE id = ?").get(accountId) as { payout_address: string | null } | undefined;
      if (!acc) return errorResponse(c, 401, "unauthorized", "account not found");
      const owner = db.prepare("SELECT account_id FROM nodes WHERE node_id = ?").get(r.node_id) as { account_id: string } | undefined;
      if (owner && owner.account_id !== accountId) return errorResponse(c, 409, "bad_request", "node is registered to another account");
      if (!owner) {
        const n = (db.prepare("SELECT count(*) AS n FROM nodes WHERE account_id = ?").get(accountId) as { n: number }).n;
        // SPEC §16.3: reputation-based cap (banned → 0).
        const cap = nodeCap(db, cfg, accountId, now);
        if (n >= cap) return errorResponse(c, 403, "node_limit_reached", cap === 0 ? "this account is banned from running nodes" : `this account can register at most ${cap} nodes now`);
      }
      if (!acc.payout_address && !r.payout_address) return errorResponse(c, 400, "bad_request", "payout_address is required for the first node (SPEC §10.4)");
      if (owner) {
        // SPEC §16.1 formation: re-registering an "auto" node keeps the pool the gateway gave it.
        db.prepare(`UPDATE nodes SET pool_id = CASE WHEN ? = 'auto' AND auto_pool = 1 THEN pool_id ELSE ? END,
          auto_pool = CASE WHEN ? = 'auto' THEN 1 ELSE 0 END, gpu = ?, mem_gb = ? WHERE node_id = ?`).run(r.pool_id, r.pool_id, r.pool_id, r.gpu, r.mem_gb, r.node_id);
      } else {
        db.prepare("INSERT INTO nodes (node_id, account_id, pool_id, gpu, mem_gb, registered_at, auto_pool) VALUES (?, ?, ?, ?, ?, ?, ?)").run(r.node_id, accountId, r.pool_id, r.gpu, r.mem_gb, now, r.pool_id === "auto" ? 1 : 0);
        db.prepare("INSERT INTO node_reliability (node_id, score, updated_at) VALUES (?, ?, ?)").run(r.node_id, cfg.net.reliability.initial_score, now);
      }
      if (r.payout_address && r.payout_address !== acc.payout_address) {
        db.prepare("UPDATE accounts SET payout_address = ? WHERE id = ?").run(r.payout_address, accountId);
        recordEvent(db, signer, { type: "payout_address_set", account_id: accountId as `acc_${string}`, payout_address: r.payout_address }, now);
      }
      return { node_id: r.node_id, account_id: accountId as `acc_${string}`, pool_id: r.pool_id };
    })();
    return result instanceof Response ? result : c.json(result);
  };
}

/**
 * POST /nodes/heartbeat. Header x-ramx-node-signature = EIP-191 personal_sign by the node key
 * over the RAW body bytes. The body is checked against the signature before it is parsed. ts must
 * be within 60 s. Stores the latest status + layers; records one online observation per heartbeat slot for the rolling uptime score (SPEC §9.1).
 */
export function heartbeatHandler(db: Db, cfg: Config, signer: Signer, isPoolIdle: (poolId: string) => boolean = () => true) {
  return async (c: Context): Promise<Response> => {
    const raw = await c.req.text();
    const sig = c.req.header(NODE_SIGNATURE_HEADER);
    if (!sig || !/^0x[0-9a-fA-F]+$/.test(sig)) return errorResponse(c, 401, "unauthorized", `missing ${NODE_SIGNATURE_HEADER}`);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return errorResponse(c, 400, "bad_request", "body must be JSON");
    }
    const parsed = NodeHeartbeat.safeParse(json);
    if (!parsed.success) return errorResponse(c, 400, "bad_request", issues(parsed.error));
    const hb = parsed.data;
    let ok = false;
    try {
      ok = await verifyMessage({ address: hb.node_id as Hex, message: { raw: new TextEncoder().encode(raw) }, signature: sig as Hex });
    } catch {
      ok = false;
    }
    if (!ok) return errorResponse(c, 401, "unauthorized", "heartbeat signature does not match node_id");
    const now = Date.now();
    if (Math.abs(now - hb.ts) > HEARTBEAT_SKEW_MS) return errorResponse(c, 400, "bad_request", "heartbeat ts is more than 60 s from gateway time");
    const node = db.prepare("SELECT account_id, pool_id, auto_pool FROM nodes WHERE node_id = ?").get(hb.node_id) as { account_id: string; pool_id: string; auto_pool: number } | undefined;
    if (!node) return errorResponse(c, 404, "not_found", "node is not registered (open the ramx-node init link)");
    if (providerPool(db, node.pool_id) && !db.prepare("SELECT id FROM provider_members WHERE pool_id=? AND node_id=? AND approved=1 AND revoked=0").get(node.pool_id, hb.node_id)) return errorResponse(c, 403, "unauthorized", "Pool membership was revoked");
    if (isBanned(db, node.account_id)) return errorResponse(c, 403, "unauthorized", "the owner of this node is banned (SPEC §16.3)");
    // An "auto" node may still say "auto" until it has seen its assigned pool.
    if (node.pool_id !== hb.pool_id && !(node.auto_pool === 1 && hb.pool_id === "auto")) return errorResponse(c, 400, "bad_request", `node is registered in pool ${node.pool_id}, heartbeat says ${hb.pool_id}`);
    const verificationOn = cfg.env.VERIFICATION_ENABLED === "true";
    if (verificationOn && hb.challenge_result) recordChallengeReply(db, cfg, signer, hb.node_id, hb.challenge_result, now);
    const score = db.transaction(() => {
      const prev = db.prepare("SELECT hb_online, hb_layers, hb_model FROM nodes WHERE node_id = ?").get(hb.node_id) as { hb_online: number | null; hb_layers: string | null; hb_model: string | null };
      db.prepare(`UPDATE nodes SET hb_ts = ?, hb_online = ?, hb_model = ?, hb_layers = ?, hb_tok_s = ?,
        hb_peer_id = ?, hb_lan_ip = ?, hb_mem_pressure = ?, hb_usable_mem_gb = ?, hb_restart_ack = ?, hb_p2p_port = ?, hb_max_seq = ? WHERE node_id = ?`).run(
        now, hb.online ? 1 : 0, hb.model, hb.layers ? JSON.stringify(hb.layers) : null, hb.tok_s,
        hb.peer_id, hb.lan_ip, hb.mem_pressure, hb.usable_mem_gb, hb.restart_ack, hb.p2p_port, hb.max_seq, hb.node_id);
      // SPEC §16.1 formation: delays this node measured to the peers it was asked to probe.
      const rtt = db.prepare("INSERT INTO node_rtt (a, b, ms, ts) VALUES (?, ?, ?, ?) ON CONFLICT(a, b) DO UPDATE SET ms = excluded.ms, ts = excluded.ts");
      for (const [peer, ms] of Object.entries(hb.rtt_ms ?? {})) if (peer !== hb.node_id) rtt.run(hb.node_id, peer, ms, now);
      recordHeartbeat(db, cfg, hb.node_id, hb.online, now);
      // SPEC §9.2 pool uptime: this slot counts for the pool if every member is fresh and the layers cover the model once.
      if (node.pool_id !== "auto" && poolState(db, cfg, node.pool_id, now).status === "ready") recordPoolUp(db, cfg, node.pool_id, now);
      // P5.9: what the node says it served (Parallax --notify-url), kept for the cross-check window.
      if (hb.served_sessions) {
        db.prepare("INSERT INTO node_served (node_id, peer_id, sessions, ts) VALUES (?, ?, ?, ?)").run(hb.node_id, hb.peer_id, hb.served_sessions, now);
      }
      db.prepare("DELETE FROM node_served WHERE node_id = ? AND ts < ?").run(hb.node_id, now - cfg.net.resilience.route_check_window_s * 1000);
      // P5.5: layers changed while the node stayed online = live re-placement by Parallax. Do not trust
      // it: order a clean restart of the whole pool (a restart passes through offline, so never loops).
      const newLayers = hb.layers ? JSON.stringify(hb.layers) : null;
      if (hb.online && prev.hb_online === 1 && prev.hb_layers && newLayers && prev.hb_layers !== newLayers && prev.hb_model === hb.model
          && (hb.restart_ack ?? 0) >= restartId(db, node.pool_id)) {
        orderRestart(db, cfg, node.pool_id, `node ${hb.node_id} layers ${prev.hb_layers} -> ${newLayers}`, now);
      }
      return (db.prepare("SELECT score FROM node_reliability WHERE node_id = ?").get(hb.node_id) as { score: number } | undefined)?.score;
    })();
    try {
      writeAllowedPeers(db, cfg, now);
    } catch (e) {
      console.error(`allow-list write failed: ${(e as Error).message}`);
    }
    // SPEC §16.1: form pools from "auto" nodes, elect the listing writer, hand out probes.
    let poolId = node.pool_id;
    if (node.auto_pool === 1 && poolId === "auto") {
      formPools(db, cfg, now);
      poolId = (db.prepare("SELECT pool_id FROM nodes WHERE node_id = ?").get(hb.node_id) as { pool_id: string }).pool_id;
    }
    const auto = node.auto_pool === 1 && poolId !== "auto"
      ? { pool_id: poolId, dht_prefix: dhtPrefix(cfg, poolId), model: (db.prepare("SELECT model FROM pools WHERE pool_id = ?").get(poolId) as { model: string } | undefined)?.model ?? cfg.net.models[0]!.model_id }
      : null;
    const inPool = poolId !== "auto";
    const challenge = verificationOn && inPool ? challengeForHeartbeat(db, signer, hb.node_id, poolId, isPoolIdle(poolId), cfg.env.HEARTBEAT_SECONDS, now) : null;
    return c.json(HeartbeatResponse.parse({
      ok: true, owner_account: node.account_id, reliability: score ?? cfg.net.reliability.initial_score,
      restart_id: inPool ? restartId(db, poolId) : 0,
      assigned_pool: auto,
      probe: node.auto_pool === 1 && !inPool ? probeList(db, cfg, hb.node_id, now) : [],
      challenge,
    }));
  };
}
