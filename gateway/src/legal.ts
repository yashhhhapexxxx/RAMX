import type { Config } from "./config.ts";

/**
 * SPEC §16.4 legal check for real-money payouts. This is a process gate, not legal advice
 * (docs/LEGAL_CHECK.md has the checklist and the questions for counsel).
 *
 * The gateway moves only NEAR TESTNET value (CLAUDE.md §5.7). Any other network or chain ID is
 * refused at startup with a pointer to the checklist, so mainnet cannot be switched on by a typo in
 * an env file. `LEGAL_CLEARANCE_REF` (a counsel opinion reference) is logged when present; it does not
 * unlock mainnet by itself, because a mainnet build needs a code change that must be reviewed after
 * the clearance exists.
 */
export function legalGate(cfg: Config): void {
  const e = cfg.env;
  const network = cfg.net.x402_near.network;
  if (network !== "near:testnet") {
    throw new Error(`x402 network ${network}: real-money payouts are blocked until the legal check in docs/LEGAL_CHECK.md is complete (testnet only)`);
  }
  for (const url of [e.NEAR_RPC_URL].filter(Boolean) as string[]) {
    if (/mainnet/i.test(url)) throw new Error(`NEAR_RPC_URL ${url} looks like mainnet: testnet only (docs/LEGAL_CHECK.md)`);
  }
  if (e.LEGAL_CLEARANCE_REF) console.warn(`LEGAL_CLEARANCE_REF=${e.LEGAL_CLEARANCE_REF} noted; the gateway still runs on testnet only (docs/LEGAL_CHECK.md)`);
}
