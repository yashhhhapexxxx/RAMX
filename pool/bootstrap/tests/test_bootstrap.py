from __future__ import annotations

import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import host
import kickstart as K


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = json.loads((K.REPO / "pool/pool.example.json").read_text())
        self.config["frontend_url"] = "https://marketplace.test"
        K.TRANSPORT_IPS.clear()

    def tearDown(self):
        self.temp.cleanup()

    def load(self, config):
        path = self.root / "pool.json"
        path.write_text(json.dumps(config))
        return K.manifest(path)

    def test_manifest_rejects_unsafe_targets_and_invalid_topology(self):
        mutations = [
            lambda c: c.update(pool_id="../outside"),
            lambda c: c.update(pool_id="auto"),
            lambda c: c.update(model="unknown/model"),
            lambda c: c["members"][1].update(ssh="-oProxyCommand=bad"),
            lambda c: c["members"][1].update(ssh="user@host; touch /tmp/bad"),
            lambda c: c["members"][1].update(name="coordinator"),
            lambda c: c["members"][1].update(ssh="local"),
            lambda c: c["members"][0].update(port=5100),
            lambda c: c["members"][1].update(param_mem_ratio=1.0),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                config = copy.deepcopy(self.config)
                mutate(config)
                with self.assertRaises(ValueError):
                    self.load(config)

    def test_four_host_model_mapping_and_fixed_ports(self):
        config, model = self.load(self.config)
        self.assertEqual([m["port"] for m in config["members"]], [5101, 5102, 5103, 5104])
        self.assertEqual(model["mlx_variant"], "Qwen/Qwen3-14B-MLX-8bit")

    def archive(self, entries):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            for name, data, kind in entries:
                info = tarfile.TarInfo(name)
                if kind == "symlink":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "../../outside"
                    archive.addfile(info)
                else:
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
        stream.seek(0)
        return stream

    def test_transfer_rejects_tampering_traversal_symlinks_and_missing_files(self):
        expected = {"config.json": {"size": 2, "sha256": hashlib.sha256(b"{}").hexdigest()}}
        for entries in (
            [("config.json", b"[]", "file")],
            [("../outside", b"{}", "file")],
            [("config.json", b"", "symlink")],
            [],
            [("config.json", b"{}", "file"), ("config.json", b"{}", "file")],
        ):
            destination = self.root / "cache"
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                host.receive({"destination": str(destination), "files": expected}, self.archive(entries))
            self.assertFalse(destination.exists())
            self.assertFalse((self.root / "outside").exists())
            self.assertFalse(list(self.root.glob(".incoming-*")))

    def test_streamed_cache_round_trip_is_offline_discoverable_and_verified(self):
        source = self.root / "source"
        (source / "refs").mkdir(parents=True)
        revision = "a" * 40
        snapshot = source / "snapshots" / revision
        snapshot.mkdir(parents=True)
        (snapshot / "config.json").write_bytes(b"{}")
        (snapshot / "model.safetensors").write_bytes(b"test-weight-data")
        (source / "refs/main").write_text(revision)
        files = {p.relative_to(source).as_posix(): K.file_metadata(p) for p in source.rglob("*") if p.is_file()}
        destination = self.root / "hf/hub/models--Qwen--test"
        result = K.transfer({"name": "local-test", "ssh": "local"}, {}, str(destination), files, lambda name: source / name)
        self.assertEqual(result["verified_files"], 3)
        with patch.object(host, "root_for", return_value=self.root):
            payload = {"member": {}, "repo": "Qwen/test", "revision": revision, "files": host.snapshot_files(snapshot)}
            result = host.cached(payload)
            self.assertTrue(result["cached"])
            (destination / "snapshots" / revision / "model.safetensors").write_bytes(b"corrupt")
            with self.assertRaisesRegex(RuntimeError, "verification"):
                host.cached(payload)

    def test_cache_transfer_does_not_overwrite_existing_destination(self):
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            host.receive({"destination": str(self.root), "files": {}}, self.archive([]))

    def test_source_bundle_excludes_credentials_and_runtime_data(self):
        for name in ("good.py", ".env", ".env.example", "wallet.key", "server.pem", "keys.txt"):
            (self.root / name).write_text("data")
        fake = type("Result", (), {"stdout": b"good.py\0.env\0.env.example\0wallet.key\0server.pem\0keys.txt\0"})()
        with patch.object(K, "REPO", self.root), patch.object(K.subprocess, "run", return_value=fake):
            self.assertEqual(set(K.source_files()), {"good.py", ".env.example"})

    def test_reused_pid_is_not_signalled(self):
        record = self.root / "node.process.json"
        record.write_text(json.dumps({"pid": 123, "stamp": "old process"}))
        with patch.object(host, "app_paths", return_value=(self.root, self.root, self.root)), \
             patch.object(host, "process_stamp", return_value="different process"), \
             patch.object(host.os, "killpg") as kill:
            host.stop({})
            kill.assert_not_called()

    def fake_state(self):
        config, _ = self.load(self.config)
        hosts = {m["name"]: {"ip": f"10.1.0.{i+1}", "app": str(self.root / m["name"]), "root": str(self.root)} for i, m in enumerate(config["members"])}
        state = {"hosts": hosts, "gateway_url": "http://10.1.0.1:8080", "dht_prefix": "gp-test", "phase": "prepared"}
        log = Path(hosts["coordinator"]["app"]) / "pool/logs/scheduler.log"
        log.parent.mkdir(parents=True)
        log.write_text("=== ramx start scheduler now ===\nStored scheduler peer id: 12D3KooWtest\n")
        return config, state

    def test_up_gates_worker_start_on_registration_and_discovery(self):
        config, state = self.fake_state()
        events = []

        def call(member, action, payload, **kwargs):
            events.append((member["name"], action, payload.get("service")))
            if action == "status":
                return {"services": {"node": True, "agent": True}}
            return {}

        def response(url, body=None, **kwargs):
            if url.endswith("cluster/status_json"):
                return {"data": {"max_running_request": 1, "need_more_nodes": False, "node_list": [{}, {}, {}, {}]}}
            if url.endswith("chat/completions"):
                return {"usage": {"completion_tokens": 3}, "choices": [{}]}
            if "/pools/" in url:
                return {"status": "ready"}
            if url.endswith("/v1/models"):
                return {"data": [{"id": config["model"]}]}
            if url.endswith("/network"):
                return {"pools": [{"pool_id": config["pool_id"], "status": "ready", "models": [config["model"]]}]}
            raise AssertionError(url)

        with patch.object(K, "inspect", return_value=state["hosts"]), patch.object(K, "gateway"), \
             patch.object(K, "call", side_effect=call), patch.object(K, "get_json", side_effect=response):
            K.up(config, state, lambda: None)
        registrations = [i for i, event in enumerate(events) if event[1] == "registered"]
        joins = [i for i, event in enumerate(events) if event[2] == "node"]
        configurations = [i for i, event in enumerate(events) if event[1] == "configure"]
        self.assertEqual(len(registrations), 4)
        self.assertEqual(len(joins), 4)
        self.assertLess(max(registrations), min(joins))
        self.assertLess(max(configurations), min(joins))
        self.assertEqual(state["phase"], "ready")

    def test_failed_registration_prevents_any_worker_start(self):
        config, state = self.fake_state()
        with patch.object(K, "inspect", return_value=state["hosts"]), patch.object(K, "gateway"), \
             patch.object(K, "call", side_effect=RuntimeError("owner has not registered")) as call:
            with self.assertRaisesRegex(RuntimeError, "not registered"):
                K.up(config, state, lambda: None)
        self.assertTrue(all(args[0][1] == "registered" for args in call.call_args_list))
        self.assertEqual(state["phase"], "prepared")

    def test_ip_change_prevents_start_with_stale_announced_address(self):
        config, state = self.fake_state()
        changed = copy.deepcopy(state["hosts"])
        changed["mac-one"]["ip"] = "10.1.0.99"
        with patch.object(K, "inspect", return_value=changed), patch.object(K, "gateway") as gateway:
            with self.assertRaisesRegex(RuntimeError, "address changed"):
                K.up(config, state, lambda: None)
            gateway.assert_not_called()


    def test_configure_writes_batching_flags_from_the_gateway_and_keeps_mac_memory_flags(self):
        def node_env(batching):
            payload = {"pool_id": "pool_test", "member": {"ssh": "provider", "port": 5102}, "facts": {"backend": "mlx", "ip": "10.1.0.2"},
                       "dht_prefix": "gp-test", "gateway_url": "http://127.0.0.1:8080", "frontend_url": "http://127.0.0.1:8080", "api_port": 3001}
            if batching is not None: payload["batching"] = batching
            with patch.object(host, "app_paths", return_value=(self.root, self.root, self.root)):
                host.configure(payload)
            return (self.root / "pool/node.env").read_text()
        default = node_env(None)
        for line in ("MAX_BATCH_SIZE=4\n", "MICRO_BATCH_RATIO=2\n", "SCHEDULER_WAIT_MS=50\n",
                     "EXTRA_FLAGS='--kv-cache-memory-fraction 0.25 --max-sequence-length 4096'\n"):
            self.assertIn(line, default)
        tuned = node_env({"max_batch_size": 2, "micro_batch_ratio": 1, "scheduler_wait_ms": 0})
        for line in ("MAX_BATCH_SIZE=2\n", "MICRO_BATCH_RATIO=1\n", "SCHEDULER_WAIT_MS=0\n"):
            self.assertIn(line, tuned)
        for bad in ({"max_batch_size": 0}, {"micro_batch_ratio": "2"}, {"scheduler_wait_ms": -1}):
            with self.subTest(bad=bad), self.assertRaises(ValueError): node_env(bad)

    def test_configure_sets_equal_layer_split_for_the_scheduler_only_when_asked(self):
        def scheduler_env(equal):
            payload = {"pool_id": "pool_test", "member": {"ssh": "local", "port": 5101}, "facts": {"backend": "mlx", "ip": "10.1.0.1"},
                       "dht_prefix": "gp-test", "gateway_url": "http://127.0.0.1:8080", "frontend_url": "http://127.0.0.1:8080",
                       "api_port": 3001, "scheduler_port": 5100, "model": "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8", "member_count": 4,
                       "equal_layers": equal}
            with patch.object(host, "app_paths", return_value=(self.root, self.root, self.root)):
                host.configure(payload)
            return (self.root / "pool/scheduler.env").read_text()
        self.assertIn("EQUAL_LAYERS_NODES=4\n", scheduler_env(True))
        self.assertIn("EQUAL_LAYERS_NODES=''\n", scheduler_env(False))

if __name__ == "__main__":
    unittest.main()


class MacWiredAddressTests(unittest.TestCase):
    PORTS = """Hardware Port: Ethernet Adapter (en4)
Device: en4
Ethernet Address: ce:0f:6c:e0:13:65

Hardware Port: AX88179A
Device: en12
Ethernet Address: f8:e4:3b:3c:3e:71

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 36:86:b6:f4:33:40

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 5c:9b:a6:6e:83:d1

Hardware Port: Thunderbolt 1
Device: en1
Ethernet Address: 36:86:b6:f4:33:40
"""
    IPS = {"en0": "10.163.187.188", "en12": "10.73.125.54"}

    def ipconfig(self, args, **_):
        ip = self.IPS.get(args[-1], "")
        return type("R", (), {"returncode": 0 if ip else 1, "stdout": ip + "\n" if ip else ""})()

    def test_usb_adapter_named_by_chip_is_found_and_wifi_ignored(self):
        with patch.object(host.platform, "system", return_value="Darwin"), \
             patch.object(host, "run", return_value=self.PORTS), \
             patch.object(host.subprocess, "run", side_effect=self.ipconfig):
            self.assertEqual(host.wired_addresses(), ("en12", "10.73.125.54"))
