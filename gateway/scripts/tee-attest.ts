#!/usr/bin/env node
/**
 * Check the TEE judge's attestation live (no inference credits needed):
 *   node --env-file=.env scripts/tee-attest.ts [model]
 * Asks NEAR AI Cloud for an attestation report with a fresh random nonce and checks that the gateway
 * and the model attestation both echo it. Prints the model's TEE signing address (the key that
 * signs judge answers) and the sha256 of the report.
 */
import { randomBytes } from "node:crypto";
import { checkAttestation, DEFAULT_JUDGE_MODEL, nearAiClient } from "../src/tee-judge.ts";

const key = process.env.NEARAI_API_KEY;
if (!key) throw new Error("NEARAI_API_KEY is not set");
const model = process.argv[2] ?? process.env.TEE_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
const nonce = randomBytes(32).toString("hex");
const report = await nearAiClient(key).attestation(model, nonce);
const a = checkAttestation(report, nonce);
const m = (report as { model_attestations: { model_name?: string; nvidia_payload?: string }[] }).model_attestations.find((x) => x.model_name) ?? {};
console.log(JSON.stringify({ model, nonce, nonce_echoed: true, signing_address: a.signingAddress, attestation_sha256: a.sha256, model_name: m.model_name ?? null, has_nvidia_payload: !!m.nvidia_payload }, null, 2));
