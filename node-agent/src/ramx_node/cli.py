"""ramx-node init | start [--no-join] | stop [--keep-parallax]   (SPEC §4.2)"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import time
from urllib.parse import urlencode

from . import agent, keys, parallax
from .config import REPO, load
from .signing import node_id, sign_register


def cmd_init(cfg) -> None:
    acct, created = keys.load_or_create(cfg.node_key_path)
    print(f"{'created' if created else 'found'} node key {cfg.node_key_path} (mode 600)")
    gpu, mem_gb = parallax.detect_gpu()
    ts = int(time.time() * 1000)
    q = urlencode({"node_id": node_id(acct), "pool_id": cfg.pool_id, "gpu": gpu, "mem_gb": mem_gb, "ts": ts, "node_sig": sign_register(acct, cfg.pool_id, ts)})
    print(f"node_id {node_id(acct)}  gpu {gpu}  mem_gb {mem_gb}")
    print("Open this link, log in with World ID, and confirm the node (valid 24 h):")
    print(f"{cfg.frontend_url}/register-node?{q}")


def cmd_start(cfg, no_join: bool) -> None:
    acct = keys.load(cfg.node_key_path)
    if not no_join:
        subprocess.run([str(REPO / "pool" / "join-node.sh")], check=True)
    agent.run(cfg, acct)


def cmd_stop(cfg, keep_parallax: bool) -> None:
    acct = keys.load(cfg.node_key_path)
    if agent.PID.exists():
        pid = int(agent.PID.read_text().strip())
        try:
            os.kill(pid, signal.SIGTERM)
            print(f"stopped agent pid {pid}")
            for _ in range(100):  # wait for it to exit
                if not agent.PID.exists():
                    break
                time.sleep(0.5)
        except ProcessLookupError:
            agent.PID.unlink(missing_ok=True)
    if not keep_parallax:
        subprocess.run([str(REPO / "pool" / "stop-all.sh")], check=True)
    agent.final_heartbeat(cfg, acct)


def main() -> None:
    p = argparse.ArgumentParser(prog="ramx-node")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="create the node key, print the registration link")
    s = sub.add_parser("start", help="join the pool (pool/join-node.sh), then send signed heartbeats")
    s.add_argument("--no-join", action="store_true", help="do not start Parallax (it already runs)")
    t = sub.add_parser("stop", help="stop the agent and Parallax (pool/stop-all.sh), set the listing offline")
    t.add_argument("--keep-parallax", action="store_true", help="do not run pool/stop-all.sh")
    a = p.parse_args()
    cfg = load()
    if a.cmd == "init":
        cmd_init(cfg)
    elif a.cmd == "start":
        cmd_start(cfg, a.no_join)
    else:
        cmd_stop(cfg, a.keep_parallax)


if __name__ == "__main__":
    main()
