#!/usr/bin/env node
/**
 * API keys from the backend, without the website. Works on the SQLite file directly (DATABASE_PATH),
 * so it is not an HTTP endpoint and cannot be reached from the network. Same rules as /keys:
 * a key spends its own USDC-bought credits first, then the account's credits within its cap.
 * Credits for a key come only from testnet USDC top-ups (agent-client `pnpm topup`), never from here.
 *
 *   pnpm api-key create --dev alice [--name opencode] [--cap 500]   # DEV: account without World + key
 *   pnpm api-key create --account acc_… [--name opencode] [--cap 500]
 *   pnpm api-key list --account acc_…
 *   pnpm api-key credits <gpa_token | agt_id>
 *   pnpm api-key requests <agt_id>
 *   pnpm api-key revoke <agt_id>
 *
 * `create` prints the token once (it is stored hashed). --cap is in credits; no --cap = no cap.
 * Output is JSON (one object), so scripts can read it.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { signerFromSeed } from "../src/events.ts";
import { loginOrCreate } from "../src/accounts.ts";
import { agentFromToken, agentRequests, createAgentKey, keyCredits, listAgentKeys, revokeAgentKey } from "../src/incentives.ts";

const USAGE = "usage: api-key create (--dev <label> | --account <acc_id>) [--name <name>] [--cap <credits>] | list --account <acc_id> | credits <gpa_token|agt_id> | requests <agt_id> | revoke <agt_id>";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { dev: { type: "string" }, account: { type: "string" }, name: { type: "string", default: "opencode" }, cap: { type: "string" } },
});
const [command, arg] = positionals;

const cfg = loadConfig();
if (!cfg.env.GATEWAY_SIGNING_KEY) fail("GATEWAY_SIGNING_KEY is required (ledger events are signed)");
const signer = signerFromSeed(cfg.env.GATEWAY_SIGNING_KEY);
const db = openDb(cfg.env.DATABASE_PATH);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const accountExists = (d: Db, id: string) => !!d.prepare("SELECT 1 FROM accounts WHERE id = ?").get(id);
/** agt_id → the key row's account, or exit. */
function keyAccount(agentId: string): string {
  const r = db.prepare("SELECT account_id FROM agent_keys WHERE id = ?").get(agentId) as { account_id: string } | undefined;
  return r?.account_id ?? fail(`no API key ${agentId}`);
}

try {
  switch (command) {
    case "create": {
      if (!!values.dev === !!values.account) fail("create needs exactly one of --dev <label> or --account <acc_id>");
      let accountId = values.account;
      let newAccount = false;
      if (values.dev) {
        // DEV ONLY, like scripts/dev-session.ts: fake nullifier "dev:<label>", normal starter credits and events.
        const login = loginOrCreate(db, cfg, signer, `dev:${values.dev}`);
        accountId = login.accountId;
        newAccount = login.newAccount;
      } else if (!accountExists(db, accountId!)) fail(`no account ${accountId}`);
      const name = values.name!;
      if (name.length < 1 || name.length > 64) fail("--name must be 1–64 characters");
      let capMc: number | null = null;
      if (values.cap !== undefined) {
        const cap = Number(values.cap);
        if (!Number.isFinite(cap) || cap < 0) fail("--cap must be a number of credits ≥ 0");
        capMc = Math.round(cap * 1000);
      }
      const key = createAgentKey(db, signer, accountId!, name, capMc);
      out({ account_id: accountId, new_account: newAccount, ...key, note: "the token is shown only now; export RAMX_API_KEY=<token>" });
      break;
    }
    case "list": {
      if (!values.account) fail("list needs --account <acc_id>");
      if (!accountExists(db, values.account)) fail(`no account ${values.account}`);
      out({ account_id: values.account, agents: listAgentKeys(db, values.account) });
      break;
    }
    case "credits": {
      if (!arg) fail(USAGE);
      let agentId = arg;
      if (arg.startsWith("gpa_")) agentId = agentFromToken(db, arg)?.agentId ?? fail("invalid or revoked API key");
      else keyAccount(arg);
      out(keyCredits(db, cfg.net, agentId));
      break;
    }
    case "requests": {
      if (!arg) fail(USAGE);
      out({ agent_id: arg, requests: agentRequests(db, keyAccount(arg), arg) });
      break;
    }
    case "revoke": {
      if (!arg) fail(USAGE);
      out({ agent_id: arg, revoked: revokeAgentKey(db, keyAccount(arg), arg) });
      break;
    }
    default:
      fail(USAGE);
  }
} finally {
  db.close();
}
