import json
import os
import stat
from pathlib import Path

from eth_account import Account
from eth_account.messages import encode_defunct

from ramx_node import keys
from ramx_node.parallax import parse_log
from ramx_node.signing import P5_FIELDS, heartbeat_body, node_id, register_message, sign_body, sign_register
from make_vector import TEST_KEY, vector

REPO = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures" / "signature-vector.json"


def test_vector_fixture_is_current_and_deterministic():
    # RFC 6979 signatures: the same key and message give the same bytes. The gateway test verifies this file.
    assert json.loads(FIXTURE.read_text()) == vector()


def test_register_signature_recovers_to_node_id():
    acct = Account.from_key(TEST_KEY)
    sig = sign_register(acct, "pool-x", 123)
    msg = register_message(node_id(acct), "pool-x", 123)
    assert msg == f"ramx-register:{acct.address.lower()}:pool-x:123"
    assert Account.recover_message(encode_defunct(text=msg), signature=sig).lower() == node_id(acct)
    assert sig.startswith("0x") and len(sig) == 132 and sig == sig.lower()


def test_heartbeat_signature_is_over_raw_body_bytes():
    acct = Account.from_key(TEST_KEY)
    body = heartbeat_body(node_id(acct), "p", 1, True, "m", [0, 40], None)
    sig = sign_body(acct, body)
    assert Account.recover_message(encode_defunct(primitive=body), signature=sig).lower() == node_id(acct)
    assert Account.recover_message(encode_defunct(primitive=body + b" "), signature=sig).lower() != node_id(acct)


def test_heartbeat_body_shape_matches_shared_example():
    example = json.loads((REPO / "shared" / "examples" / "node-heartbeat.json").read_text())
    extra = {k: example[k] for k in P5_FIELDS}
    body = json.loads(heartbeat_body(example["node_id"], example["pool_id"], example["ts"], example["online"], example["model"], example["layers"], example["tok_s"], extra))
    assert body == example
    assert list(body) == list(example)  # same field order too
    off = json.loads(heartbeat_body(example["node_id"], "p", 1, False, None, None, None))
    assert off["layers"] is None and off["model"] is None and off["tok_s"] is None
    assert all(off[k] is None for k in P5_FIELDS), "P5 fields are always sent (null = unknown)"


def test_key_file_format_and_mode(tmp_path):
    p = tmp_path / "sub" / "node.key"
    acct, created = keys.load_or_create(p)
    assert created
    raw = p.read_text()
    assert raw.startswith("0x") and raw.endswith("\n") and len(raw) == 67
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    again, created2 = keys.load_or_create(p)
    assert not created2 and again.address == acct.address


SAMPLE_LOG = (
    "Nov 06 02:05:13.615 [\x1b[1m\x1b[36mparallax  \x1b[0m] [\x1b[1m\x1b[32mINFO    \x1b[0m] server.py:537             "
    "Join scheduler response: {'node_id': '12D3KooWMbcB', 'model_name': 'Qwen/Qwen3-14B-FP8', 'start_layer': 29, 'end_layer': 40, 'tp_size': 1, 'enable_weight_refit': False, 'weight_refit_mode': 'disk'}\n"
    "Nov 06 02:05:20.000 [parallax] [INFO] something else\n"
)


def test_parse_log_join_response_with_ansi():
    a = parse_log(SAMPLE_LOG)
    assert a.layers == [29, 40] and a.model == "Qwen/Qwen3-14B-FP8" and a.peer_id == "12D3KooWMbcB"


def test_parse_log_later_reallocation_wins():
    log = SAMPLE_LOG + (
        "Nov 06 02:10:00.000 [WARNING] Layer allocation changed! Current: [29, 40) -> New: [20, 40) Model: Qwen/Qwen3-14B-FP8 -> Qwen/Qwen3-14B-FP8\n"
    )
    assert parse_log(log).layers == [20, 40]
    log2 = log + "Nov 06 02:10:05.000 [INFO] Reloading executor with layers [25, 40)\n"
    assert parse_log(log2).layers == [25, 40]
    assert parse_log("no assignment here\n").layers is None
