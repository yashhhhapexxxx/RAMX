"""Signatures (shared/README.md "Signatures"). Must match the gateway verifier byte for byte."""
from __future__ import annotations

import json

from eth_account.messages import encode_defunct
from eth_account.signers.local import LocalAccount


def node_id(acct: LocalAccount) -> str:
    """node_id = EVM address of the node key, lowercase."""
    return acct.address.lower()


def register_message(nid: str, pool_id: str, ts: int) -> str:
    return f"ramx-register:{nid}:{pool_id}:{ts}"


def sign_register(acct: LocalAccount, pool_id: str, ts: int) -> str:
    """EIP-191 personal_sign over the UTF-8 string ramx-register:<node_id>:<pool_id>:<ts>."""
    sig = acct.sign_message(encode_defunct(text=register_message(node_id(acct), pool_id, ts))).signature
    return "0x" + sig.hex().removeprefix("0x")


# Post-MVP P5 heartbeat fields (shared NodeHeartbeat), always sent, in this order. None = not known.
P5_FIELDS = ("peer_id", "lan_ip", "mem_pressure", "usable_mem_gb", "served_sessions", "restart_ack", "p2p_port", "rtt_ms", "challenge_result")


def heartbeat_body(nid: str, pool_id: str, ts: int, online: bool, model: str | None, layers: list[int] | None, tok_s: float | None,
                   extra: dict | None = None) -> bytes:
    """Raw request body (shared NodeHeartbeat). These exact bytes are signed and sent."""
    body = {"node_id": nid, "pool_id": pool_id, "ts": ts, "online": online, "model": model, "layers": layers, "tok_s": tok_s}
    for k in P5_FIELDS:
        body[k] = (extra or {}).get(k)
    if extra and "max_seq" in extra:
        body["max_seq"] = extra["max_seq"]
    return json.dumps(body, separators=(",", ":")).encode("utf-8")


def sign_body(acct: LocalAccount, body: bytes) -> str:
    """Header x-ramx-node-signature: EIP-191 personal_sign over the raw body bytes."""
    sig = acct.sign_message(encode_defunct(primitive=body)).signature
    return "0x" + sig.hex().removeprefix("0x")
