#!/usr/bin/env node
/**
 * DEV ONLY: make a test account + session token WITHOUT World (no phone at the desk).
 *   node --env-file=.env scripts/dev-session.ts [label]
 * Needs direct access to the SQLite file (DATABASE_PATH) and JWT_SECRET, so it is not an HTTP
 * endpoint and cannot be reached from the network. The account gets the normal starter credits
 * and the normal account_created / starter_grant events (the nullifier is a fake "dev:<label>").
 * Prints {account_id, token}.
 */
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { signerFromSeed } from "../src/events.ts";
import { loginOrCreate } from "../src/accounts.ts";
import { issueToken } from "../src/auth.ts";

const cfg = loadConfig();
if (!cfg.env.JWT_SECRET || !cfg.env.GATEWAY_SIGNING_KEY) throw new Error("JWT_SECRET and GATEWAY_SIGNING_KEY are required");
const db = openDb(cfg.env.DATABASE_PATH);
const label = process.argv[2] ?? "default";
const login = loginOrCreate(db, cfg, signerFromSeed(cfg.env.GATEWAY_SIGNING_KEY), `dev:${label}`);
const token = await issueToken(cfg.env.JWT_SECRET, login.accountId, cfg.net.session_ttl_s);
db.close();
console.log(JSON.stringify({ account_id: login.accountId, new_account: login.newAccount, token }));
