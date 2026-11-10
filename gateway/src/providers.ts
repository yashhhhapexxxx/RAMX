import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { verifyMessage } from "viem";
import { ProviderCreate, ProviderJoin, ProviderOverview, ProviderPool, ProviderProgress, ProviderSnapshots, NodeRegisterRequest } from "@ramx/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Signer } from "./events.ts";
import type { AppEnv } from "./app.ts";
import { session, bearer } from "./auth.ts";
import { isBanned } from "./incentives.ts";
import { errorResponse } from "./errors.ts";
import { registerHandler, registerMessage } from "./nodes.ts";
import { poolState } from "./route.ts";
import { providerPool, providerMembers, providerConnected, type ProviderMemberRow } from "./provider-state.ts";
import { ProviderRelay } from "./provider-relay.ts";
import { providerAsset, providerBundle, assetHash } from "./provider-assets.ts";
import type { Directory } from "./router.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const id = (prefix: string) => prefix + randomBytes(12).toString("hex");
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const objectBody = async (c: Context) => { const body = await c.req.json().catch(() => null); return body && typeof body === "object" && !Array.isArray(body) ? body : {}; };
const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 503, text: string) => errorResponse(c, status, status === 401 ? "unauthorized" : "bad_request", text);

/** True when every approved member reported the same memory size (±0.5 GB). */
export function equalLayers(members: { mem_gb: number | null }[]): boolean {
  const mems = members.map(m => m.mem_gb);
  if (mems.length < 2 || mems.some(m => m === null || !(m > 0))) return false;
  return Math.max(...(mems as number[])) - Math.min(...(mems as number[])) <= 0.5;
}

export function providerRoutes(db: Db, cfg: Config, signer: Signer, relay: ProviderRelay, directory: Directory) {
  const app = new Hono<AppEnv>();
  // Upload responses are streamed with their own byte limit in ProviderRelay.
  const limit = bodyLimit({ maxSize: 512 * 1024 });
  app.use("*", (c, next) => c.req.path.includes("/helper/jobs/") ? next() : limit(c, next));
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer"); return next(); });
  let bundle: Buffer | undefined;
  const bytes = () => bundle ??= providerBundle();
  app.get("/bootstrap", c => c.json({ bundle_sha256: assetHash(bytes()), helper_sha256: assetHash(providerAsset("helper.py")) }));
  app.get("/bundle.zip", c => new Response(new Uint8Array(bytes()), { headers: { "content-type": "application/zip", "cache-control": "no-store" } }));
  app.get("/helper.py", c => c.body(providerAsset("helper.py").toString(), 200, { "content-type": "text/x-python" }));
  app.get("/install.sh", c => c.body(providerAsset("install.sh").toString(), 200, { "content-type": "text/plain" }));

  const accessible = (poolId: string, account: string) => providerMembers(db, poolId).some(m => m.account_id === account);
  const poolView = (poolId: string) => {
    const pool = providerPool(db, poolId)!;
    const now = Date.now();
    return ProviderPool.parse({ ...pool, coordinator_connected: providerConnected(db, poolId),
      members: providerMembers(db, poolId).map(m => {
        const node = m.node_id ? db.prepare("SELECT hb_ts,hb_online FROM nodes WHERE node_id=?").get(m.node_id) as { hb_ts: number; hb_online: number } | undefined : undefined;
        return { ...m, approved: !!m.approved,
          online: !!m.last_seen && m.last_seen > now - 30_000 && !!node?.hb_online && node.hb_ts > now - 30_000 };
      }) });
  };
  const maybeStart = (poolId: string) => {
    const pool = providerPool(db, poolId)!;
    const members = providerMembers(db, poolId).filter(m => m.approved);
    if (pool.state === "preparing" && members.length >= pool.expected_members && pool.snapshots
      && members.every(m => m.token_hash && m.last_seen && m.last_seen > Date.now() - 30_000 && m.stage === "prepared")) {
      db.prepare("UPDATE provider_pools SET state='starting', generation=generation+1, scheduler_addr=NULL, start_at=NULL WHERE pool_id=?").run(poolId);
    }
  };

  const browser = new Hono<AppEnv>();
  browser.use("*", session(cfg.env.JWT_SECRET, true));
  browser.use("*", async (c, next) => {
    if (!db.prepare("SELECT id FROM accounts WHERE id=?").get(c.get("accountId")!)) return fail(c, 401, "Account session is no longer available; log in with World ID again");
    return isBanned(db, c.get("accountId")!) ? fail(c, 403, "This account cannot provide nodes") : next();
  });
  browser.get("/", c => {
    const rows = db.prepare("SELECT pool_id FROM provider_members WHERE account_id=? AND revoked=0").all(c.get("accountId")!) as { pool_id: string }[];
    return c.json(ProviderOverview.parse({ models: cfg.net.models, pools: rows.map(r => poolView(r.pool_id)) }));
  });
  browser.post("/", async c => {
    const parsed = ProviderCreate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !cfg.model(parsed.success ? parsed.data.model : "")) return fail(c, 400, "Choose a supported model, payout address and 2–16 members");
    const r = parsed.data, poolId = id("pool_"), memberId = id("pm_"), account = c.get("accountId")!;
    const count = db.prepare("SELECT count(*) AS n FROM provider_pools WHERE owner_account=? AND state!='stopped'").get(account) as { n: number };
    if (count.n >= 3) return fail(c, 409, "Stop an existing pool before creating another");
    db.transaction(() => {
      db.prepare("INSERT INTO provider_pools (pool_id,owner_account,name,model,expected_members,dht_prefix,lan_secret,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(poolId, account, r.name, r.model, r.expected_members, "gp-" + randomBytes(12).toString("hex"), randomBytes(32).toString("hex"), Date.now());
      db.prepare("INSERT INTO provider_members (id,pool_id,account_id,role,approved,payout_address) VALUES (?,?,?,'coordinator',1,?)")
        .run(memberId, poolId, account, r.payout_address);
    })();
    return c.json(poolView(poolId), 201);
  });
  browser.post("/join", async c => {
    const parsed = ProviderJoin.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "Enter a valid Pool ID and payout address");
    const pool = providerPool(db, parsed.data.pool_id);
    if (!pool || pool.state === "stopped") return fail(c, 404, "Pool not found or stopped");
    const existing = providerMembers(db, pool.pool_id).find(m => m.account_id === c.get("accountId"));
    if (existing) return c.json(poolView(pool.pool_id));
    if (providerMembers(db, pool.pool_id).length >= 16) return fail(c, 409, "This pool has reached its member limit");
    const old = db.prepare("SELECT id FROM provider_members WHERE pool_id=? AND account_id=?").get(pool.pool_id, c.get("accountId")!) as { id: string } | undefined;
    if (old) {
      db.prepare("UPDATE provider_members SET revoked=0,approved=0,token_hash=NULL,stage='waiting',message='Rejoin requested',payout_address=? WHERE id=?").run(parsed.data.payout_address, old.id);
      return c.json(poolView(pool.pool_id), 201);
    }
    db.prepare("INSERT INTO provider_members (id,pool_id,account_id,role,payout_address) VALUES (?,?,?,'member',?)")
      .run(id("pm_"), pool.pool_id, c.get("accountId")!, parsed.data.payout_address);
    return c.json(poolView(pool.pool_id), 201);
  });
  browser.get("/:pool", c => accessible(c.req.param("pool"), c.get("accountId")!) ? c.json(poolView(c.req.param("pool"))) : fail(c, 404, "Pool not found"));
  browser.post("/:pool/members/:member/:action", c => {
    const pool = providerPool(db, c.req.param("pool"));
    if (!pool || pool.owner_account !== c.get("accountId")) return fail(c, 403, "Only the coordinator can manage membership");
    const member = providerMembers(db, pool.pool_id).find(m => m.id === c.req.param("member"));
    if (!member || member.role === "coordinator") return fail(c, 404, "Member not found");
    const action = c.req.param("action");
    if (!["approve", "revoke"].includes(action)) return fail(c, 400, "Unknown member action");
    if (action === "approve" && member.approved) return c.json(poolView(pool.pool_id));
    db.transaction(() => {
      if (action === "approve") {
        db.prepare("UPDATE provider_members SET approved=1 WHERE id=?").run(member.id);
        const count = providerMembers(db, pool.pool_id).filter(m => m.approved).length;
        db.prepare("UPDATE provider_pools SET expected_members=max(expected_members,?), state='preparing', start_at=NULL, scheduler_addr=NULL WHERE pool_id=?").run(count, pool.pool_id);
      } else {
        db.prepare("UPDATE provider_members SET revoked=1,approved=0,token_hash=NULL,stage='stopped' WHERE id=?").run(member.id);
        if (member.node_id) db.prepare("UPDATE nodes SET hb_online=0 WHERE node_id=?").run(member.node_id);
        db.prepare("UPDATE provider_pools SET state='preparing', start_at=NULL, scheduler_addr=NULL WHERE pool_id=?").run(pool.pool_id);
        relay.closePool(pool.pool_id);
      }
    })();
    return c.json(poolView(pool.pool_id));
  });
  browser.post("/:pool/stop", c => {
    const pool = providerPool(db, c.req.param("pool"));
    if (!pool || pool.owner_account !== c.get("accountId")) return fail(c, 403, "Only the coordinator can stop the pool");
    db.prepare("UPDATE provider_pools SET state='stopped' WHERE pool_id=?").run(pool.pool_id);
    relay.closePool(pool.pool_id);
    return c.json(poolView(pool.pool_id));
  });
  browser.post("/:pool/restart", c => {
    const pool = providerPool(db, c.req.param("pool"));
    if (!pool || pool.owner_account !== c.get("accountId")) return fail(c, 403, "Only the coordinator can restart the pool");
    db.prepare("UPDATE provider_pools SET state='preparing',scheduler_addr=NULL,start_at=NULL WHERE pool_id=?").run(pool.pool_id);
    db.prepare("UPDATE provider_members SET stage='waiting',message='Preparing a coordinated restart' WHERE pool_id=? AND approved=1 AND revoked=0").run(pool.pool_id);
    relay.closePool(pool.pool_id);
    return c.json(poolView(pool.pool_id));
  });
  browser.post("/:pool/enroll", c => {
    const member = providerMembers(db, c.req.param("pool")).find(m => m.account_id === c.get("accountId") && m.approved);
    if (!member) return fail(c, 403, "The coordinator must approve your membership first");
    if (providerPool(db, member.pool_id)?.state === "stopped") return fail(c, 409, "Restart the pool before connecting helpers");
    if (!cfg.env.PUBLIC_URL) return fail(c, 503, "The operator must configure PUBLIC_URL for helper downloads");
    const base = cfg.env.PUBLIC_URL.replace(/\/$/, ""), code = randomBytes(24).toString("hex"), expires = Date.now() + 15 * 60_000;
    db.transaction(() => {
      db.prepare("DELETE FROM provider_enrollments WHERE member_id=? OR expires_at<?").run(member.id, Date.now());
      db.prepare("INSERT INTO provider_enrollments (code_hash,member_id,expires_at) VALUES (?,?,?)").run(hash(code), member.id, expires);
    })();
    return c.json({ member_id: member.id, expires_at: expires,
      command: `curl -fsSL ${quote(base + "/provider/install.sh")} | bash -s -- --gateway ${quote(base)} --code ${quote(code)}` });
  });
  app.route("/pools", browser);

  const enrollment = (code: unknown) => typeof code === "string" && /^[a-f0-9]{48}$/.test(code)
    ? db.prepare("SELECT m.* FROM provider_enrollments e JOIN provider_members m ON m.id=e.member_id WHERE e.code_hash=? AND e.consumed_at IS NULL AND e.expires_at>? AND m.approved=1 AND m.revoked=0")
      .get(hash(code), Date.now()) as ProviderMemberRow | undefined : undefined;
  app.post("/enroll/info", async c => {
    const body = await objectBody(c), member = enrollment(body.code);
    if (!member) return fail(c, 401, "Enrollment code expired or already used; generate a new command in the website");
    const pool = providerPool(db, member.pool_id)!;
    return c.json({ pool_id: pool.pool_id, role: member.role, member_id: member.id, model: pool.model });
  });
  app.post("/enroll/failure", async c => {
    const body = await objectBody(c), member = enrollment(body.code);
    if (!member) return fail(c, 401, "Enrollment code expired or already used");
    const message = typeof body.message === "string" ? body.message.slice(0, 240).replace(/[\x00-\x1f]/g, " ") : "Local setup needs attention";
    db.prepare("UPDATE provider_members SET stage='error',message=? WHERE id=?").run(message, member.id);
    return c.json({ ok: true });
  });
  app.post("/enroll/claim", async c => {
    const body = await objectBody(c), member = enrollment(body.code);
    if (!member) return fail(c, 401, "Enrollment code expired or already used");
    body.payout_address = member.payout_address;
    const parsed = NodeRegisterRequest.safeParse(body);
    if (!parsed.success || parsed.data.pool_id !== member.pool_id) return fail(c, 400, "Invalid node registration");
    const r = parsed.data;
    if (member.node_id && member.node_id !== r.node_id) return fail(c, 409, "This membership is bound to another node key; keep the original local key");
    if (Math.abs(Date.now() - r.ts) > 60_000) return fail(c, 400, "Check the laptop clock, then retry");
    if (!await verifyMessage({ address: r.node_id as `0x${string}`, message: registerMessage(r.node_id, r.pool_id, r.ts), signature: r.node_sig as `0x${string}` }).catch(() => false)) return fail(c, 401, "Node signature is invalid");
    const bound = db.prepare("SELECT id FROM provider_members WHERE node_id=?").get(r.node_id) as { id: string } | undefined;
    if (bound && bound.id !== member.id) return fail(c, 409, "This node key is already bound to another membership");
    const taken = db.prepare("UPDATE provider_enrollments SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?").run(Date.now(), hash(body.code), Date.now());
    if (!taken.changes) return fail(c, 409, "Enrollment code already consumed");
    const previousNode = member.node_id;
    db.prepare("UPDATE provider_members SET node_id=? WHERE id=?").run(r.node_id, member.id);
    c.set("accountId", member.account_id);
    // Reuse signature, payout, ownership, node-cap and audit rules of the existing route.
    const response = await registerHandler(db, cfg, signer, r)(c);
    if (!response.ok) {
      db.prepare("UPDATE provider_members SET node_id=? WHERE id=?").run(previousNode, member.id);
      return response;
    }
    if (previousNode && previousNode !== r.node_id) db.prepare("UPDATE nodes SET hb_online=0 WHERE node_id=?").run(previousNode);
    // Payout is owner-approved in the website, never chosen by an unauthenticated helper.
    const acc = db.prepare("SELECT payout_address FROM accounts WHERE id=?").get(member.account_id) as { payout_address: string };
    if (!acc.payout_address) return fail(c, 400, "Set the account payout address before pairing");
    const token = "gph_" + randomBytes(32).toString("hex");
    db.prepare("UPDATE provider_members SET token_hash=?,token_expires_at=?,last_seen=?,stage='installing',gpu=?,mem_gb=? WHERE id=?")
      .run(hash(token), Date.now() + 30 * 86400_000, Date.now(), r.gpu, r.mem_gb, member.id);
    db.prepare("UPDATE provider_pools SET state='preparing',scheduler_addr=NULL,start_at=NULL WHERE pool_id=? AND state!='stopped'").run(member.pool_id);
    db.prepare("UPDATE provider_members SET stage='waiting',message='Preparing a coordinated start' WHERE pool_id=? AND id!=? AND approved=1 AND revoked=0").run(member.pool_id, member.id);
    relay.closePool(member.pool_id);
    return c.json({ token, pool_id: member.pool_id, member_id: member.id, role: member.role });
  });

  const helper = new Hono<AppEnv & { Variables: { helper: ProviderMemberRow } }>();
  helper.use("*", async (c, next) => {
    const token = bearer(c);
    const member = token && /^gph_[a-f0-9]{64}$/.test(token) ? db.prepare("SELECT * FROM provider_members WHERE token_hash=? AND token_expires_at>? AND approved=1 AND revoked=0").get(hash(token), Date.now()) as ProviderMemberRow | undefined : undefined;
    if (!member || isBanned(db, member.account_id)) return fail(c, 401, "Helper authorization expired or revoked");
    c.set("helper", member);
    db.prepare("UPDATE provider_members SET last_seen=? WHERE id=?").run(Date.now(), member.id);
    return next();
  });
  helper.get("/config", c => {
    const member = c.get("helper"), pool = providerPool(db, member.pool_id)!;
    maybeStart(pool.pool_id);
    const fresh = providerPool(db, pool.pool_id)!;
    const members = providerMembers(db, pool.pool_id).filter(m => m.approved);
    const coordinator = members.find(m => m.role === "coordinator")!;
    return c.json({ ...fresh, lan_secret: pool.lan_secret, snapshots: pool.snapshots ? JSON.parse(pool.snapshots) : null,
      server_time: Date.now(), role: member.role, member_id: member.id, stage: member.stage,
      node_port: member.role === "coordinator" ? 5101 : 5102 + members.filter(m => m.role !== "coordinator").findIndex(m => m.id === member.id),
      coordinator_ip: coordinator.ip, member_ips: members.map(m => m.ip).filter(Boolean), model_config: cfg.model(pool.model),
      node_batching: cfg.net.node_batching,
      // Same-memory members (e.g. all 16 GB Macs): the scheduler hook gives every member an equal layer share
      // instead of Parallax's fewest-stages split. Mixed pools keep Parallax's split (a small GPU could not hold an equal share).
      equal_layers: equalLayers(members) });
  });
  helper.post("/progress", async c => {
    const member = c.get("helper"), parsed = ProviderProgress.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "Invalid progress update");
    const r = parsed.data;
    if (r.ip && (!isIP(r.ip) || r.ip === "0.0.0.0" || r.ip.startsWith("127."))) return fail(c, 400, "Report the Ethernet IPv4 address");
    db.prepare("UPDATE provider_members SET stage=?,message=?,ip=coalesce(?,ip),gpu=coalesce(?,gpu),mem_gb=coalesce(?,mem_gb),bytes_done=?,bytes_total=?,last_seen=? WHERE id=?")
      .run(r.stage, r.message.replace(/[\x00-\x1f]/g, " "), r.ip ?? null, r.gpu ?? null, r.mem_gb ?? null, r.bytes_done, r.bytes_total, Date.now(), member.id);
    if (r.stage === "error") { db.prepare("UPDATE provider_pools SET state='preparing',start_at=NULL WHERE pool_id=?").run(member.pool_id); relay.closePool(member.pool_id); }
    maybeStart(member.pool_id);
    return c.json({ ok: true });
  });
  helper.post("/snapshots", async c => {
    const member = c.get("helper");
    if (member.role !== "coordinator") return fail(c, 403, "Coordinator only");
    const snapshots = ProviderSnapshots.safeParse(await c.req.json().catch(() => null));
    const pool = providerPool(db, member.pool_id)!, model = cfg.model(pool.model)!;
    // The coordinator shares its own format and the other one only if it has it cached (an all-Mac pool has no GPU copy).
    // A member whose format is missing stops with a clear error in its helper.
    if (!snapshots.success || !(snapshots.data[model.model_id] || (model.mlx_variant && snapshots.data[model.mlx_variant]))) return fail(c, 400, "A GPU or MLX model snapshot is required");
    for (const [repo, snapshot] of Object.entries(snapshots.data)) {
      if (![model.model_id, model.mlx_variant].includes(repo) || !snapshot.files["config.json"] || !Object.keys(snapshot.files).some(n => n.endsWith(".safetensors"))) return fail(c, 400, "Unexpected model snapshot");
      if (Object.keys(snapshot.files).some(n => n.startsWith("/") || n.split("/").includes("..") || n.includes("\\"))) return fail(c, 400, "Unsafe model path");
    }
    db.prepare("UPDATE provider_pools SET snapshots=? WHERE pool_id=?").run(JSON.stringify(snapshots.data), pool.pool_id);
    return c.json({ ok: true });
  });
  helper.post("/scheduler", async c => {
    const member = c.get("helper"), body = await objectBody(c), pool = providerPool(db, member.pool_id)!;
    if (member.role !== "coordinator" || pool.state !== "starting") return fail(c, 403, "Coordinator start phase only");
    if (typeof body.address !== "string" || !new RegExp(`^/ip4/${member.ip?.replaceAll(".", "\\.")}/tcp/5100/p2p/12D3[A-Za-z0-9]+$`).test(body.address)) return fail(c, 400, "Invalid scheduler address");
    db.prepare("UPDATE provider_pools SET scheduler_addr=?,start_at=? WHERE pool_id=?").run(body.address, Date.now() + 10_000, pool.pool_id);
    return c.json({ ok: true });
  });
  helper.post("/ready", async c => {
    const member = c.get("helper"), pool = providerPool(db, member.pool_id)!;
    if (member.role !== "coordinator" || pool.state !== "starting") return fail(c, 403, "Coordinator start phase only");
    if (poolState(db, cfg, pool.pool_id).status !== "ready") return fail(c, 409, "Waiting for signed layer coverage from node agents");
    try {
      const listings = await directory.readyPools(pool.model);
      if (!listings.some(p => p.pool_id === pool.pool_id)) return fail(c, 409, "Waiting for the pool to appear as ready in the directory");
    } catch { return fail(c, 503, "The directory is unavailable; pool readiness has not been confirmed"); }
    db.prepare("UPDATE provider_pools SET state='ready' WHERE pool_id=?").run(pool.pool_id);
    return c.json({ ok: true });
  });
  helper.get("/jobs", async c => c.get("helper").role === "coordinator" ? c.json({ job: await relay.poll(c.get("helper").pool_id, c.req.raw.signal) }) : fail(c, 403, "Coordinator only"));
  // The coordinator streams each answer as ordered small parts (see ProviderRelay.part): a proxy that buffers
  // request bodies then delays one part, not the whole answer.
  helper.post("/jobs/:id/parts", async c => {
    const member = c.get("helper"), status = Number(c.req.header("x-upstream-status") ?? 200), seq = Number(c.req.header("x-part-seq"));
    if (member.role !== "coordinator" || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(status) || status < 200 || status > 599 || status === 204 || status === 304) return fail(c, 400, "Invalid relay response");
    const data = new Uint8Array(await c.req.arrayBuffer());
    const type = c.req.header("content-type")?.startsWith("text/event-stream") ? "text/event-stream" : "application/json";
    try { relay.part(member.pool_id, c.req.param("id"), seq, status, type, data, c.req.header("x-part-final") === "1"); }
    catch { return fail(c, 409, "Relay request was cancelled or already completed"); }
    return c.json({ ok: true });
  });
  app.route("/helper", helper);
  return app;
}
