import type { Config } from "./config.ts";
import type { Hash } from "./merkle.ts";
import { assertSuccess, nearAccount, nearProvider, TGAS, txHashOf } from "./near.ts";
import type { EpochState, SettlementChain } from "./settlement.ts";

/** contracts-near/payout `get_epoch` view (u128 / u64 as JSON strings). */
type EpochView = { root: string; total: string; claimed: string; posted_at: string; opens_at: string; sweep_opens_at: string; swept: boolean };

/**
 * The settler (by default the x402 treasury, which receives the USDC) posts each epoch to the payout
 * contract with one `ft_transfer_call` on the USDC contract. Testnet only.
 */
export function nearSettlementChain(cfg: Config): SettlementChain {
  const e = cfg.env;
  if (cfg.net.x402_near.network !== "near:testnet") throw new Error("payouts run on NEAR testnet only");
  if (!e.PAYOUT_CONTRACT_ID || !e.SETTLER_ACCOUNT_ID || !e.SETTLER_KEY) throw new Error("payouts need PAYOUT_CONTRACT_ID, SETTLER_ACCOUNT_ID and SETTLER_KEY");
  const contract = e.PAYOUT_CONTRACT_ID;
  const token = cfg.net.x402_near.asset;
  const settler = nearAccount(e.SETTLER_ACCOUNT_ID, e.SETTLER_KEY, e.NEAR_RPC_URL);
  const provider = nearProvider(e.NEAR_RPC_URL);
  return {
    async verify() {
      const c = await provider.callFunction(contract, "config", {}) as { settler: string; token: string };
      if (c.settler !== e.SETTLER_ACCOUNT_ID) throw new Error(`payout contract settler is ${c.settler}, not SETTLER_ACCOUNT_ID ${e.SETTLER_ACCOUNT_ID}`);
      if (c.token !== token) throw new Error(`payout contract pays ${c.token}, but x402 is paid in ${token}`);
      if (e.X402_PAY_TO && e.X402_PAY_TO !== e.SETTLER_ACCOUNT_ID) throw new Error("X402_PAY_TO must be the settler: the epoch income is paid out from the account that received it");
    },
    async epoch(epoch) {
      const v = await provider.callFunction(contract, "get_epoch", { epoch }) as EpochView | null | undefined;
      if (!v) return null;
      return { root: `0x${v.root}` as Hash, total: BigInt(v.total), claimed: BigInt(v.claimed), opensAt: Number(v.opens_at) * 1000, swept: v.swept } satisfies EpochState;
    },
    async post(epoch, root, total) {
      // 1 yoctoNEAR is required by NEP-141; the gas covers the transfer, ft_on_transfer and ft_resolve_transfer.
      const outcome = await settler.callFunctionRaw({
        contractId: token, methodName: "ft_transfer_call", deposit: 1n, gas: 150n * TGAS,
        args: { receiver_id: contract, amount: total.toString(), msg: JSON.stringify({ epoch, root }), memo: `RAMX epoch ${epoch}` },
      });
      assertSuccess(outcome, `post epoch ${epoch}`);
      return { tx: txHashOf(outcome) };
    },
    async claimed(epoch, accounts) {
      if (accounts.length === 0) return [];
      return await provider.callFunction(contract, "claimed_of", { epoch, accounts }) as boolean[];
    },
  };
}
