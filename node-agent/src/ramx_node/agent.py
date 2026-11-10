"""Node agent loop (SPEC §4.1): a signed heartbeat to the gateway every HEARTBEAT_SECONDS. The gateway
builds the public directory (nodes, pools) from these heartbeats; the node writes nothing on chain."""
from __future__ import annotations

import json
import os
import signal
import threading
import time
from pathlib import Path

import httpx
from eth_account.signers.local import LocalAccount

import platform
import subprocess

from dataclasses import replace

from . import notify, parallax, system
from .config import Config
from .signing import heartbeat_body, node_id, sign_body

STATE = Path("~/.ramx/agent-state.json").expanduser()
PID = Path("~/.ramx/agent.pid").expanduser()
SIG_HEADER = "x-ramx-node-signature"


def now_ms() -> int:
    return int(time.time() * 1000)


def send_heartbeat(cfg: Config, acct: LocalAccount, client: httpx.Client, extra: dict | None = None) -> tuple[dict | None, parallax.Assignment, bool]:
    running = parallax.node_running()
    a = parallax.read_assignment(cfg.parallax_node_log) if running else parallax.Assignment()
    online = running and a.layers is not None
    p5 = dict(extra or {})
    # P5.4: the peer ID the hook wrote before the join (also known while loading), else the join log.
    p5["peer_id"] = (parallax.read_peer_id(cfg.peer_id_file) or a.peer_id) if running else None
    p5["challenge_result"] = p5.get("challenge_result")
    p5["max_seq"] = a.max_seq if online else None
    port = system.env_value(cfg.node_env, "TCP_PORT")
    p5["p2p_port"] = int(port) if port and port.isdigit() and port != "0" else None
    body = heartbeat_body(node_id(acct), cfg.pool_id, now_ms(), online, a.model, a.layers if online else None, None, p5)
    try:
        r = client.post(f"{cfg.gateway_url}/nodes/heartbeat", content=body, headers={"content-type": "application/json", SIG_HEADER: sign_body(acct, body)})
    except httpx.HTTPError as e:
        print(f"heartbeat: gateway unreachable: {e}", flush=True)
        return None, a, running
    if r.status_code != 200:
        print(f"heartbeat: HTTP {r.status_code}: {r.text[:300]}", flush=True)
        return None, a, running
    return r.json(), a, running


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(d: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps({**load_state(), **d}))


def restart_command(cfg: Config, lan_ip: str | None = None, dht_prefix: str | None = None) -> list[str]:
    """pool/restart.sh: stop the process group, (coordinator: start the scheduler), join again."""
    cmd = [str(cfg.pool_dir / "restart.sh")]
    if cfg.is_coordinator:
        cmd.append("--coordinator")
    elif cfg.restart_join_delay_s > 0:
        cmd += ["--join-delay", str(cfg.restart_join_delay_s)]
    if lan_ip:
        cmd += ["--lan-ip", lan_ip]
    if dht_prefix:
        cmd += ["--dht-prefix", dht_prefix]
    return cmd


class Restarter:
    """Runs one restart at a time in the background (heartbeats go on: the node reports offline)."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.busy = threading.Lock()

    def start(self, why: str, lan_ip: str | None = None, on_done=None, dht_prefix: str | None = None) -> bool:
        if not self.busy.acquire(blocking=False):
            return False
        cmd = restart_command(self.cfg, lan_ip, dht_prefix)

        def run() -> None:
            try:
                print(f"restart ({why}): {' '.join(cmd)}", flush=True)
                log = self.cfg.pool_dir / "logs" / "restart.log"
                log.parent.mkdir(parents=True, exist_ok=True)
                with log.open("a") as f:
                    r = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)
                print(f"restart ({why}): exit {r.returncode} (log {log})", flush=True)
                if r.returncode == 0 and on_done:
                    on_done()
            finally:
                self.busy.release()

        threading.Thread(target=run, daemon=True).start()
        return True


def run(cfg: Config, acct: LocalAccount) -> None:
    gpu, mem_gb = parallax.detect_gpu()
    PID.parent.mkdir(parents=True, exist_ok=True)
    PID.write_text(str(os.getpid()))
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    # ---- post-MVP P5 ----
    is_mac = platform.system() == "Darwin"
    usable = system.usable_mem_gb(mem_gb, is_mac)
    swap = system.SwapWatch(cfg.swap_growth_mb, cfg.swap_window_s)
    sessions = notify.SessionCounter()
    if cfg.notify_port:
        notify.serve(sessions, cfg.notify_port)
        print(f"counting served sessions on 127.0.0.1:{cfg.notify_port}/notify (P5.9)", flush=True)
    restarter = Restarter(cfg)
    saved = load_state()
    state = {"restart_ack": int(saved.get("restart_ack", 0)), "served_pending": 0, "warned": set(), "rtt": None, "challenge_result": None}
    # §16.1 automatic pool formation: POOL_ID=auto → use the pool the gateway assigned earlier, if any.
    auto = cfg.pool_id == "auto"
    if auto and saved.get("assigned_pool"):
        cfg = replace(cfg, pool_id=saved["assigned_pool"])
        print(f"auto pool: using assigned pool {cfg.pool_id}", flush=True)

    def measure(probe: list[dict]) -> None:
        state["rtt"] = system.measure_rtts(probe)
        print(f"measured delay to {len(state['rtt'])}/{len(probe)} nodes: {state['rtt']}", flush=True)

    def ack(rid: int) -> None:
        state["restart_ack"] = rid
        save_state({"restart_ack": rid})

    def warn_once(key: str, msg: str) -> None:
        if key not in state["warned"]:
            state["warned"].add(key)
            print(msg, flush=True)
    print(f"node {node_id(acct)} pool {cfg.pool_id} gpu {gpu} {mem_gb} GB; gateway {cfg.gateway_url}; log {cfg.parallax_node_log}", flush=True)

    with httpx.Client(timeout=10) as client:
        while not stop.is_set():
            state["served_pending"] += sessions.take()
            lan_ip = system.current_lan_ip(cfg.gateway_url)
            serving = parallax.node_running()
            extra = {"lan_ip": lan_ip, "mem_pressure": system.mem_pressure(swap, serving), "usable_mem_gb": usable,
                     "served_sessions": state["served_pending"] if cfg.notify_port else None, "restart_ack": state["restart_ack"],
                     "rtt_ms": state["rtt"], "challenge_result": state["challenge_result"]}
            resp, a, running = send_heartbeat(cfg, acct, client, extra)
            if resp:
                state["served_pending"] = 0
                state["challenge_result"] = None
                state["rtt"] = None
                challenge = resp.get("challenge")
                if challenge:
                    state["challenge_result"] = system.capability_challenge(challenge["challenge_id"], challenge["seed"], gpu, mem_gb, cfg.node_env)
                    print(f"hardware challenge {challenge['challenge_id']} completed: {state['challenge_result']['backend']} in {state['challenge_result']['elapsed_ms']} ms", flush=True)
                # §16.1 formation: measure delay to the nodes the gateway asked about (background).
                if resp.get("probe"):
                    threading.Thread(target=measure, args=(resp["probe"],), daemon=True).start()
                # §16.1 formation: the gateway put this "auto" node in a pool → join that pool's network.
                ap = resp.get("assigned_pool")
                if auto and ap and (ap["pool_id"] != cfg.pool_id or system.env_value(cfg.node_env, "DHT_PREFIX") != ap["dht_prefix"]):
                    def moved(ap=ap) -> None:
                        save_state({"assigned_pool": ap["pool_id"]})
                    if cfg.auto_restart:
                        if restarter.start(f"assigned to {ap['pool_id']} ({ap['model']})", dht_prefix=ap["dht_prefix"], on_done=moved):
                            cfg = replace(cfg, pool_id=ap["pool_id"])
                    else:
                        save_state({"assigned_pool": ap["pool_id"]})
                        cfg = replace(cfg, pool_id=ap["pool_id"])
                        warn_once(f"assigned-{ap['pool_id']}", f"assigned to pool {ap['pool_id']}: run pool/restart.sh --dht-prefix {ap['dht_prefix']} (or set AUTO_RESTART=true)")
                # P5.5: the gateway ordered a clean restart of the pool (live re-placement seen).
                rid = int(resp.get("restart_id", 0))
                if rid > state["restart_ack"]:
                    if cfg.auto_restart:
                        restarter.start(f"pool restart {rid}", on_done=lambda rid=rid: ack(rid))
                    else:
                        warn_once(f"restart-{rid}", f"pool restart {rid} ordered: run pool/restart.sh{' --coordinator' if cfg.is_coordinator else ''} (or set AUTO_RESTART=true)")
                # P5.6: Parallax announces LAN_IP from pool/node.env; if this machine's IP changed, it is unreachable.
                configured = system.configured_lan_ip(cfg.node_env)
                if lan_ip and configured and lan_ip != configured:
                    if cfg.auto_restart:
                        if restarter.start(f"LAN IP {configured} -> {lan_ip}", lan_ip=lan_ip):
                            print(f"LAN IP changed {configured} -> {lan_ip}: update the pool firewall allow-list for this machine", flush=True)
                    else:
                        warn_once(f"ip-{lan_ip}", f"LAN IP changed {configured} -> {lan_ip}: run pool/restart.sh --lan-ip {lan_ip} (or set AUTO_RESTART=true)")
                # online = Parallax node runs and has layers; loading = runs, no layers yet; offline = not running.
                status = "online" if (running and a.layers) else ("loading" if running else "offline")
                save_state({"owner_account": resp["owner_account"], "reliability": resp["reliability"], "gpu": gpu, "mem_gb": mem_gb})
                print(f"heartbeat ok: {status} layers {a.layers} model {a.model}", flush=True)
            stop.wait(cfg.heartbeat_seconds)
    PID.unlink(missing_ok=True)
    print("agent stopped", flush=True)


def final_heartbeat(cfg: Config, acct: LocalAccount) -> None:
    """`stop`: one last signed heartbeat (Parallax is stopped, so it reports offline). The gateway lists
    the node as offline at once; with no further heartbeat the listing expires."""
    with httpx.Client(timeout=10) as client:
        resp, _, _ = send_heartbeat(cfg, acct, client)
    print("final heartbeat sent: offline" if resp else "final heartbeat failed; the listing expires on its own", flush=True)
