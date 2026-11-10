use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const TOKEN: &str = "usdc.fakes.testnet";
const OWNER: &str = "ramx.testnet";
const AGENT: &str = "agent-2.ramx.testnet";
const TREASURY: &str = "treasury.ramx.testnet";

fn as_(predecessor: &str) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("escrow.ramx.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .build());
}

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn panics<F: FnOnce()>(f: F) -> String {
    let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a refusal");
    e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
}

/// Agent funded with 5 USDC; policy: budget 3 USDC, 1 USDC per call, treasury only.
fn funded() -> Escrow {
    as_(OWNER);
    let mut c = Escrow::new(id(TOKEN));
    as_(TOKEN);
    let _ = c.ft_on_transfer(id(OWNER), U128(5_000_000), json!({ "agent": AGENT }).to_string());
    as_(OWNER);
    c.set_policy(id(AGENT), Policy { budget: U128(3_000_000), per_call_max: U128(1_000_000), allow: vec![id(TREASURY)] });
    c
}

#[test]
fn funding_makes_the_first_funder_the_owner_with_an_empty_policy() {
    as_(OWNER);
    let mut c = Escrow::new(id(TOKEN));
    as_(TOKEN);
    let _ = c.ft_on_transfer(id(OWNER), U128(2_000_000), json!({ "agent": AGENT }).to_string());
    let a = c.get_agent(id(AGENT)).unwrap();
    assert_eq!((a.owner, a.balance.0, a.budget.0, a.allow.len()), (id(OWNER), 2_000_000, 0, 0));
    assert!(get_logs()[0].contains("\"event\":\"funded\""));
    as_(AGENT);
    assert!(panics(|| { let _ = c.pay(id(TREASURY), U128(1), String::new()); }).contains("not on the allow list"));
}

#[test]
fn only_the_token_and_the_owner_can_fund() {
    let mut c = funded();
    as_("fake-token.testnet");
    assert!(panics(|| { let _ = c.ft_on_transfer(id(OWNER), U128(1), json!({ "agent": AGENT }).to_string()); }).contains("only the configured token"));
    as_(TOKEN);
    assert!(panics(|| { let _ = c.ft_on_transfer(id("mallory.testnet"), U128(1), json!({ "agent": AGENT }).to_string()); }).contains("only the agent's owner"));
    assert!(panics(|| { let _ = c.ft_on_transfer(id(AGENT), U128(1), json!({ "agent": AGENT }).to_string()); }).contains("its own owner"));
    assert!(panics(|| { let _ = c.ft_on_transfer(id(OWNER), U128(1), "nope".into()); }).contains("msg must be"));
}

#[test]
fn a_legit_payment_updates_spent_and_balance() {
    let mut c = funded();
    as_(AGENT);
    let _ = c.pay(id(TREASURY), U128(1_000_000), "gpa_abc".into());
    let a = c.get_agent(id(AGENT)).unwrap();
    assert_eq!((a.spent.0, a.balance.0), (1_000_000, 4_000_000));
    as_("escrow.ramx.testnet");
    assert!(c.on_pay(id(AGENT), id(TREASURY), U128(1_000_000), "gpa_abc".into(), Ok(())));
    assert!(get_logs()[0].contains("\"event\":\"paid\"") && get_logs()[0].contains("gpa_abc"));
}

#[test]
fn the_four_policy_refusals() {
    let mut c = funded();
    as_(AGENT);
    assert!(panics(|| { let _ = c.pay(id("rogue.testnet"), U128(1), String::new()); }).contains("payee rogue.testnet is not on the allow list"));
    assert!(panics(|| { let _ = c.pay(id(TREASURY), U128(1_000_001), String::new()); }).contains("above per_call_max 1000000"));
    for _ in 0..3 {
        let _ = c.pay(id(TREASURY), U128(1_000_000), String::new());
    }
    assert!(panics(|| { let _ = c.pay(id(TREASURY), U128(1), String::new()); }).contains("budget exceeded"));
    as_(OWNER);
    c.pause(id(AGENT));
    as_(AGENT);
    assert!(panics(|| { let _ = c.pay(id(TREASURY), U128(1), String::new()); }).contains("paused"));
    assert_eq!(c.get_agent(id(AGENT)).unwrap().spent.0, 3_000_000, "refusals spend nothing");
}

#[test]
fn balance_limits_even_a_large_budget() {
    let mut c = funded();
    as_(OWNER);
    c.set_policy(id(AGENT), Policy { budget: U128(100_000_000), per_call_max: U128(100_000_000), allow: vec![id(TREASURY)] });
    as_(AGENT);
    assert!(panics(|| { let _ = c.pay(id(TREASURY), U128(5_000_001), String::new()); }).contains("funded balance"));
}

#[test]
fn only_the_owner_sets_policy_pauses_and_withdraws() {
    let mut c = funded();
    as_(AGENT);
    let p = Policy { budget: U128(u128::MAX / 2), per_call_max: U128(u128::MAX / 2), allow: vec![id("rogue.testnet")] };
    assert!(panics(|| c.set_policy(id(AGENT), p.clone())).contains("only the agent's owner"));
    assert!(panics(|| c.resume(id(AGENT))).contains("only the agent's owner"));
    assert!(panics(|| { let _ = c.withdraw(id(AGENT), U128(1)); }).contains("only the agent's owner"));
    as_(OWNER);
    let _ = c.withdraw(id(AGENT), U128(2_000_000));
    assert_eq!(c.get_agent(id(AGENT)).unwrap().balance.0, 3_000_000);
}

#[test]
fn a_failed_transfer_undoes_the_payment() {
    let mut c = funded();
    as_(AGENT);
    let _ = c.pay(id(TREASURY), U128(1_000_000), String::new());
    testing_env!(
        VMContextBuilder::new().current_account_id(id("escrow.ramx.testnet")).predecessor_account_id(id("escrow.ramx.testnet")).build(),
        near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]
    );
    assert!(!c.on_pay(id(AGENT), id(TREASURY), U128(1_000_000), String::new(), Err(PromiseError::Failed)));
    let a = c.get_agent(id(AGENT)).unwrap();
    assert_eq!((a.spent.0, a.balance.0), (0, 5_000_000));
}
