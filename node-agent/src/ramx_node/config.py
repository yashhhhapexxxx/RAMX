"""Env for the node agent (node-agent/.env.example, HANDOFF §8). Process env overrides the file."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]  # node-agent/src/ramx_node → repo root


def read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


@dataclass(frozen=True)
class Config:
    gateway_url: str
    frontend_url: str
    node_key_path: Path
    pool_id: str
    is_coordinator: bool
    heartbeat_seconds: int
    parallax_node_log: Path
    # ---- post-MVP P5 (docs/POST_MVP_PLAN.md) ----
    pool_dir: Path
    node_env: Path
    peer_id_file: Path
    auto_restart: bool
    restart_join_delay_s: int
    notify_port: int | None
    swap_growth_mb: float
    swap_window_s: float


def load(env_file: Path | None = None) -> Config:
    # Empty values count as unset, so the defaults below apply.
    env = {k: v for k, v in {**read_env_file(env_file or REPO / "node-agent" / ".env"), **os.environ}.items() if v != ""}

    def need(k: str) -> str:
        v = env.get(k, "")
        if not v:
            raise SystemExit(f"error: {k} is not set (see node-agent/.env.example)")
        return v

    exp = lambda p: Path(os.path.expanduser(p))  # noqa: E731
    pool_dir = exp(env.get("POOL_DIR", str(REPO / "pool")))
    node_env = exp(env.get("POOL_NODE_ENV", str(pool_dir / "node.env")))
    # NOTIFY_PORT must match pool/node.env (join-node.sh passes --notify-url); read it from there if unset.
    notify = env.get("NOTIFY_PORT") or read_env_file(node_env).get("NOTIFY_PORT", "").split("#", 1)[0].strip()
    return Config(
        gateway_url=need("GATEWAY_URL").rstrip("/"),
        frontend_url=env.get("FRONTEND_URL", "http://localhost:3000").rstrip("/"),
        node_key_path=exp(env.get("NODE_KEY_PATH", "~/.ramx/node.key")),
        pool_id=need("POOL_ID"),
        is_coordinator=env.get("IS_COORDINATOR", "false").lower() == "true",
        heartbeat_seconds=int(env.get("HEARTBEAT_SECONDS", "10")),
        parallax_node_log=exp(env.get("PARALLAX_NODE_LOG", str(REPO / "pool" / "logs" / "node.log"))),
        pool_dir=pool_dir,
        node_env=node_env,
        peer_id_file=exp(env.get("PEER_ID_FILE", str(pool_dir / "run" / "node.peer-id"))),
        auto_restart=env.get("AUTO_RESTART", "false").lower() == "true",
        restart_join_delay_s=int(env.get("RESTART_JOIN_DELAY_S", "15")),
        notify_port=int(notify) if notify else None,
        swap_growth_mb=float(env.get("SWAP_GROWTH_MB", "256")),
        swap_window_s=float(env.get("SWAP_WINDOW_S", "300")),
    )
