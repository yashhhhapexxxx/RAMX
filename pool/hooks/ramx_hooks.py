"""Runtime hooks for Parallax (post-MVP P5.3, P5.4, P5.8; docs/POST_MVP_PLAN.md).

Parallax stays an installed dependency (CLAUDE.md §3). These patches apply after Parallax imports
its modules. They target Parallax commit 162354a; test_hooks.py checks the patched functions
against a Parallax source tree (PARALLAX_SRC) so a version change fails a test, not the pool.

Patches (only plain helper methods; the Lattica RPC methods themselves are not replaced):

P5.3 grace     scheduling.node_management.NodeManager.activate / register_pipelines /
               extend_registered_pipelines: a node that moves STANDBY -> ACTIVE gets a fresh
               last_heartbeat. Without this, a node that waited > 30 s for placement still has its
               join time and the heartbeat check removes it at once (no synchronized joins needed).
P5.4 guard     backend.server.rpc_connection_handler.RPCConnectionHandler.build_node:
               - node_update from a node the scheduler does not know is rejected (Parallax would
                 auto-join it: this is how leftover processes come back as ghost nodes);
               - node_join without hardware details (memory) is rejected;
               - with RAMX_ALLOWED_PEERS set: node_join waits up to RAMX_ADMISSION_WAIT_S
                 for the peer ID to appear in that file (the gateway writes the peer IDs of
                 registered nodes with a fresh signed heartbeat); else rejected.
               A rejection raises inside build_node; Parallax's node_join/node_update catch it and
               answer {} (join failed).
P5.8 route     backend.server.request_handler.RequestHandler._prepare_backend_request: removes the
               gateway field `ramx_req_id` and appends {ramx_req_id, parallax_request_id,
               routing_table, ts} to RAMX_ROUTE_LOG (JSON lines). The gateway reads it to store
               the route Parallax really used.
node side      parallax.p2p.server.GradientServer.get_node_info: writes this node's peer ID to
               RAMX_PEER_ID_FILE before the join, so the node agent can report it (P5.4, P5.9).
§16.1 leave    scheduling.scheduler.Scheduler: when a node leaves and no full pipeline is left,
               Parallax reloads EVERY node at once (global rebalance). The hook waits
               RAMX_REBALANCE_COOLDOWN_S (default 60) first. If the node comes back, or the pool
               has a full pipeline again (a spare copy), nothing is reloaded. Only after the
               cool-down does the same global rebalance run (in the scheduler's event-loop thread).
equal split    scheduling.node.Node.get_decoder_layer_capacity: with RAMX_EQUAL_LAYERS_NODES=N, a node's
               capacity is capped at ceil(num_layers / N). Parallax then needs all N nodes for one pipeline and
               its water-filling gives each about the same number of layers (Parallax alone uses the fewest
               stages, so same-memory pools leave members idle and overload the others). Never raises capacity.
"""
from __future__ import annotations

import functools
import importlib.abc
import importlib.util
import json
import os
import sys
import threading
import time
from pathlib import Path

PATCHED = "_ramx_patched"
_log_lock = threading.Lock()


def log(msg: str) -> None:
    print(f"ramx hooks: {msg}", file=sys.stderr, flush=True)


def _env_path(key: str, default_name: str) -> Path | None:
    v = os.environ.get(key)
    if v:
        return Path(v)
    run = os.environ.get("RAMX_RUN_DIR")
    return Path(run) / default_name if run else None


class GhostRejected(ValueError):
    """Raised in build_node to make Parallax answer {} to a join/update."""


# ---------- P5.3 grace ----------

def patch_node_manager(cls, active_state) -> None:
    if getattr(cls, PATCHED, False):
        return

    def refresh(self, before: dict) -> None:
        now = time.time()
        for nid, prev in before.items():
            if prev != active_state and self.state_of(nid) == active_state:
                node = self.get(nid)
                if node is not None:
                    node.last_heartbeat = now
                    log(f"grace: {nid} became active; heartbeat clock reset")

    def wrap(name: str, ids_of):
        orig = getattr(cls, name)

        @functools.wraps(orig)
        def wrapper(self, arg, *a, **kw):
            before = {nid: self.state_of(nid) for nid in ids_of(arg)}
            result = orig(self, arg, *a, **kw)
            refresh(self, before)
            return result

        setattr(cls, name, wrapper)

    wrap("activate", lambda ids: list(ids))
    flat = lambda pipelines: [nid for p in pipelines for nid in p]  # noqa: E731
    wrap("register_pipelines", flat)
    wrap("extend_registered_pipelines", flat)
    setattr(cls, PATCHED, True)


# ---------- P5.4 ghost guard and admission ----------

def allowed_peers(path: Path) -> set[str]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return set()
    return {p for p in data.get("peer_ids", []) if isinstance(p, str)} if isinstance(data, dict) else set()


def admit(peer: str, path: Path | None, wait_s: float, poll_s: float = 1.0) -> bool:
    """True if no allow-list is configured, or `peer` appears in it within `wait_s`."""
    if path is None:
        return True
    end = time.monotonic() + wait_s
    while True:
        if peer in allowed_peers(path):
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(poll_s)


def patch_rpc_handler(cls) -> None:
    if getattr(cls, PATCHED, False):
        return
    orig = cls.build_node

    @functools.wraps(orig)
    def build_node(self, node_json):
        caller = sys._getframe(1).f_code.co_name
        peer = (node_json or {}).get("node_id")
        if caller == "node_update" and self.scheduler.get_node(peer) is None:
            log(f"guard: rejected node_update from unknown peer {peer} (no auto-join; use parallax join)")
            raise GhostRejected(f"unknown peer {peer}")
        if caller == "node_join":
            hw = (node_json or {}).get("hardware") or {}
            if not peer or not hw.get("memory_gb"):
                log(f"guard: rejected node_join from {peer}: no hardware details (heartbeat-only join)")
                raise GhostRejected(f"no hardware details from {peer}")
            path = _env_path("RAMX_ALLOWED_PEERS", "allowed-peers.json") if os.environ.get("RAMX_ALLOWED_PEERS") else None
            wait_s = float(os.environ.get("RAMX_ADMISSION_WAIT_S", "30"))
            if not admit(peer, path, wait_s):
                log(f"guard: rejected node_join from {peer}: not in {path} after {wait_s:.0f} s (register the node and run its agent)")
                raise GhostRejected(f"peer {peer} not admitted")
        return orig(self, node_json)

    cls.build_node = build_node
    setattr(cls, PATCHED, True)


# ---------- P5.8 exact route ----------

def patch_request_handler(cls) -> None:
    if getattr(cls, PATCHED, False):
        return
    orig = cls._prepare_backend_request

    @functools.wraps(orig)
    def prepare(self, request_data, request_id, routing_table):
        gid = request_data.get("ramx_req_id") if isinstance(request_data, dict) else None
        backend_request = orig(self, request_data, request_id, routing_table)
        backend_request.pop("ramx_req_id", None)
        path = _env_path("RAMX_ROUTE_LOG", "routes.jsonl")
        if gid and path is not None:
            line = json.dumps({"ramx_req_id": gid, "parallax_request_id": str(request_id),
                               "routing_table": list(routing_table), "ts": int(time.time() * 1000)})
            try:
                with _log_lock, path.open("a") as f:
                    f.write(line + "\n")
            except OSError as e:
                log(f"route: cannot write {path}: {e}")
        return backend_request

    cls._prepare_backend_request = prepare
    setattr(cls, PATCHED, True)


# ---------- node side: peer ID file ----------

def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def patch_gradient_server(cls) -> None:
    if getattr(cls, PATCHED, False):
        return
    orig = cls.get_node_info

    @functools.wraps(orig)
    def get_node_info(self, *a, **kw):
        info = orig(self, *a, **kw)
        path = _env_path("RAMX_PEER_ID_FILE", "node.peer-id")
        peer = info.get("node_id") if isinstance(info, dict) else None
        if path is not None and peer:
            try:
                write_atomic(path, peer + "\n")
            except OSError as e:
                log(f"peer id: cannot write {path}: {e}")
        return info

    cls.get_node_info = get_node_info
    setattr(cls, PATCHED, True)


# ---------- §16.1 node leave: cool-down before a global rebalance ----------

def patch_scheduler(cls) -> None:
    if getattr(cls, PATCHED, False):
        return
    orig_init = cls.__init__
    orig_check = cls.checking_node_heartbeat

    @functools.wraps(orig_init)
    def __init__(self, *a, **kw):
        orig_init(self, *a, **kw)
        alloc = self.layer_allocator
        orig_should = alloc.should_global_rebalance
        self._gp_should = orig_should
        self._gp_rebalance_at = None

        def should_global_rebalance():
            if not orig_should():
                if self._gp_rebalance_at is not None:
                    log("leave: pool is whole again; global rebalance cancelled")
                self._gp_rebalance_at = None
                return False
            now = time.time()
            if self._gp_rebalance_at is None:
                cool = float(os.environ.get("RAMX_REBALANCE_COOLDOWN_S", "60"))
                self._gp_rebalance_at = now + cool
                log(f"leave: no full pipeline; global rebalance in {cool:.0f} s unless the pool recovers")
                return cool <= 0
            return now >= self._gp_rebalance_at

        alloc.should_global_rebalance = should_global_rebalance

    @functools.wraps(orig_check)
    def checking_node_heartbeat(self):
        orig_check(self)
        due = getattr(self, "_gp_rebalance_at", None)
        if due is None or time.time() < due:
            return
        if not self._gp_should():
            self._gp_rebalance_at = None
            return
        self._gp_rebalance_at = None
        nodes = self.node_manager.nodes
        if not nodes or any(n.manual_layer_assignment for n in nodes):
            log("leave: cool-down over, but no nodes or manual layer assignments; no global rebalance")
            return
        log("leave: cool-down over; global rebalance now")
        self.node_manager.standby([n.node_id for n in self.node_manager.active_nodes])
        try:
            self.bootstrap(reboot=True)
        finally:
            self.emit_alloc_log_snapshot(reason="after delayed global rebalance")

    cls.__init__ = __init__
    cls.checking_node_heartbeat = checking_node_heartbeat
    setattr(cls, PATCHED, True)


def patch_node(cls) -> None:
    orig = cls.get_decoder_layer_capacity
    if getattr(orig, PATCHED, False):
        return

    @functools.wraps(orig)
    def get_decoder_layer_capacity(self, *args, **kwargs):
        capacity = orig(self, *args, **kwargs)
        try:
            nodes = int(os.environ.get("RAMX_EQUAL_LAYERS_NODES") or 0)
        except ValueError:
            return capacity
        if nodes < 1:
            return capacity
        share = -(-int(self.model_info.num_layers) // nodes)  # ceil
        return min(capacity, share)

    setattr(get_decoder_layer_capacity, PATCHED, True)
    cls.get_decoder_layer_capacity = get_decoder_layer_capacity


# ---------- post-import patching ----------

def _patch_module(name: str, mod) -> None:
    try:
        if name == "scheduling.node_management":
            patch_node_manager(mod.NodeManager, mod.NodeState.ACTIVE)
        elif name == "backend.server.rpc_connection_handler":
            patch_rpc_handler(mod.RPCConnectionHandler)
        elif name == "backend.server.request_handler":
            patch_request_handler(mod.RequestHandler)
        elif name == "parallax.p2p.server":
            patch_gradient_server(mod.GradientServer)
        elif name == "scheduling.scheduler":
            patch_scheduler(mod.Scheduler)
        elif name == "scheduling.node":
            patch_node(mod.Node)
        else:
            return
        log(f"patched {name}")
    except Exception as e:
        log(f"cannot patch {name}: {e}")


TARGETS = {"scheduling.scheduler", "scheduling.node", "scheduling.node_management", "backend.server.rpc_connection_handler", "backend.server.request_handler", "parallax.p2p.server"}


class _Finder(importlib.abc.MetaPathFinder):
    """Find target modules with the normal finders, then patch them right after they execute."""

    def find_spec(self, fullname, path, target=None):
        if fullname not in TARGETS:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is not None and spec.loader is not None:
                loader = spec.loader
                orig_exec = loader.exec_module

                def exec_module(module, _orig=orig_exec, _name=fullname):
                    _orig(module)
                    _patch_module(_name, module)

                loader.exec_module = exec_module
                return spec
        return None


def install() -> None:
    if any(isinstance(f, _Finder) for f in sys.meta_path):
        return
    sys.meta_path.insert(0, _Finder())
    for name in TARGETS & set(sys.modules):  # already imported
        _patch_module(name, sys.modules[name])
