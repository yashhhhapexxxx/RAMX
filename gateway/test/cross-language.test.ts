import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyMessage } from "viem";
import { NodeHeartbeat } from "@ramx/shared";
import { registerMessage } from "../src/nodes.ts";

// Signed in Python by the node agent (node-agent/tests/make_vector.py, public test key).
const v = JSON.parse(readFileSync(new URL("../../node-agent/tests/fixtures/signature-vector.json", import.meta.url), "utf8"));

test("Python node_sig verifies with the gateway rule (EIP-191 over ramx-register:<node_id>:<pool_id>:<ts>)", async () => {
  assert.equal(registerMessage(v.node_id, v.register.pool_id, v.register.ts), v.register.message);
  assert.equal(await verifyMessage({ address: v.node_id, message: registerMessage(v.node_id, v.register.pool_id, v.register.ts), signature: v.register.node_sig }), true);
});

test("Python heartbeat: body parses as NodeHeartbeat; signature over the raw bytes verifies; a changed byte fails", async () => {
  const hb = NodeHeartbeat.parse(JSON.parse(v.heartbeat.body));
  assert.equal(hb.node_id, v.node_id);
  const raw = new TextEncoder().encode(v.heartbeat.body);
  assert.equal(await verifyMessage({ address: v.node_id, message: { raw }, signature: v.heartbeat.signature }), true);
  const changed = new TextEncoder().encode(v.heartbeat.body.replace("5.6", "5.7"));
  assert.equal(await verifyMessage({ address: v.node_id, message: { raw: changed }, signature: v.heartbeat.signature }), false);
});
