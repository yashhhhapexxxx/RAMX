import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, SCHEMA_VERSION } from "../src/db.ts";

/** Dev phase: no manual "delete the database" step when the schema version changes. */
function oldDb(dir: string, version: number) {
  const path = join(dir, "gateway.sqlite");
  const d = new Database(path);
  d.pragma("journal_mode = WAL");
  d.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('acc_old');");
  d.pragma(`user_version = ${version}`);
  d.close();
  return path;
}

test("schema mismatch: the old file is moved aside with its data, a fresh latest-schema database starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ramx-db-"));
  const path = oldDb(dir, SCHEMA_VERSION - 1);
  const db = openDb(path);
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.equal((db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n, 0, "fresh");
  db.close();
  const mains = (d: string) => readdirSync(d).filter((f) => /^gateway\.sqlite-bak-v\d+-\d+$/.test(f));
  const backups = mains(dir);
  assert.equal(backups.length, 1);
  assert.match(backups[0]!, new RegExp(`^gateway\\.sqlite-bak-v${SCHEMA_VERSION - 1}-\\d+$`));
  const old = new Database(join(dir, backups[0]!), { readonly: true });
  assert.equal((old.prepare("SELECT id FROM accounts").get() as { id: string }).id, "acc_old", "nothing deleted");
  old.close();
  // Opening the same current-version file again changes nothing.
  openDb(path).close();
  assert.equal(mains(dir).length, 1);
});

test("DB_RESET_ON_MISMATCH=false refuses to start and leaves the file alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ramx-db-"));
  const path = oldDb(dir, SCHEMA_VERSION + 1);
  assert.throws(() => openDb(path, { resetOnMismatch: false }), /schema v\d+, need v\d+/);
  assert.equal(readdirSync(dir).filter((f) => f.includes("-bak-v")).length, 0);
  assert.equal(new Database(path, { readonly: true }).pragma("user_version", { simple: true }), SCHEMA_VERSION + 1);
});
