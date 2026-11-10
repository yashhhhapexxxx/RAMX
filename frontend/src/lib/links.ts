import { env } from "../config/env";

/**
 * Explorer links (NEAR testnet, NearBlocks). In mock mode every id is synthetic, so we return
 * undefined: badges render without a link (and say "demo data") instead of pointing a real
 * explorer at an id that does not exist.
 */
const NEARBLOCKS = "https://testnet.nearblocks.io";
const live = () => env.dataMode === "live";

/** A NEAR transaction (base58 hash). */
export const explorerTx = (id: string | null | undefined) =>
  live() && id ? `${NEARBLOCKS}/txns/${encodeURIComponent(id)}` : undefined;
/** A NEAR contract account. */
export const explorerContract = (addr: string | null | undefined) =>
  live() && addr ? `${NEARBLOCKS}/address/${encodeURIComponent(addr)}` : undefined;
/** The ledger contract that holds every signed balance-change event. */
export const explorerLedger = (topic: string | null | undefined) =>
  live() && topic ? `${NEARBLOCKS}/address/${encodeURIComponent(topic)}` : undefined;
/** One ledger event: the contract page (events are NEP-297 logs of its transactions). */
export const explorerEvent = (topic: string | null | undefined, seq: number | null | undefined) =>
  live() && topic && seq != null ? `${NEARBLOCKS}/address/${encodeURIComponent(topic)}` : undefined;
