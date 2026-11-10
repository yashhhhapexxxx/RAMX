//! RAMX guarded agent wallet (escrow) for USDC on NEAR.
//!
//! An owner funds an agent with `ft_transfer_call(receiver = escrow, amount, msg = {"agent": "<id>"})`.
//! The agent account holds only a FUNCTION-CALL key limited to `escrow.pay`, so it cannot move
//! USDC itself; every payment goes through `pay`, which enforces the owner's policy on chain:
//!   - the agent is not paused (owner kill switch),
//!   - the payee is on the allow list,
//!   - amount <= per_call_max,
//!   - spent + amount <= budget, and amount <= the agent's funded balance.
//! A prompt-injected agent can therefore lose at most what the policy allows, only to allowed payees.
//!
//! The escrow attaches the 1 yoctoNEAR that `ft_transfer` needs from its own NEAR balance; if the
//! transfer fails the callback undoes the spend.

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
/// Allow lists stay short so `pay` stays cheap.
const MAX_ALLOW: usize = 20;

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Policy {
    /// Total USDC (base units) the agent may ever spend.
    pub budget: U128,
    pub per_call_max: U128,
    pub allow: Vec<AccountId>,
}

#[near(serializers = [borsh])]
pub struct Agent {
    owner: AccountId,
    balance: u128,
    budget: u128,
    spent: u128,
    per_call_max: u128,
    allow: Vec<AccountId>,
    paused: bool,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub owner: AccountId,
    pub balance: U128,
    pub budget: U128,
    pub spent: U128,
    pub per_call_max: U128,
    pub allow: Vec<AccountId>,
    pub paused: bool,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct FundMsg {
    agent: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    /// NEP-141 token held (Circle USDC on NEAR).
    token: AccountId,
    agents: LookupMap<AccountId, Agent>,
}

#[near]
impl Escrow {
    #[init]
    pub fn new(token: AccountId) -> Self {
        Self { token, agents: LookupMap::new(b"a") }
    }

    /// NEP-141 receiver: fund an agent. The first funder becomes the agent's owner; after that only
    /// the owner may add funds. A new agent starts with an empty policy (it can pay nothing).
    /// Any panic here makes the token contract refund the whole transfer.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "only the configured token can fund agents");
        let m: FundMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be {\"agent\":\"<account id>\"}"));
        require!(amount.0 > 0, "zero amount");
        require!(m.agent != sender_id, "an agent cannot be its own owner");
        match self.agents.get_mut(&m.agent) {
            Some(a) => {
                require!(a.owner == sender_id, "only the agent's owner can fund it");
                a.balance += amount.0;
            }
            None => {
                self.agents.insert(m.agent.clone(), Agent { owner: sender_id.clone(), balance: amount.0, budget: 0, spent: 0, per_call_max: 0, allow: vec![], paused: false });
            }
        }
        emit("funded", json!({ "agent": m.agent, "owner": sender_id, "amount": amount }));
        PromiseOrValue::Value(U128(0))
    }

    /// Owner only. Replaces the policy; `spent` is kept, so lowering the budget below it stops payments.
    pub fn set_policy(&mut self, agent: AccountId, policy: Policy) {
        require!(policy.allow.len() <= MAX_ALLOW, "allow list is too long");
        let a = self.owned(&agent);
        a.budget = policy.budget.0;
        a.per_call_max = policy.per_call_max.0;
        a.allow = policy.allow.clone();
        emit("policy_set", json!({ "agent": agent, "budget": policy.budget, "per_call_max": policy.per_call_max, "allow": policy.allow }));
    }

    /// Owner kill switch: the agent can pay nothing until `resume`.
    pub fn pause(&mut self, agent: AccountId) {
        self.owned(&agent).paused = true;
        emit("paused", json!({ "agent": agent }));
    }

    pub fn resume(&mut self, agent: AccountId) {
        self.owned(&agent).paused = false;
        emit("resumed", json!({ "agent": agent }));
    }

    /// Called by the agent itself (function-call key, no deposit). Panics with the reason when the
    /// policy refuses; on success sends `amount` USDC to `payee`.
    pub fn pay(&mut self, payee: AccountId, amount: U128, memo: String) -> Promise {
        let agent = env::predecessor_account_id();
        require!(memo.len() <= 128, "memo is too long");
        let a = self.agents.get_mut(&agent).unwrap_or_else(|| env::panic_str(&format!("{agent} is not a funded agent")));
        require!(!a.paused, "refused: agent is paused by its owner");
        if !a.allow.contains(&payee) {
            env::panic_str(&format!("refused: payee {payee} is not on the allow list"));
        }
        require!(amount.0 > 0, "refused: zero amount");
        if amount.0 > a.per_call_max {
            env::panic_str(&format!("refused: amount {} is above per_call_max {}", amount.0, a.per_call_max));
        }
        if a.spent + amount.0 > a.budget {
            env::panic_str(&format!("refused: budget exceeded (spent {} + {} > budget {})", a.spent, amount.0, a.budget));
        }
        if amount.0 > a.balance {
            env::panic_str(&format!("refused: amount {} is above the funded balance {}", amount.0, a.balance));
        }
        // Effects before the transfer; on_pay undoes them if the transfer fails.
        a.spent += amount.0;
        a.balance -= amount.0;
        ft_transfer(&self.token, &payee, amount.0, &memo).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_pay(agent, payee, amount, memo),
        )
    }

    #[private]
    pub fn on_pay(&mut self, agent: AccountId, payee: AccountId, amount: U128, memo: String, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            emit("paid", json!({ "agent": agent, "payee": payee, "amount": amount, "memo": memo }));
            return true;
        }
        let a = self.agents.get_mut(&agent).unwrap();
        a.spent -= amount.0;
        a.balance += amount.0;
        emit("pay_failed", json!({ "agent": agent, "payee": payee, "amount": amount }));
        false
    }

    /// Owner only: take back unspent funds (to the owner).
    pub fn withdraw(&mut self, agent: AccountId, amount: U128) -> Promise {
        let a = self.owned(&agent);
        require!(amount.0 > 0 && amount.0 <= a.balance, "amount must be from 1 to the agent's balance");
        a.balance -= amount.0;
        let owner = a.owner.clone();
        ft_transfer(&self.token, &owner, amount.0, "RAMX escrow withdraw").then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_withdraw(agent, amount),
        )
    }

    #[private]
    pub fn on_withdraw(&mut self, agent: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            emit("withdrawn", json!({ "agent": agent, "amount": amount }));
            return true;
        }
        self.agents.get_mut(&agent).unwrap().balance += amount.0;
        false
    }

    pub fn get_agent(&self, agent: AccountId) -> Option<AgentView> {
        self.agents.get(&agent).map(|a| AgentView {
            owner: a.owner.clone(),
            balance: U128(a.balance),
            budget: U128(a.budget),
            spent: U128(a.spent),
            per_call_max: U128(a.per_call_max),
            allow: a.allow.clone(),
            paused: a.paused,
        })
    }

    pub fn token(&self) -> AccountId {
        self.token.clone()
    }
}

impl Escrow {
    fn owned(&mut self, agent: &AccountId) -> &mut Agent {
        let caller = env::predecessor_account_id();
        let a = self.agents.get_mut(agent).unwrap_or_else(|| env::panic_str(&format!("{agent} is not a funded agent")));
        require!(a.owner == caller, "only the agent's owner can do this");
        a
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
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "ramx-escrow", "version": "1.0.0", "event": event, "data": [data] })));
}

#[cfg(test)]
mod tests;
