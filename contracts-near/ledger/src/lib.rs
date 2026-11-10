//! RAMX audit ledger: an ordered, append-only log of the gateway's signed events.
//!
//! The gateway keeps its working ledger in SQLite and appends every balance-change event here,
//! in order, numbered by the gateway (`first_seq`). Each event is the gateway's ed25519-signed canonical JSON (see `gateway/src/events.ts`);
//! this contract only orders it, numbers it and publishes it as a NEP-297 log:
//!
//! `EVENT_JSON:{"standard":"ramx","version":"1.0.0","event":"ledger","data":[{"seq":N,"event":{…signed event…}}]}`
//!
//! Nothing but a counter is stored, so the cost per event is gas only (no storage staking).
//! Anyone can check an event: read the log from the transaction and verify `sig` with `pubkey()`.

use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

/// Largest event accepted (bytes). Signed gateway events are well below 2 KB.
pub const MAX_EVENT_BYTES: usize = 4096;
/// Largest batch per call, so one call stays far below the gas limit.
pub const MAX_BATCH: usize = 50;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Ledger {
    /// The only account allowed to append (the gateway).
    writer: AccountId,
    /// Gateway ed25519 public key (0x + 64 hex) that signs every event.
    pubkey: String,
    /// Sequence number of the last appended event (0 = none yet).
    seq: u64,
}

#[near]
impl Ledger {
    #[init]
    pub fn new(writer: AccountId, pubkey: String) -> Self {
        assert_pubkey(&pubkey);
        Self { writer, pubkey, seq: 0 }
    }

    /// Append signed events in order. `first_seq` must be the next sequence number (`seq() + 1`):
    /// the gateway numbers events itself, so a retried call whose events already landed is
    /// rejected instead of publishing them twice. Returns the last sequence number.
    pub fn append_batch(&mut self, first_seq: u64, events: Vec<String>) -> u64 {
        self.assert_writer();
        require!(!events.is_empty(), "empty batch");
        require!(events.len() <= MAX_BATCH, "batch too large");
        if first_seq != self.seq + 1 {
            env::panic_str(&format!("expected first_seq {}", self.seq + 1));
        }
        for e in &events {
            self.push(e);
        }
        self.seq
    }

    /// Rotate the gateway signing key (writer only). Old events stay verifiable with the old key.
    pub fn set_pubkey(&mut self, pubkey: String) {
        self.assert_writer();
        assert_pubkey(&pubkey);
        env::log_str(&nep297("pubkey", json!({ "from_seq": self.seq + 1, "pubkey": pubkey })));
        self.pubkey = pubkey;
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn pubkey(&self) -> String {
        self.pubkey.clone()
    }

    pub fn writer(&self) -> AccountId {
        self.writer.clone()
    }
}

impl Ledger {
    fn assert_writer(&self) {
        require!(env::predecessor_account_id() == self.writer, "only the writer can append");
    }

    fn push(&mut self, event_json: &str) -> u64 {
        require!(event_json.len() <= MAX_EVENT_BYTES, "event too large");
        let event: Value = serde_json::from_str(event_json).unwrap_or_else(|_| env::panic_str("event is not JSON"));
        require!(event.is_object(), "event must be a JSON object");
        require!(event.get("sig").and_then(Value::as_str).is_some(), "event has no sig");
        self.seq += 1;
        env::log_str(&nep297("ledger", json!([{ "seq": self.seq, "event": event }])));
        self.seq
    }
}

fn nep297(event: &str, data: Value) -> String {
    format!("EVENT_JSON:{}", json!({ "standard": "ramx", "version": "1.0.0", "event": event, "data": data }))
}

fn assert_pubkey(pubkey: &str) {
    let hex = pubkey.strip_prefix("0x").unwrap_or("");
    require!(hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()), "pubkey must be 0x + 64 hex chars");
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const PK: &str = "0x9750f108f4273406aa7498086fc73b404633e5750d9f1d3dacfd95c1cc58c508";

    fn ctx(predecessor: &str) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(predecessor.parse().unwrap()).build());
    }

    fn ledger() -> Ledger {
        ctx("gateway.ramx.testnet");
        Ledger::new("gateway.ramx.testnet".parse().unwrap(), PK.into())
    }

    fn ev(n: u32) -> String {
        format!(r#"{{"v":1,"type":"starter_grant","n":{n},"sig":"0xabcd"}}"#)
    }

    #[test]
    fn append_numbers_events_in_order_and_logs_nep297() {
        let mut l = ledger();
        assert_eq!(l.append_batch(1, vec![ev(1)]), 1);
        assert_eq!(l.append_batch(2, vec![ev(2)]), 2);
        assert_eq!(l.seq(), 2);
        let logs = get_logs();
        let last: Value = serde_json::from_str(logs.last().unwrap().strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(last["standard"], "ramx");
        assert_eq!(last["event"], "ledger");
        assert_eq!(last["data"][0]["seq"], 2);
        assert_eq!(last["data"][0]["event"]["n"], 2, "the signed event is embedded unchanged");
    }

    #[test]
    fn batch_appends_all_and_returns_last_seq() {
        let mut l = ledger();
        assert_eq!(l.append_batch(1, vec![ev(1), ev(2), ev(3)]), 3);
        assert_eq!(get_logs().len(), 3);
    }

    #[test]
    #[should_panic(expected = "only the writer can append")]
    fn only_writer_appends() {
        let mut l = ledger();
        ctx("mallory.testnet");
        l.append_batch(1, vec![ev(1)]);
    }

    #[test]
    #[should_panic(expected = "event is not JSON")]
    fn rejects_non_json() {
        ledger().append_batch(1, vec!["not json".into()]);
    }

    #[test]
    #[should_panic(expected = "event has no sig")]
    fn rejects_unsigned() {
        ledger().append_batch(1, vec![r#"{"type":"x"}"#.into()]);
    }

    #[test]
    #[should_panic(expected = "event too large")]
    fn rejects_oversized() {
        ledger().append_batch(1, vec![format!(r#"{{"sig":"0x","pad":"{}"}}"#, "a".repeat(MAX_EVENT_BYTES))]);
    }

    #[test]
    #[should_panic(expected = "batch too large")]
    fn rejects_huge_batch() {
        ledger().append_batch(1, (0..(MAX_BATCH as u32 + 1)).map(ev).collect());
    }

    #[test]
    fn pubkey_rotation_is_logged() {
        let mut l = ledger();
        l.append_batch(1, vec![ev(1)]);
        let new = format!("0x{}", "11".repeat(32));
        l.set_pubkey(new.clone());
        assert_eq!(l.pubkey(), new);
        assert!(get_logs().last().unwrap().contains("\"from_seq\":2"));
    }

    #[test]
    #[should_panic(expected = "expected first_seq 2")]
    fn retried_batch_is_rejected_not_duplicated() {
        let mut l = ledger();
        l.append_batch(1, vec![ev(1)]);
        l.append_batch(1, vec![ev(1)]); // the gateway retries after a lost response
    }

    #[test]
    #[should_panic(expected = "expected first_seq 1")]
    fn gap_is_rejected() {
        ledger().append_batch(3, vec![ev(3)]);
    }

    #[test]
    #[should_panic(expected = "pubkey must be 0x + 64 hex chars")]
    fn rejects_bad_pubkey() {
        ctx("gateway.ramx.testnet");
        Ledger::new("gateway.ramx.testnet".parse().unwrap(), "abc".into());
    }
}
