/**
 * Rebuild an epoch's Merkle root from its Swarm bundle alone (SPEC §16.4). No gateway needed.
 *   node scripts/verify-bundle.ts <swarm-reference> [expected-merkle-root]
 * Env: BEE_API_URL (a Bee node or gateway that can serve the reference).
 */
import { checkBundle, fetchBundle } from "../src/swarm.ts";

const [ref, expected] = process.argv.slice(2);
if (!ref || !process.env.BEE_API_URL) { console.error("usage: BEE_API_URL=<bee> node scripts/verify-bundle.ts <reference> [expected-root]"); process.exit(2); }
const check = checkBundle(await fetchBundle(process.env.BEE_API_URL, ref), expected);
console.log(JSON.stringify(check, null, 2));
process.exit(check.ok ? 0 : 1);
