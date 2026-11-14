"""Node agent post-MVP P5 parts: served-session counting (P5.9), memory (P5.7), LAN IP (P5.6),
restart command (P5.5), peer ID and stale-log handling (P5.4/P5.5)."""
import json
import socket
import urllib.request
from pathlib import Path

from ramx_node import notify, system
from ramx_node.agent import restart_command
from ramx_node.config import load
from ramx_node.parallax import parse_log, read_peer_id

JOIN = "Join scheduler response: {'node_id': '12D3KooWold', 'model_name': 'Qwen/Qwen3-14B-FP8', 'start_layer': 29, 'end_layer': 40}\n"


def test_context_limit_tracks_running_process_and_survives_assignment():
    log = "=== ramx start node now ===\nramx max_seq=8192\n" + JOIN
    assert parse_log(log).max_seq == 8192
    assert parse_log(log + "Reloading executor with layers [20, 40)\n").max_seq == 8192
    assert parse_log(log + "=== ramx start node later ===\n").max_seq is None
    assert parse_log(log + "ramx max_seq=bad\n").max_seq is None


def test_context_limit_is_signed_in_heartbeat():
    from ramx_node.signing import heartbeat_body
    body = json.loads(heartbeat_body("0xa", "p", 1, True, "m", [0, 40], None, {"max_seq": 8192}))
    assert body["max_seq"] == 8192


def test_start_marker_forgets_the_old_process():
    assert parse_log(JOIN).layers == [29, 40]
    log = JOIN + "=== ramx start node 2026-11-06T10:00:00Z ===\n" + "loading weights...\n"
    a = parse_log(log)
    assert a.layers is None and a.peer_id is None, "no stale layers while the new process loads"
    assert parse_log(log + JOIN.replace("12D3KooWold", "12D3KooWnew").replace("29", "20")).layers == [20, 40]


def test_read_peer_id(tmp_path):
    p = tmp_path / "node.peer-id"
    assert read_peer_id(p) is None
    p.write_text("12D3KooWabc\n")
    assert read_peer_id(p) == "12D3KooWabc"


def test_session_counter_counts_new_distinct_sessions():
    c = notify.SessionCounter()
    c.add([{"session_id": "a", "status": "started"}, {"session_id": "a", "status": "started"}, {"session_id": "b"}])
    c.add([{"session_id": "a"}, {"bad": 1}, "x"])
    c.add({"not": "a list"})
    assert c.take() == 2
    assert c.take() == 0
    c.add([{"session_id": "c"}])
    assert c.take() == 1


def test_notify_http_listener_on_loopback():
    c = notify.SessionCounter()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    httpd = notify.serve(c, port)
    try:
        body = json.dumps([{"session_id": "s1", "step_id": 1, "block_idx": 0, "total_blocks": 20, "status": "started"}]).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{port}/notify", data=body, headers={"content-type": "application/json"})
        assert urllib.request.urlopen(req, timeout=5).status == 204
        assert c.take() == 1
    finally:
        httpd.shutdown()


def test_swap_parsers():
    assert system.parse_mac_swapusage("total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)") == 1024.5
    assert system.parse_mac_swapusage("total = 4.00G  used = 1.50G  free = 2.50G") == 1536.0
    assert system.parse_mac_swapusage("garbage") is None
    assert system.parse_meminfo_swap("MemTotal: 1 kB\nSwapTotal:  2097152 kB\nSwapFree:   1048576 kB\n") == 1024.0
    assert system.parse_meminfo_swap("MemTotal: 1 kB\n") is None


def test_swap_watch_flags_growth_only_while_serving():
    w = system.SwapWatch(growth_mb=256, window_s=300)
    assert w.sample(None, True, 0) is None
    assert w.sample(1000, True, 0) == "ok"
    assert w.sample(1100, True, 10) == "ok"
    assert w.sample(1300, True, 20) == "swap_growing"
    assert w.sample(1300, False, 30) == "ok", "not serving → reset"
    assert w.sample(1310, True, 40) == "ok"
    assert w.sample(2000, True, 400) == "ok", "old samples leave the window"


def test_usable_memory():
    assert system.usable_mem_gb(16, True) == 12.0
    assert system.usable_mem_gb(24, True) == 18.0
    assert system.usable_mem_gb(8, False) == 8


def test_lan_ip(tmp_path):
    env = tmp_path / "node.env"
    env.write_text("ROLE=node\nLAN_IP=10.73.185.72   # wired\n")
    assert system.configured_lan_ip(env) == "10.73.185.72"
    assert system.configured_lan_ip(tmp_path / "missing") is None
    ip = system.current_lan_ip("http://127.0.0.1:8080")
    assert ip is None, "loopback is never a LAN address"


def test_restart_command(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(f"GATEWAY_URL=http://10.0.0.1:8080\nPOOL_ID=p\nPOOL_DIR={tmp_path}\n")
    monkeypatch.delenv("IS_COORDINATOR", raising=False)
    cfg = load(env)
    assert restart_command(cfg) == [str(tmp_path / "restart.sh"), "--join-delay", "15"]
    assert restart_command(cfg, "10.0.0.9")[-2:] == ["--lan-ip", "10.0.0.9"]
    monkeypatch.setenv("IS_COORDINATOR", "true")
    assert restart_command(load(env)) == [str(tmp_path / "restart.sh"), "--coordinator"]


def test_notify_port_comes_from_pool_node_env(tmp_path, monkeypatch):
    (tmp_path / "node.env").write_text("NOTIFY_PORT=5190          # comment\n")
    env = tmp_path / ".env"
    env.write_text(f"GATEWAY_URL=http://10.0.0.1:8080\nPOOL_ID=p\nPOOL_DIR={tmp_path}\n")
    monkeypatch.delenv("NOTIFY_PORT", raising=False)
    assert load(env).notify_port == 5190


# ---------- SPEC §16.1 automatic pool formation ----------

def test_tcp_rtt_to_open_and_closed_ports():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    open_port = srv.getsockname()[1]
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        closed_port = s.getsockname()[1]
    # Closed (nothing bound) → refused with RST on Linux and macOS. A bound but not listening port
    # is refused on Linux but silently dropped on macOS, so probe after the socket is closed.
    ms_open = system.tcp_rtt_ms("127.0.0.1", open_port)
    ms_closed = system.tcp_rtt_ms("127.0.0.1", closed_port)
    srv.close()
    assert ms_open is not None and ms_open < 50
    assert ms_closed is not None and ms_closed < 50, "a refused connect still measures the delay"


def test_measure_rtts_keeps_reachable_peers_only():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    port = srv.getsockname()[1]
    out = system.measure_rtts([{"node_id": "0xa", "lan_ip": "127.0.0.1", "port": port},
                               {"node_id": "0xb", "lan_ip": "192.0.2.1", "port": 9}], tries=1)  # TEST-NET-1: no answer
    srv.close()
    assert set(out) == {"0xa"}


def test_env_value_and_restart_with_dht_prefix(tmp_path, monkeypatch):
    (tmp_path / "node.env").write_text("TCP_PORT=5102\nDHT_PREFIX='gp-abc'  # pool\n")
    assert system.env_value(tmp_path / "node.env", "TCP_PORT") == "5102"
    assert system.env_value(tmp_path / "node.env", "DHT_PREFIX") == "gp-abc"
    assert system.env_value(tmp_path / "node.env", "NOPE") is None
    env = tmp_path / ".env"
    env.write_text(f"GATEWAY_URL=http://10.0.0.1:8080\nPOOL_ID=auto\nPOOL_DIR={tmp_path}\n")
    monkeypatch.delenv("IS_COORDINATOR", raising=False)
    assert restart_command(load(env), dht_prefix="gp-xyz")[-2:] == ["--dht-prefix", "gp-xyz"]


def test_swap_watch_only_on_unified_memory():
    w = system.SwapWatch(growth_mb=100, window_s=300)
    # A CUDA (Linux) node never reports swap pressure, even when host swap grows.
    assert system.mem_pressure(w, serving=True, system_name="Linux") == "ok"
    # macOS keeps the swap watch.
    w.sample(1000, True, now=0.0)
    assert w.sample(1500, True, now=1.0) == "swap_growing"
