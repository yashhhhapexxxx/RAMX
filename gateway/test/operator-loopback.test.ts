import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { signer, testDirectory } from "./helpers.ts";

// A tunnel (cloudflared) or reverse proxy on this host also connects from loopback.
test("operator-only routes: loopback without proxy headers only; tunnelled requests are refused", async () => {
  const cfg = loadConfig({ DATABASE_PATH: ":memory:", POOL_COORDINATOR_URL: "http://127.0.0.1:3001" });
  const db = openDb(":memory:");
  const app = createApp({ cfg, db, signer, directory: testDirectory(cfg, db) });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ["/pools/plan", "/incentives/flags"]) {
      assert.equal((await fetch(base + path)).status, 200, `${path} from loopback`);
      for (const h of ["cf-connecting-ip", "cf-ray", "x-forwarded-for"]) {
        assert.equal((await fetch(base + path, { headers: { [h]: "203.0.113.7" } })).status, 403, `${path} via proxy header ${h}`);
      }
    }
  } finally {
    server.close();
    db.close();
  }
});
