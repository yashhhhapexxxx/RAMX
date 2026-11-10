//! RAMX epoch payouts in USDC on NEAR.
//!
//! Each epoch the gateway's settler sends the epoch total of USDC to this contract with
//! `ft_transfer_call(receiver = payout, amount = total, msg = {"epoch": N, "root": "<hex>"})`:
//! one transaction both funds and posts the epoch. After `claim_delay`, each provider claims its
//! own leaf with a Merkle proof and receives `ft_transfer` of the amount. After `sweep_delay` the
//! settler can take back what was never claimed.
//!
//! Merkle rules (must match `gateway/src/merkle.ts`):
//!   leaf = sha256(account_id bytes ‖ 0x00 ‖ amount as u128 big-endian, 16 bytes)
//!   pair = sha256(smaller ‖ larger)   (sorted pairs; an odd node is promoted unchanged)
//! Trust: the contract trusts the settler for the root; anyone can compare it with the signed
//! `epoch_closed` event on the ledger contract, which carries the full payout list.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
pub struct Epoch {
    root: [u8; 32],
    total: u128,
    claimed: u128,
    posted_at_ns: u64,
    swept: bool,
}

#[near(serializers = [json])]
pub struct EpochView {
    pub root: String,
    pub total: U128,
    pub claimed: U128,
    /// Unix seconds.
    pub posted_at: U64,
    /// Unix seconds from which claims are accepted.
    pub opens_at: U64,
    /// Unix seconds from which the settler may sweep what is left.
    pub sweep_opens_at: U64,
    pub swept: bool,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct PostMsg {
    epoch: u64,
    root: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Payout {
    settler: AccountId,
    /// NEP-141 token paid out (Circle USDC on NEAR).
    token: AccountId,
    claim_delay_s: u64,
    sweep_delay_s: u64,
    epochs: LookupMap<u64, Epoch>,
    claimed: LookupSet<(u64, AccountId)>,
}

#[near]
impl Payout {
    #[init]
    pub fn new(settler: AccountId, token: AccountId, claim_delay_s: u64, sweep_delay_s: u64) -> Self {
        require!(sweep_delay_s >= claim_delay_s, "sweep delay must be at least the claim delay");
        Self { settler, token, claim_delay_s, sweep_delay_s, epochs: LookupMap::new(b"e"), claimed: LookupSet::new(b"c") }
    }

    /// NEP-141 receiver: posts an epoch funded with exactly the transferred amount. Any panic
    /// here makes the token contract refund the whole transfer to the settler.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "only the configured token can fund epochs");
        require!(sender_id == self.settler, "only the settler can post epochs");
        let m: PostMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be {\"epoch\":N,\"root\":\"<hex>\"}"));
        let root = parse_hash(&m.root);
        require!(root != [0u8; 32], "zero root");
        require!(amount.0 > 0, "zero total");
        if self.epochs.contains_key(&m.epoch) {
            env::panic_str(&format!("epoch {} already posted", m.epoch));
        }
        self.epochs.insert(m.epoch, Epoch { root, total: amount.0, claimed: 0, posted_at_ns: env::block_timestamp(), swept: false });
        emit("epoch_posted", json!({ "epoch": m.epoch, "root": m.root, "total": amount }));
        PromiseOrValue::Value(U128(0)) // keep all of it
    }

    /// Claim the caller's payout for an epoch; the USDC goes to the caller. The caller must be
    /// registered on the token contract (storage_deposit), else the transfer fails and the claim is undone.
    pub fn claim(&mut self, epoch: u64, amount: U128, proof: Vec<String>) -> Promise {
        let account = env::predecessor_account_id();
        let e = self.epochs.get(&epoch).unwrap_or_else(|| env::panic_str(&format!("epoch {epoch} not posted")));
        require!(!e.swept, "epoch was swept");
        let opens_at = e.posted_at_ns / 1_000_000_000 + self.claim_delay_s;
        if env::block_timestamp() / 1_000_000_000 < opens_at {
            env::panic_str(&format!("claims open at {opens_at}"));
        }
        require!(!self.claimed.contains(&(epoch, account.clone())), "already claimed");
        let proof: Vec<[u8; 32]> = proof.iter().map(|p| parse_hash(p)).collect();
        require!(verify(&proof, e.root, leaf(&account, amount.0)), "invalid proof");
        require!(e.claimed + amount.0 <= e.total, "claim exceeds the epoch total");
        // Effects before the transfer; the callback undoes them if the transfer fails.
        self.claimed.insert((epoch, account.clone()));
        self.epochs.get_mut(&epoch).unwrap().claimed += amount.0;
        ft_transfer(&self.token, &account, amount.0, &format!("RAMX epoch {epoch} payout")).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_claim(epoch, account, amount),
        )
    }

    #[private]
    pub fn on_claim(&mut self, epoch: u64, account: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            emit("claimed", json!({ "epoch": epoch, "account": account, "amount": amount }));
            return true;
        }
        self.claimed.remove(&(epoch, account.clone()));
        self.epochs.get_mut(&epoch).unwrap().claimed -= amount.0;
        emit("claim_failed", json!({ "epoch": epoch, "account": account, "amount": amount }));
        false
    }

    /// Return what was not claimed to the settler, after the sweep delay. No claims afterwards.
    pub fn sweep(&mut self, epoch: u64) -> Promise {
        require!(env::predecessor_account_id() == self.settler, "only the settler can sweep");
        let delay = self.sweep_delay_s;
        let e = self.epochs.get_mut(&epoch).unwrap_or_else(|| env::panic_str(&format!("epoch {epoch} not posted")));
        require!(!e.swept, "already swept");
        let opens_at = e.posted_at_ns / 1_000_000_000 + delay;
        if env::block_timestamp() / 1_000_000_000 < opens_at {
            env::panic_str(&format!("sweep opens at {opens_at}"));
        }
        let rest = e.total - e.claimed;
        require!(rest > 0, "nothing to sweep");
        e.swept = true;
        e.claimed = e.total;
        let settler = self.settler.clone();
        ft_transfer(&self.token, &settler, rest, &format!("RAMX epoch {epoch} sweep")).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_sweep(epoch, U128(rest)),
        )
    }

    #[private]
    pub fn on_sweep(&mut self, epoch: u64, rest: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            emit("swept", json!({ "epoch": epoch, "amount": rest }));
            return true;
        }
        let e = self.epochs.get_mut(&epoch).unwrap();
        e.swept = false;
        e.claimed -= rest.0;
        false
    }

    pub fn get_epoch(&self, epoch: u64) -> Option<EpochView> {
        self.epochs.get(&epoch).map(|e| {
            let posted = e.posted_at_ns / 1_000_000_000;
            EpochView {
                root: hex::encode(e.root),
                total: U128(e.total),
                claimed: U128(e.claimed),
                posted_at: U64(posted),
                opens_at: U64(posted + self.claim_delay_s),
                sweep_opens_at: U64(posted + self.sweep_delay_s),
                swept: e.swept,
            }
        })
    }

    pub fn has_claimed(&self, epoch: u64, account: AccountId) -> bool {
        self.claimed.contains(&(epoch, account))
    }

    /// Which of `accounts` have claimed `epoch` (one view call for the gateway's claim index).
    pub fn claimed_of(&self, epoch: u64, accounts: Vec<AccountId>) -> Vec<bool> {
        accounts.into_iter().map(|a| self.claimed.contains(&(epoch, a))).collect()
    }

    pub fn config(&self) -> serde_json::Value {
        json!({ "settler": self.settler, "token": self.token, "claim_delay_s": self.claim_delay_s, "sweep_delay_s": self.sweep_delay_s })
    }
}

/// `ft_transfer` with the 1 yoctoNEAR the NEP-141 standard requires.
fn ft_transfer(token: &AccountId, to: &AccountId, amount: u128, memo: &str) -> Promise {
    Promise::new(token.clone()).function_call(
        "ft_transfer".to_string(),
        json!({ "receiver_id": to, "amount": U128(amount), "memo": memo }).to_string().into_bytes(),
        NearToken::from_yoctonear(1),
        GAS_FT_TRANSFER,
    )
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "ramx-payout", "version": "1.0.0", "event": event, "data": [data] })));
}

fn parse_hash(s: &str) -> [u8; 32] {
    let raw = hex::decode(s.strip_prefix("0x").unwrap_or(s)).unwrap_or_else(|_| env::panic_str("hash must be hex"));
    raw.try_into().unwrap_or_else(|_| env::panic_str("hash must be 32 bytes"))
}

/// leaf = sha256(account_id ‖ 0x00 ‖ amount u128 big-endian).
pub fn leaf(account: &AccountId, amount: u128) -> [u8; 32] {
    let mut data = account.as_bytes().to_vec();
    data.push(0);
    data.extend_from_slice(&amount.to_be_bytes());
    env::sha256_array(&data)
}

pub fn pair(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut data = lo.to_vec();
    data.extend_from_slice(&hi);
    env::sha256_array(&data)
}

pub fn verify(proof: &[[u8; 32]], root: [u8; 32], leaf: [u8; 32]) -> bool {
    proof.iter().fold(leaf, |h, p| pair(h, *p)) == root
}

#[cfg(test)]
mod tests;
