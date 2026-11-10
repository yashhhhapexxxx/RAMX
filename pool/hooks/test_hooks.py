"""Tests for ramx_hooks (post-MVP P5.3, P5.4, P5.8).

Run: python3 -m pytest pool/hooks   (no Parallax install needed)
Pin check against a Parallax source tree: PARALLAX_SRC=<parallax checkout> python3 -m pytest pool/hooks
"""
from __future__ import annotations

import ast
import enum
import json
import os
import sys
import textwrap
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import ramx_hooks as H  # noqa: E402


# ---------- fakes with the same shape as Parallax 162354a ----------

class NodeState(enum.Enum):
    ACTIVE = "active"
    STANDBY = "standby"


class FakeNode:
    def __init__(self, nid):
        self.node_id = nid
        self.last_heartbeat = 1000.0  # join time, long ago


def make_manager():
    class NodeManager:
        def __init__(self):
            self._nodes = {}
            self._state = {}

        def upsert(self, node):
            self._nodes[node.node_id] = node
            self._state.setdefault(node.node_id, NodeState.STANDBY)

        def get(self, nid):
            return self._nodes.get(nid)

        def state_of(self, nid):
            return self._state.get(nid)

        def activate(self, node_ids):
            for nid in node_ids:
                self._state[nid] = NodeState.ACTIVE

        def register_pipelines(self, pipelines):
            for p in pipelines:
                for nid in p:
                    self._state[nid] = NodeState.ACTIVE
            return {}

        def extend_registered_pipelines(self, pipelines):
            return {}

    return NodeManager


def test_grace_resets_heartbeat_when_standby_node_becomes_active():
    NM = make_manager()
    H.patch_node_manager(NM, NodeState.ACTIVE)
    m = NM()
    for nid in ("a", "b", "c"):
        m.upsert(FakeNode(nid))
    m._state["c"] = NodeState.ACTIVE
    m.get("c").last_heartbeat = 5.0
    t0 = time.time()
    m.activate(["a"])
    assert m.get("a").last_heartbeat >= t0, "standby -> active: clock reset"
    assert m.get("b").last_heartbeat == 1000.0, "untouched node keeps its clock"
    m.register_pipelines([["b", "c"]])
    assert m.get("b").last_heartbeat >= t0
    assert m.get("c").last_heartbeat == 5.0, "an already active node is not revived"
    H.patch_node_manager(NM, NodeState.ACTIVE)  # idempotent
    m.extend_registered_pipelines([["a"]])


class FakeScheduler:
    def __init__(self, known=()):
        self.known = set(known)

    def get_node(self, nid):
        return object() if nid in self.known else None


def make_rpc():
    class RPCConnectionHandler:
        def __init__(self, scheduler):
            self.scheduler = scheduler

        def build_node(self, node_json):
            return ("node", node_json["node_id"])

        # Parallax's RPC methods call build_node and turn any exception into {}.
        def node_join(self, message):
            try:
                return self.build_node(message)
            except Exception:
                return {}

        def node_update(self, message):
            try:
                return self.build_node(message)
            except Exception:
                return {}, {}

    H.patch_rpc_handler(RPCConnectionHandler)
    return RPCConnectionHandler


HW = {"memory_gb": 16, "gpu_name": "Apple M4"}


def test_guard_rejects_ghost_update_and_hardware_less_join(monkeypatch):
    monkeypatch.delenv("RAMX_ALLOWED_PEERS", raising=False)
    rpc = make_rpc()(FakeScheduler(known={"known"}))
    assert rpc.node_update({"node_id": "ghost", "hardware": HW}) == ({}, {}), "unknown peer cannot auto-join"
    assert rpc.node_update({"node_id": "known", "hardware": HW}) == ("node", "known")
    assert rpc.node_join({"node_id": "p1", "hardware": {}}) == {}, "heartbeat-only join"
    assert rpc.node_join({"node_id": "p1", "hardware": None}) == {}
    assert rpc.node_join({"node_id": "p1", "hardware": HW}) == ("node", "p1"), "no allow-list → admitted"


def test_admission_waits_for_the_allow_list(monkeypatch, tmp_path):
    allow = tmp_path / "allowed-peers.json"
    monkeypatch.setenv("RAMX_ALLOWED_PEERS", str(allow))
    monkeypatch.setenv("RAMX_ADMISSION_WAIT_S", "0")
    rpc = make_rpc()(FakeScheduler())
    assert rpc.node_join({"node_id": "p1", "hardware": HW}) == {}, "no file → rejected"
    allow.write_text(json.dumps({"peer_ids": ["p1"], "ts": 1}))
    assert rpc.node_join({"node_id": "p1", "hardware": HW}) == ("node", "p1")
    assert rpc.node_join({"node_id": "p2", "hardware": HW}) == {}
    allow.write_text("not json")
    assert rpc.node_join({"node_id": "p1", "hardware": HW}) == {}, "unreadable list admits nobody"


def test_admit_polls_until_the_peer_appears(tmp_path):
    allow = tmp_path / "a.json"
    import threading
    threading.Timer(0.2, lambda: allow.write_text(json.dumps({"peer_ids": ["late"]}))).start()
    assert H.admit("late", allow, wait_s=3, poll_s=0.05)
    assert not H.admit("never", allow, wait_s=0.1, poll_s=0.05)
    assert H.admit("anyone", None, wait_s=0)


def test_route_log_records_and_strips_the_gateway_field(monkeypatch, tmp_path):
    log = tmp_path / "routes.jsonl"
    monkeypatch.setenv("RAMX_ROUTE_LOG", str(log))

    class RequestHandler:
        def _prepare_backend_request(self, request_data, request_id, routing_table):
            out = dict(request_data)
            out["vllm_xargs"] = {"parallax_routing_table": list(routing_table)}
            return out

    H.patch_request_handler(RequestHandler)
    out = RequestHandler()._prepare_backend_request({"ramx_req_id": "req_1", "messages": []}, "uuid-1", ["peerA", "peerB"])
    assert "ramx_req_id" not in out, "never forwarded to the node backend"
    RequestHandler()._prepare_backend_request({"messages": []}, "uuid-2", ["peerA"])  # no gateway id → no line
    lines = [json.loads(x) for x in log.read_text().splitlines()]
    assert len(lines) == 1
    assert lines[0]["ramx_req_id"] == "req_1"
    assert lines[0]["parallax_request_id"] == "uuid-1"
    assert lines[0]["routing_table"] == ["peerA", "peerB"]


def test_node_side_peer_id_file(monkeypatch, tmp_path):
    monkeypatch.setenv("RAMX_PEER_ID_FILE", str(tmp_path / "node.peer-id"))

    class GradientServer:
        def get_node_info(self, is_update=False):
            return {"node_id": "12D3KooWtest", "hardware": HW}

    H.patch_gradient_server(GradientServer)
    assert GradientServer().get_node_info()["node_id"] == "12D3KooWtest"
    assert (tmp_path / "node.peer-id").read_text().strip() == "12D3KooWtest"


def test_install_patches_modules_on_import(tmp_path, monkeypatch):
    pkg = tmp_path / "backend" / "server"
    pkg.mkdir(parents=True)
    (tmp_path / "backend" / "__init__.py").write_text("")
    (pkg / "__init__.py").write_text("")
    (pkg / "request_handler.py").write_text(textwrap.dedent("""
        class RequestHandler:
            def _prepare_backend_request(self, request_data, request_id, routing_table):
                return dict(request_data)
    """))
    monkeypatch.syspath_prepend(str(tmp_path))
    for m in ("backend", "backend.server", "backend.server.request_handler"):
        sys.modules.pop(m, None)
    H.install()
    import backend.server.request_handler as rh  # noqa: E402
    assert getattr(rh.RequestHandler, H.PATCHED, False)
    for m in ("backend", "backend.server", "backend.server.request_handler"):
        sys.modules.pop(m, None)


# ---------- §16.1 node leave: cool-down before global rebalance ----------

def make_scheduler():
    class Alloc:
        def __init__(self):
            self.full = True

        def should_global_rebalance(self):
            return not self.full

    class NM:
        def __init__(self):
            self.active = ["a", "b"]
            self.standby_calls = []

        @property
        def nodes(self):
            return [type("N", (), {"manual_layer_assignment": False})() for _ in range(2)]

        @property
        def active_nodes(self):
            return [type("N", (), {"node_id": x})() for x in self.active]

        def standby(self, ids):
            self.standby_calls.append(ids)

    class Scheduler:
        def __init__(self):
            self.layer_allocator = Alloc()
            self.node_manager = NM()
            self.reboots = 0

        def checking_node_heartbeat(self):
            pass

        def bootstrap(self, reboot=False):
            self.reboots += 1
            return True

        def emit_alloc_log_snapshot(self, reason=None):
            pass

        # Parallax's leave path asks the allocator, then reboots at once if True.
        def process_leave(self):
            if self.layer_allocator.should_global_rebalance():
                self.node_manager.standby([n.node_id for n in self.node_manager.active_nodes])
                self.bootstrap(reboot=True)

    H.patch_scheduler(Scheduler)
    return Scheduler


def test_rebalance_waits_for_the_cooldown_then_runs(monkeypatch):
    monkeypatch.setenv("RAMX_REBALANCE_COOLDOWN_S", "0.2")
    s = make_scheduler()()
    s.layer_allocator.full = False
    s.process_leave()
    assert s.reboots == 0, "no immediate global reload"
    s.checking_node_heartbeat()
    assert s.reboots == 0
    time.sleep(0.25)
    s.checking_node_heartbeat()
    assert s.reboots == 1 and s.node_manager.standby_calls == [["a", "b"]]
    s.checking_node_heartbeat()
    assert s.reboots == 1, "runs once"


def test_rebalance_cancelled_when_the_pool_recovers(monkeypatch):
    monkeypatch.setenv("RAMX_REBALANCE_COOLDOWN_S", "0.1")
    s = make_scheduler()()
    s.layer_allocator.full = False
    s.process_leave()
    s.layer_allocator.full = True  # the node came back / a spare pipeline covers the model
    time.sleep(0.15)
    s.checking_node_heartbeat()
    assert s.reboots == 0


def test_spare_pipeline_never_rebalances(monkeypatch):
    monkeypatch.setenv("RAMX_REBALANCE_COOLDOWN_S", "0")
    s = make_scheduler()()
    s.process_leave()  # full pipeline still there
    assert s.reboots == 0


# ---------- pin against the real Parallax source ----------

PINS = {
    "src/scheduling/node_management.py": {
        "NodeManager": {"activate": ["self", "node_ids"], "register_pipelines": ["self", "pipelines"],
                        "extend_registered_pipelines": ["self", "pipelines"], "get": ["self", "node_id"], "state_of": ["self", "node_id"]},
    },
    "src/backend/server/rpc_connection_handler.py": {
        "RPCConnectionHandler": {"build_node": ["self", "node_json"], "node_join": ["self", "message"], "node_update": ["self", "message"]},
    },
    "src/backend/server/request_handler.py": {
        "RequestHandler": {"_prepare_backend_request": ["self", "request_data", "request_id", "routing_table"]},
    },
    "src/parallax/p2p/server.py": {"GradientServer": {"get_node_info": ["self", "is_update"]}},
    "src/scheduling/node.py": {"Node": {"get_decoder_layer_capacity": ["self", "include_input_embed", "include_lm_head"]}},
    "src/scheduling/scheduler.py": {"Scheduler": {"checking_node_heartbeat": ["self"], "bootstrap": ["self", "reboot"],
                                                  "emit_alloc_log_snapshot": ["self"], "_process_leaves": ["self"]}},
    "src/scheduling/layer_allocation.py": {"BaseLayerAllocator": {"should_global_rebalance": ["self"]}},
}


@pytest.mark.skipif(not os.environ.get("PARALLAX_SRC"), reason="set PARALLAX_SRC to a Parallax checkout")
def test_patched_functions_match_the_parallax_source():
    root = Path(os.environ["PARALLAX_SRC"])
    for rel, classes in PINS.items():
        tree = ast.parse((root / rel).read_text())
        found = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
        for cls, methods in classes.items():
            assert cls in found, f"{rel}: class {cls} missing"
            defs = {f.name: f for f in found[cls].body if isinstance(f, ast.FunctionDef)}
            for name, params in methods.items():
                assert name in defs, f"{rel}: {cls}.{name} missing"
                assert [a.arg for a in defs[name].args.args] == params, f"{rel}: {cls}.{name} parameters changed"
    # The guard relies on node_join/node_update calling build_node and catching exceptions.
    rpc = (root / "src/backend/server/rpc_connection_handler.py").read_text()
    assert "node = self.build_node(message)" in rpc and "self.scheduler.get_node(node.node_id) is None" in rpc
    assert "class NodeState" in (root / "src/scheduling/node_management.py").read_text()
    assert "last_heartbeat" in (root / "src/scheduling/node.py").read_text()
    sched = (root / "src/scheduling/scheduler.py").read_text()
    assert "self.layer_allocator = allocator_class(" in sched and "if not self.layer_allocator.should_global_rebalance():" in sched
    assert "self.node_manager.standby([n.node_id for n in self.node_manager.active_nodes])" in sched


def _capacity_node(capacity, layers=48):
    class Info:
        num_layers = layers

    class Node:
        model_info = Info()

        def get_decoder_layer_capacity(self, include_input_embed=False, include_lm_head=False):
            return capacity - (1 if include_input_embed or include_lm_head else 0)

    H.patch_node(Node)
    return Node()


def test_equal_split_caps_capacity_at_an_equal_share(monkeypatch):
    monkeypatch.setenv("RAMX_EQUAL_LAYERS_NODES", "4")
    node = _capacity_node(17)
    assert node.get_decoder_layer_capacity() == 12  # ceil(48 / 4): 3 nodes can no longer hold the model
    assert node.get_decoder_layer_capacity(include_input_embed=True) == 12
    monkeypatch.setenv("RAMX_EQUAL_LAYERS_NODES", "3")
    assert _capacity_node(17, layers=40).get_decoder_layer_capacity() == 14  # ceil(40 / 3)


def test_equal_split_never_raises_capacity_and_is_off_by_default(monkeypatch):
    monkeypatch.setenv("RAMX_EQUAL_LAYERS_NODES", "2")
    assert _capacity_node(10).get_decoder_layer_capacity() == 10  # share 24 > real capacity 10
    monkeypatch.delenv("RAMX_EQUAL_LAYERS_NODES")
    assert _capacity_node(17).get_decoder_layer_capacity() == 17
    monkeypatch.setenv("RAMX_EQUAL_LAYERS_NODES", "bad")
    assert _capacity_node(17).get_decoder_layer_capacity() == 17
