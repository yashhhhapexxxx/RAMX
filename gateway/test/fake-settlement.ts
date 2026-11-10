import type { Hash } from "../src/merkle.ts";
import type { EpochState, SettlementChain } from "../src/settlement.ts";
import { fakeTxHash } from "./helpers.ts";

/**
 * In-memory contracts-near/payout with the same rules: one post per epoch (a second one is refused
 * with "already posted" and refunded by the token), claims open after the delay, swept epochs close.
 */
export class FakeChain implements SettlementChain {
  states = new Map<number, EpochState>();
  claims = new Map<number, Set<string>>();
  /** ms: when posts happen (claims open 60 s later, like the deployed claim delay). */
  postedAtMs = 1_200_000;
  posts = 0;
  /** Funding transfers that actually moved USDC (a refused post is refunded, so it does not count). */
  funded = 0n;
  /** Make the next post land on the contract but lose the response (crash / RPC timeout). */
  loseNextResponse = false;
  verify = async () => {};
  epoch = async (e: number) => this.states.get(e) ?? null;
  post = async (epoch: number, root: Hash, total: bigint) => {
    if (this.states.has(epoch)) throw new Error(`post epoch ${epoch} failed in a receipt: {"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: epoch ${epoch} already posted"}}}}`);
    this.posts++;
    this.funded += total;
    this.states.set(epoch, { root, total, claimed: 0n, opensAt: this.postedAtMs + 60_000, swept: false });
    if (this.loseNextResponse) { this.loseNextResponse = false; throw new Error("fetch failed: socket hang up"); }
    return { tx: fakeTxHash(1000 + this.posts) };
  };
  claimed = async (epoch: number, accounts: string[]) => accounts.map((a) => this.claims.get(epoch)?.has(a) ?? false);
  claim(epoch: number, account: string, amount: bigint) {
    const s = this.states.get(epoch)!;
    s.claimed += amount;
    if (!this.claims.has(epoch)) this.claims.set(epoch, new Set());
    this.claims.get(epoch)!.add(account);
  }
  sweep(epoch: number) {
    const s = this.states.get(epoch)!;
    s.claimed = s.total;
    s.swept = true;
  }
}
