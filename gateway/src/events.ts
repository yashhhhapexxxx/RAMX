import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { canonicalJson, LedgerEvent } from "@ramx/shared";
import type { Db } from "./db.ts";

/**
 * Signed ledger events (shared/README.md "Signatures"): `sig` = ed25519 over the canonical JSON
 * of the event without `sig`. GATEWAY_SIGNING_KEY is the raw 32-byte ed25519 seed (64 hex chars).
 * The events are inserted into `ledger_events` (inside the caller's SQLite transaction); the ledger
 * writer (ledger-chain.ts) appends them to the NEAR ledger contract later. Nothing here touches the network.
 */

// PKCS8 / SPKI DER prefixes for a raw ed25519 key (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type Signer = { privateKey: KeyObject; publicKeyHex: string };

export function signerFromSeed(seedHex: string): Signer {
  const hex = seedHex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("GATEWAY_SIGNING_KEY must be a 32-byte ed25519 seed (64 hex chars)");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(hex, "hex")]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { privateKey, publicKeyHex: `0x${spki.subarray(SPKI_PREFIX.length).toString("hex")}` };
}

/** Distributive Omit over the event union: one unsigned event of any type. */
type DistOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type UnsignedEvent = DistOmit<LedgerEvent, "sig" | "v" | "ts"> & { ts?: number };

export function signEvent(signer: Signer, ev: UnsignedEvent, now = Date.now()): LedgerEvent {
  const body = { v: 1, ts: now, ...ev } as Record<string, unknown>;
  const sig = edSign(null, Buffer.from(canonicalJson(body), "utf8"), signer.privateKey);
  return LedgerEvent.parse({ ...body, sig: `0x${sig.toString("hex")}` });
}

/**
 * Anyone can check a message from the ledger topic: pass the message JSON and the gateway public key
 * (32-byte hex, printed by `node src/verify-event.ts --pubkey`).
 */
export function verifyEvent(event: Record<string, unknown>, publicKeyHex: string): boolean {
  const { sig, ...rest } = event;
  if (typeof sig !== "string" || !/^0x[0-9a-f]+$/.test(sig)) return false;
  const pub = Buffer.from(publicKeyHex.replace(/^0x/, ""), "hex");
  if (pub.length !== 32) throw new Error("public key must be 32 bytes");
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(canonicalJson(rest), "utf8"), key, Buffer.from(sig.slice(2), "hex"));
}

/** Sign and insert one event. Call it inside the same transaction as the balance change it records. */
export function recordEvent(db: Db, signer: Signer, ev: UnsignedEvent, now = Date.now()): LedgerEvent {
  const signed = signEvent(signer, ev, now);
  const json = canonicalJson(signed);
  if (Buffer.byteLength(json) > 4096) console.warn(`ledger event ${signed.type} is ${Buffer.byteLength(json)} bytes (the ledger contract accepts at most 4096)`);
  db.prepare("INSERT INTO ledger_events (type, payload, gateway_sig, ledger_seq, ts) VALUES (?, ?, ?, NULL, ?)").run(signed.type, json, signed.sig, signed.ts);
  return signed;
}
