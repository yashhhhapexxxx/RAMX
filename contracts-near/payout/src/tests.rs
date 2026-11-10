use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const SETTLER: &str = "settler.ramx.testnet";
const TOKEN: &str = "usdc.fakes.testnet";
const SEC: u64 = 1_000_000_000;

fn at(predecessor: &str, now_s: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("payout.ramx.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(now_s * SEC)
        .build());
}

fn contract() -> Payout {
    at(SETTLER, 1_000);
    Payout::new(SETTLER.parse().unwrap(), TOKEN.parse().unwrap(), 60, 3_600)
}

#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Vector { cases: Vec<Case> }
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Case { root: String, leaves: Vec<Leaf> }
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Leaf { account: String, amount: String, leaf: String, proof: Vec<String> }

fn vector() -> Vector {
    serde_json::from_str(include_str!("../tests/merkle-vector.json")).unwrap()
}

/// Post the "three" case: alice 1000, bob 2500, node-1 123456 → total 126956.
fn posted() -> (Payout, Case) {
    let mut c = contract();
    let case = vector().cases.remove(1);
    at(TOKEN, 1_000);
    let _ = c.ft_on_transfer(SETTLER.parse().unwrap(), U128(126_956), json!({ "epoch": 7, "root": case.root }).to_string());
    (c, case)
}

fn leaf_of<'a>(case: &'a Case, account: &str) -> &'a Leaf {
    case.leaves.iter().find(|l| l.account == account).unwrap()
}

#[test]
fn merkle_matches_the_cross_language_vector() {
    at(SETTLER, 0);
    for case in vector().cases {
        let root = parse_hash(&case.root);
        for l in &case.leaves {
            let account: AccountId = l.account.parse().unwrap();
            assert_eq!(hex::encode(leaf(&account, l.amount.parse().unwrap())), l.leaf, "leaf of {}", l.account);
            let proof: Vec<[u8; 32]> = l.proof.iter().map(|p| parse_hash(p)).collect();
            assert!(verify(&proof, root, parse_hash(&l.leaf)), "proof of {}", l.account);
        }
    }
}

#[test]
fn post_via_ft_transfer_call_stores_the_epoch() {
    let (c, case) = posted();
    let e = c.get_epoch(7).unwrap();
    assert_eq!(e.root, case.root);
    assert_eq!(e.total.0, 126_956);
    assert_eq!(e.claimed.0, 0);
    assert_eq!(e.opens_at.0, 1_060);
    assert_eq!(e.sweep_opens_at.0, 4_600);
    assert!(get_logs().last().unwrap().contains("\"event\":\"epoch_posted\""));
}

#[test]
#[should_panic(expected = "only the configured token can fund epochs")]
fn other_tokens_cannot_post() {
    let mut c = contract();
    at("fake-usdc.testnet", 1_000);
    let _ = c.ft_on_transfer(SETTLER.parse().unwrap(), U128(1), json!({ "epoch": 1, "root": format!("{:064x}", 1) }).to_string());
}

#[test]
#[should_panic(expected = "only the settler can post epochs")]
fn only_the_settler_posts() {
    let mut c = contract();
    at(TOKEN, 1_000);
    let _ = c.ft_on_transfer("mallory.testnet".parse().unwrap(), U128(1), json!({ "epoch": 1, "root": format!("{:064x}", 1) }).to_string());
}

#[test]
#[should_panic(expected = "epoch 7 already posted")]
fn an_epoch_is_posted_once() {
    let (mut c, case) = posted();
    at(TOKEN, 1_001);
    let _ = c.ft_on_transfer(SETTLER.parse().unwrap(), U128(126_956), json!({ "epoch": 7, "root": case.root }).to_string());
}

#[test]
#[should_panic(expected = "zero root")]
fn zero_root_is_refused() {
    let mut c = contract();
    at(TOKEN, 1_000);
    let _ = c.ft_on_transfer(SETTLER.parse().unwrap(), U128(1), json!({ "epoch": 1, "root": "0".repeat(64) }).to_string());
}

#[test]
#[should_panic(expected = "claims open at 1060")]
fn claims_wait_for_the_delay() {
    let (mut c, case) = posted();
    let l = leaf_of(&case, "bob.testnet");
    at("bob.testnet", 1_059);
    c.claim(7, U128(2_500), l.proof.clone());
}

#[test]
fn claim_marks_claimed_and_transfers() {
    let (mut c, case) = posted();
    let l = leaf_of(&case, "bob.testnet");
    at("bob.testnet", 1_060);
    let _ = c.claim(7, U128(2_500), l.proof.clone());
    assert!(c.has_claimed(7, "bob.testnet".parse().unwrap()));
    assert_eq!(c.get_epoch(7).unwrap().claimed.0, 2_500);
    assert_eq!(c.claimed_of(7, vec!["bob.testnet".parse().unwrap(), "alice.testnet".parse().unwrap()]), vec![true, false]);
}

#[test]
#[should_panic(expected = "already claimed")]
fn claim_twice_fails() {
    let (mut c, case) = posted();
    let l = leaf_of(&case, "bob.testnet");
    at("bob.testnet", 1_060);
    let _ = c.claim(7, U128(2_500), l.proof.clone());
    let _ = c.claim(7, U128(2_500), l.proof.clone());
}

#[test]
#[should_panic(expected = "invalid proof")]
fn wrong_amount_fails() {
    let (mut c, case) = posted();
    let l = leaf_of(&case, "bob.testnet");
    at("bob.testnet", 1_060);
    let _ = c.claim(7, U128(2_501), l.proof.clone());
}

#[test]
#[should_panic(expected = "invalid proof")]
fn someone_elses_leaf_fails() {
    let (mut c, case) = posted();
    let l = leaf_of(&case, "bob.testnet");
    at("mallory.testnet", 1_060);
    let _ = c.claim(7, U128(2_500), l.proof.clone());
}

#[test]
fn a_failed_transfer_undoes_the_claim() {
    let (mut c, case) = posted();
    let l = leaf_of(&case, "alice.testnet");
    at("alice.testnet", 1_060);
    let _ = c.claim(7, U128(1_000), l.proof.clone());
    // The token transfer failed (alice has no storage_deposit on USDC): the callback runs with an error.
    testing_env!(
        VMContextBuilder::new().current_account_id("payout.ramx.testnet".parse().unwrap()).predecessor_account_id("payout.ramx.testnet".parse().unwrap()).build(),
        near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]
    );
    assert!(!c.on_claim(7, "alice.testnet".parse().unwrap(), U128(1_000), Err(PromiseError::Failed)));
    assert!(!c.has_claimed(7, "alice.testnet".parse().unwrap()), "alice can claim again after registering");
    assert_eq!(c.get_epoch(7).unwrap().claimed.0, 0);
}

#[test]
fn sweep_after_the_delay_closes_the_epoch() {
    let (mut c, case) = posted();
    let l = leaf_of(&case, "bob.testnet");
    at("bob.testnet", 1_060);
    let _ = c.claim(7, U128(2_500), l.proof.clone());
    at(SETTLER, 4_600);
    let _ = c.sweep(7);
    let e = c.get_epoch(7).unwrap();
    assert!(e.swept);
    assert_eq!(e.claimed.0, e.total.0);
}

#[test]
#[should_panic(expected = "sweep opens at 4600")]
fn sweep_waits_for_its_delay() {
    let (mut c, _) = posted();
    at(SETTLER, 4_599);
    let _ = c.sweep(7);
}

#[test]
#[should_panic(expected = "only the settler can sweep")]
fn only_the_settler_sweeps() {
    let (mut c, _) = posted();
    at("bob.testnet", 5_000);
    let _ = c.sweep(7);
}

#[test]
#[should_panic(expected = "epoch was swept")]
fn no_claims_after_a_sweep() {
    let (mut c, case) = posted();
    at(SETTLER, 4_600);
    let _ = c.sweep(7);
    let l = leaf_of(&case, "alice.testnet");
    at("alice.testnet", 4_601);
    let _ = c.claim(7, U128(1_000), l.proof.clone());
}
