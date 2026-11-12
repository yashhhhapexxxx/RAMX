import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { z } from "zod";
import * as S from "../src/index.ts";

const dir = new URL("../examples/", import.meta.url);
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

/** Every example file and the schema it must satisfy. */
const EXAMPLES: Record<string, z.ZodType> = {
  "error-response.json": S.ErrorResponse,
  "chat-completion-request.json": S.ChatCompletionRequest,
  "chat-completion-response.json": S.ChatCompletionResponse,
  "chat-completion-request-tools.json": S.ChatCompletionRequest,
  "chat-completion-response-tools.json": S.ChatCompletionResponse,
  "models-response.json": S.ModelsResponse,
  "world-verify-response.json": S.WorldVerifyResponse,
  "rp-signature-response.json": S.RpSignatureResponse,
  "session-claims.json": S.SessionClaims,
  "me-response.json": S.MeResponse,
  "node-register-request.json": S.NodeRegisterRequest,
  "node-register-response.json": S.NodeRegisterResponse,
  "node-heartbeat.json": S.NodeHeartbeat,
  "ok-response.json": S.OkResponse,
  "heartbeat-response.json": S.HeartbeatResponse,
  "pool-state-response.json": S.PoolStateResponse,
  "pool-plan-response.json": S.PoolPlanResponse,
  "receipt.json": S.Receipt,
  "network-response.json": S.NetworkResponse,
  "ledger-events-response.json": S.LedgerEventsResponse,
  "payouts-response.json": S.PayoutsResponse,
  "directory-node.json": S.DirectoryNode,
  "directory-pool.json": S.DirectoryPool,
  "directory-model.json": S.DirectoryModel,
  "directory-account-stats.json": S.AccountStats,
  "merkle-leaf.json": S.MerkleLeaf,
  "payout-proof.json": S.PayoutProof,
  "payout-route.json": S.PayoutRoute,
  "ledger-account-created.json": S.AccountCreatedEvent,
  "ledger-starter-grant.json": S.StarterGrantEvent,
  "ledger-request-settled.json": S.RequestSettledEvent,
  "ledger-x402-payment.json": S.X402PaymentEvent,
  "ledger-tee-check.json": S.TeeCheckEvent,
  "ledger-tee-answer-signed.json": S.TeeAnswerSignedEvent,
  "ledger-swarm-cleared.json": S.SwarmClearedEvent,
  "ledger-credits-expired.json": S.CreditsExpiredEvent,
  "ledger-payout-address-set.json": S.PayoutAddressSetEvent,
  "ledger-epoch-closed.json": S.EpochClosedEvent,
  "ledger-payout-claimed.json": S.PayoutClaimedEvent,
  "ledger-verification-result.json": S.VerificationResultEvent,
  "ledger-verification-appeal.json": S.VerificationAppealEvent,
  "ledger-verification-final.json": S.VerificationFinalEvent,
  "ledger-hardware-challenge.json": S.HardwareChallengeEvent,
  "ledger-verification-canary.json": S.VerificationCanaryEvent,
  "ledger-credits-clawed-back.json": S.CreditsClawedBackEvent,
  "ledger-account-banned.json": S.AccountBannedEvent,
  "ledger-availability-reward.json": S.AvailabilityRewardEvent,
  "ledger-agent-key-created.json": S.AgentKeyCreatedEvent,
  "agent-key-create-response.json": S.AgentKeyCreateResponse,
  "agent-key-list-response.json": S.AgentKeyListResponse,
  "agent-requests-response.json": S.AgentRequestsResponse,
  "ledger-credits-purchased.json": S.CreditsPurchasedEvent,
  "key-credits-response.json": S.KeyCreditsResponse,
  "credit-topup-request.json": S.CreditTopupRequest,
  "credit-topup-response.json": S.CreditTopupResponse,
  "collusion-flags-response.json": S.CollusionFlagsResponse,
};

test("every example file has a schema, and every schema entry has a file", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, Object.keys(EXAMPLES).sort());
});

for (const [file, schema] of Object.entries(EXAMPLES)) {
  test(`example ${file} matches its schema`, () => {
    const r = schema.safeParse(load(file));
    assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2));
  });
}

test("ledger event examples parse as LedgerEvent and stay under 1 KB", () => {
  const seen = new Set<string>();
  for (const file of Object.keys(EXAMPLES).filter((f) => f.startsWith("ledger-") && f !== "ledger-events-response.json")) {
    const raw = readFileSync(new URL(file, dir), "utf8");
    const ev = S.LedgerEvent.parse(JSON.parse(raw));
    seen.add(ev.type);
    assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(raw))) < 1024, `${file} >= 1 KB`);
  }
  assert.deepEqual([...seen].sort(), [...S.LEDGER_EVENT_TYPES].sort());
});

test("ledger event types are exactly the known list", () => {
  assert.deepEqual([...S.LEDGER_EVENT_TYPES].sort(), [
    "account_banned",
    "account_created",
    "agent_key_created",
    "availability_reward",
    "credits_clawed_back",
    "credits_purchased",
    "credits_expired",
    "epoch_closed",
    "payout_address_set",
    "payout_claimed",
    "request_settled",
    "starter_grant",
    "swarm_cleared",
    "tee_answer_signed",
    "tee_check",
    "hardware_challenge",
    "verification_appeal",
    "verification_canary",
    "verification_final",
    "verification_result",
    "x402_payment",
  ].sort());
});

test("top-up amounts: whole USDC base units only; key credits fields are required on keys", () => {
  assert.ok(S.CreditTopupRequest.safeParse({ usdc: 2.5 }).success);
  assert.ok(S.CreditTopupRequest.safeParse({ usdc: 0.0000001 }).success === false, "below 1 USDC base unit");
  assert.ok(!S.CreditTopupRequest.safeParse({ usdc: 0 }).success);
  assert.ok(!S.CreditTopupRequest.safeParse({ usdc: "5" }).success);
  assert.ok(!S.AgentKey.safeParse({ agent_id: "agt_a", name: "a", budget_mc: null, spent_mc: 0, revoked: false, created_at: 1, last_used_at: null }).success);
});

test("config file matches RamxConfig", () => {
  const raw = JSON.parse(readFileSync(new URL("../config/ramx.config.json", import.meta.url), "utf8"));
  const cfg = S.RamxConfig.parse(raw);
  for (const m of cfg.models) {
    const tiers = m.x402_prices.map((t) => t.max_tokens);
    assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b), `${m.model_id} tiers not ascending`);
  }
});

test("request_settled example: split parts sum exactly to cost", () => {
  const ev = S.RequestSettledEvent.parse(load("ledger-request-settled.json"));
  const nodes = Object.values(ev.split.nodes).reduce((a, b) => a + b, 0);
  assert.equal(nodes + ev.split.burn_mc + ev.split.reserve_mc, ev.cost_mc);
});

test("epoch_closed example: payouts sum to total", () => {
  const ev = S.EpochClosedEvent.parse(load("ledger-epoch-closed.json"));
  const sum = (ev.payouts ?? []).reduce((a, p) => a + BigInt(p.amount_units), 0n);
  assert.equal(sum, BigInt(ev.total_units));
});

test("failure path: bad inputs are rejected", () => {
  assert.equal(S.LayerRange.safeParse([29, 29]).success, false);
  assert.equal(S.Millicredits.safeParse(1.5).success, false);
  assert.equal(S.TokenUnits.safeParse("0.01").success, false);
  assert.equal(S.LedgerEvent.safeParse({ ...(load("ledger-account-created.json") as object), type: "minted" }).success, false);
  // logprobs is stripped, never forwarded to Parallax
  const req = S.ChatCompletionRequest.parse({ ...(load("chat-completion-request.json") as object), logprobs: true });
  assert.equal("logprobs" in req, false);
  // only text parts; an image part is rejected
  const img = { model: "Qwen/Qwen3-14B-FP8", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] };
  assert.equal(S.ChatCompletionRequest.safeParse(img).success, false);
  // a tool message needs its tool_call_id
  assert.equal(S.ChatMessage.safeParse({ role: "tool", content: "x" }).success, false);
});

test("OpenCode-shaped request keeps tools, tool calls and tool results", () => {
  const req = S.ChatCompletionRequest.parse(load("chat-completion-request-tools.json"));
  assert.equal(req.tools?.[0]?.function.name, "read");
  assert.equal(req.tool_choice, "auto");
  const [, user, asst, tool] = req.messages;
  assert.equal(S.contentText(user!.content), "What does src/main.ts do?");
  assert.ok(asst!.role === "assistant" && asst!.tool_calls?.[0]?.id === "call_0" && S.contentText(asst!.content) === "");
  assert.ok(tool!.role === "tool" && tool!.tool_call_id === "call_0");
});

test("canonical JSON: sorted keys, no whitespace, same bytes as Python json.dumps(sort_keys, separators, ensure_ascii=False)", () => {
  const obj = { z: 1, a: { y: [3, { b: "é→✓", a: null }], x: 5.6 }, m: "q\"uote", n: true, k: -0.25, big: 1793912345123 };
  const ts = S.canonicalJson(obj);
  assert.equal(ts, '{"a":{"x":5.6,"y":[3,{"a":null,"b":"é→✓"}]},"big":1793912345123,"k":-0.25,"m":"q\\"uote","n":true,"z":1}');
  const py = execFileSync("python3", ["-c", "import json,sys; sys.stdout.write(json.dumps(json.loads(sys.stdin.read()), sort_keys=True, separators=(',', ':'), ensure_ascii=False))"], { input: JSON.stringify(obj) }).toString("utf8");
  assert.equal(ts, py);
});

test("config models have num_layers (Qwen3-14B = 40, Qwen3-8B = 36)", () => {
  const cfg = S.RamxConfig.parse(JSON.parse(readFileSync(new URL("../config/ramx.config.json", import.meta.url), "utf8")));
  assert.equal(cfg.models.find((m) => m.model_id === "Qwen/Qwen3-14B-FP8")?.num_layers, 40);
  assert.equal(cfg.models.find((m) => m.model_id === "Qwen/Qwen3-8B-FP8")?.num_layers, 36);
});
