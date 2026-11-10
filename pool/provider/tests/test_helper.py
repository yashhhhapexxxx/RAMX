import hashlib
import importlib.util
import io
import json
import os
import concurrent.futures
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("provider_helper", Path(__file__).resolve().parents[1] / "helper.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class ProviderHelperTests(unittest.TestCase):
    def test_done_releases_relay_without_waiting_for_http_eof(self):
        release = threading.Event()
        parts = []
        payload = b'data: {"choices":[{"delta":{"content":"data: [DONE]"}}]}\r\n\r\n'
        class Upstream(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *_): pass
            def do_POST(self):
                self.rfile.read(int(self.headers["content-length"]))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                try:
                    for chunk in [payload, b"data: [DO", b"NE]\r\n\r\n"]:
                        self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                        self.wfile.flush()
                    release.wait(5)  # DONE has arrived, but the HTTP body deliberately stays open.
                    self.wfile.write(b"0\r\n\r\n")
                except (BrokenPipeError, ConnectionResetError): pass
        class Gateway(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            protocol_version = "HTTP/1.1"  # keep-alive: the helper sends every part on one connection
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                parts.append((int(self.headers["x-part-seq"]), self.headers["x-part-final"], body))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        gateway = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        for server in [upstream, gateway]:
            server.daemon_threads = True
            threading.Thread(target=server.serve_forever, daemon=True).start()
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            future = pool.submit(helper.forward_job, f"http://127.0.0.1:{gateway.server_port}", "fixture-token",
                                 {"id": "fixture", "path": "/v1/chat/completions", "body": {"stream": True}}, upstream.server_port)
            future.result(timeout=2)
            self.assertFalse(release.is_set(), "relay returns while upstream is still open")
            # Each piece is its own part, in order; the part holding DONE is final and nothing waits for EOF.
            self.assertEqual([seq for seq, _, _ in parts], list(range(len(parts))))
            self.assertEqual(parts[-1][1], "1")
            self.assertTrue(all(final == "0" for _, final, _ in parts[:-1]))
            self.assertEqual(b"".join(body for _, _, body in parts), payload + b"data: [DONE]\r\n\r\n")
        finally:
            release.set()
            pool.shutdown(wait=True)
            for server in [upstream, gateway]:
                server.shutdown()
                server.server_close()

    def test_operator_secrets_are_removed_before_any_subprocess(self):
        private = ["WORLD_RP_SIGNING_KEY", "JWT_SECRET", "GATEWAY_SIGNING_KEY", "NEAR_GATEWAY_KEY", "SETTLER_KEY", "X402_RELAYER_KEY", "TRANSCRIPT_KEY", "NEARAI_API_KEY"]
        with patch.dict(os.environ, {**{key: "test-only-value" for key in private}, "HF_TOKEN": "provider-owned-hub-token"}):
            helper.clean_environment()
            self.assertTrue(all(key not in os.environ for key in private))
            self.assertEqual(os.environ["HF_TOKEN"], "provider-owned-hub-token")
    def test_zip_rejects_traversal_and_symlinks(self):
        for path, symlink in (("../outside", False), ("key", True)):
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory:
                data = io.BytesIO()
                with zipfile.ZipFile(data, "w") as archive:
                    info = zipfile.ZipInfo(path)
                    if symlink: info.external_attr = 0o120777 << 16
                    archive.writestr(info, b"../../outside")
                with self.assertRaises(ValueError): helper.unzip(data.getvalue(), Path(directory) / "app")

    def test_model_transfer_checks_bytes_and_preserves_hf_offline_layout(self):
        content = b"model weight bytes"
        model = {"revision": "a" * 40, "files": {"model.safetensors": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}}}
        config = {"snapshots": {"Qwen/test": model}, "coordinator_ip": "10.1.0.1", "lan_secret": "b" * 64}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(helper.urllib.request, "urlopen", return_value=io.BytesIO(content)):
                helper.download_from_pool(root, config, "Qwen/test", lambda *_: None)
            folder = root / "hf/hub/models--Qwen--test"
            self.assertEqual((folder / "refs/main").read_text(), "a" * 40)
            self.assertEqual((folder / "snapshots" / ("a" * 40) / "model.safetensors").read_bytes(), content)
            with patch.object(helper.urllib.request, "urlopen", side_effect=AssertionError("must reuse verified file")):
                helper.download_from_pool(root, config, "Qwen/test", lambda *_: None)

    def test_corrupt_transfer_is_not_promoted_and_signature_binds_file_and_nonce(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"snapshots": {"Qwen/test": {"revision": "a" * 40, "files": {"model.safetensors": {"size": 3, "sha256": hashlib.sha256(b"abc").hexdigest()}}}},
                      "coordinator_ip": "10.1.0.1", "lan_secret": "b" * 64}
            with patch.object(helper.urllib.request, "urlopen", return_value=io.BytesIO(b"bad")):
                with self.assertRaisesRegex(RuntimeError, "integrity"):
                    helper.download_from_pool(Path(directory), config, "Qwen/test", lambda *_: None)
            self.assertFalse(list(Path(directory).rglob("*.partial")))
            self.assertFalse(list(Path(directory).rglob("model.safetensors")))
        first = helper.signature("b" * 64, "/file-a", "100", "a" * 32)
        self.assertNotEqual(first, helper.signature("b" * 64, "/file-b", "100", "a" * 32))
        self.assertNotEqual(first, helper.signature("b" * 64, "/file-a", "100", "c" * 32))

    def test_handoff_flat_cache_can_be_reused_without_modifying_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "existing"; source.mkdir()
            data = b"already downloaded model"; (source / "model.safetensors").write_bytes(data)
            destination = root / "new-cache/model.safetensors"
            self.assertTrue(helper.reuse_file([source], "model.safetensors", destination, {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}))
            self.assertEqual(destination.read_bytes(), data)
            self.assertEqual((source / "model.safetensors").read_bytes(), data)


    def test_relay_forwards_jobs_concurrently_with_one_poller(self):
        import threading, time
        stop, lock = threading.Event(), threading.Lock()
        queue, windows, polls = [{"id": "a"}, {"id": "b"}, {"id": "c"}], {}, []
        def poll():
            with lock:
                polls.append(time.monotonic())
                job = queue.pop(0) if queue else None
            if job is None: time.sleep(0.05)
            return job
        def forward(job):
            start = time.monotonic(); time.sleep(0.3)
            with lock:
                windows[job["id"]] = (start, time.monotonic())
                if len(windows) == 3: stop.set()
        thread = threading.Thread(target=helper.relay_loop, args=(stop, poll, forward, lambda _: None, 2), daemon=True)
        thread.start(); thread.join(3)
        self.assertEqual(set(windows), {"a", "b", "c"})
        (a0, a1), (b0, b1), (c0, _) = windows["a"], windows["b"], windows["c"]
        self.assertLess(max(a0, b0), min(a1, b1))   # a and b ran at the same time
        self.assertGreaterEqual(c0, min(a1, b1))    # c waited for a free worker (2 workers)

    def test_relay_keeps_polling_after_a_failed_job(self):
        import threading
        stop, seen = threading.Event(), []
        jobs = [{"id": "bad"}, {"id": "good"}]
        def forward(job):
            seen.append(job["id"])
            if job["id"] == "bad": raise RuntimeError("upstream failed")
            stop.set()
        logs = []
        helper.relay_loop(stop, lambda: jobs.pop(0) if jobs else None, forward, logs.append, 1)
        self.assertEqual(seen, ["bad", "good"])
        self.assertEqual(logs, ["Inference relay: upstream failed"])

class SnapshotFormatTests(unittest.TestCase):
    model = {"model_id": "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8", "mlx_variant": "lmstudio-community/Qwen3-30B-A3B-Instruct-2507-MLX-8bit"}

    def test_mac_coordinator_requires_only_mlx(self):
        self.assertEqual(helper.coordinator_repos(self.model, "mlx"),
                         [(self.model["mlx_variant"], True), (self.model["model_id"], False)])

    def test_gpu_coordinator_requires_gpu_format(self):
        self.assertEqual(helper.coordinator_repos(self.model, "cuda"),
                         [(self.model["model_id"], True), (self.model["mlx_variant"], False)])
        self.assertEqual(helper.coordinator_repos({"model_id": "x/y", "mlx_variant": None}, "mlx"), [("x/y", True)])

    def test_member_missing_format_has_clear_error(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "coordinator has no copy of x/gpu"):
                helper.download_from_pool(Path(directory), {"snapshots": {"x/mlx": {}}}, "x/gpu", lambda *a: None)


if __name__ == "__main__": unittest.main()
