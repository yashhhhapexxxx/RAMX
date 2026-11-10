#!/usr/bin/env python3
"""Local provider helper. Run in the owner's Terminal so macOS can grant Local Network access.

Only a scoped helper credential and provider-owned node key live here. No World session,
marketplace signer, ledger operator, treasury key or settler key is requested or installed.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ENROLLMENT_CONTEXT = {}


def clean_environment():
    # A Terminal may have an operator env exported. Never inherit it into installers/nodes.
    for key in list(os.environ):
        if key.startswith(("WORLD_", "SETTLER_", "X402_RELAYER_", "NEAR_GATEWAY_")) or key in ("JWT_SECRET", "GATEWAY_SIGNING_KEY", "TRANSCRIPT_KEY", "NEARAI_API_KEY"):
            os.environ.pop(key)


# Cloudflare (Browser Integrity Check, error 1010) blocks the default "Python-urllib" user agent with 403.
USER_AGENT = "ramx-provider-helper/1.0"


def request(base, path, body=None, token=None, timeout=35):
    headers = {"content-type": "application/json", "user-agent": USER_AGENT}
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(base.rstrip("/") + "/provider" + path,
                                 data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            text = json.load(error).get("error", {}).get("message", "Request failed")
        except (ValueError, AttributeError):
            text = "Gateway returned HTTP " + str(error.code)
        raise RuntimeError(text) from None


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": USER_AGENT}), timeout=120) as response:
        return response.read()


def safe_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError("Unsafe archive path")
    return path


def unzip(data, destination):
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 3000 or sum(i.file_size for i in archive.infolist()) > 50 * 1024 * 1024:
            raise ValueError("Application bundle exceeds limits")
        for item in archive.infolist():
            safe_name(item.filename)
            if item.is_dir():
                continue
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Application symlinks are not allowed")
            path = destination / item.filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(archive.read(item))
            path.chmod(0o755 if path.suffix == ".sh" else 0o600)


def run(args, log, **kwargs):
    with log.open("ab") as output:
        result = subprocess.run(args, stdout=output, stderr=output, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} failed. See {log} for details")


def ensure_tools(root):
    tools = root / "tools"
    tools.mkdir(exist_ok=True)
    path = [str(tools / "uv"), str(tools / "pnpm/node_modules/.bin"), str(tools / "protoc/bin"),
            str(Path.home() / ".local/bin"), str(Path.home() / ".cargo/bin"), "/opt/homebrew/bin", "/usr/local/bin"]
    os.environ["PATH"] = os.pathsep.join(path + [os.environ.get("PATH", "")])
    log = root / "install.log"
    if not shutil.which("git"):
        raise RuntimeError("Install Git / Apple Command Line Tools, then rerun the helper command")
    if platform.system() == "Darwin":
        if platform.machine() != "arm64":
            raise RuntimeError("Apple Silicon is required for Mac workers")
        result = subprocess.run(["xcode-select", "-p"], capture_output=True)
        if result.returncode:
            raise RuntimeError("Run xcode-select --install, approve Apple's prompt, then retry")
    elif platform.system() != "Linux" or not shutil.which("nvidia-smi"):
        raise RuntimeError("Use Apple Silicon macOS or NVIDIA Linux with a working driver")
    if not shutil.which("uv"):
        script = tools / "install-uv.sh"
        script.write_bytes(fetch("https://astral.sh/uv/install.sh"))
        run(["sh", str(script)], log, env={**os.environ, "UV_INSTALL_DIR": str(tools / "uv"), "UV_NO_MODIFY_PATH": "1"})
    node = shutil.which("node")
    major = int(subprocess.check_output([node, "--version"], text=True).lstrip("v").split(".")[0]) if node else 0
    if major < 24:
        target = ("darwin" if platform.system() == "Darwin" else "linux") + "-" + ("arm64" if platform.machine() in ("arm64", "aarch64") else "x64")
        base = "https://nodejs.org/dist/latest-v24.x/"
        sums = fetch(base + "SHASUMS256.txt").decode().splitlines()
        digest, name = next(line.split() for line in sums if line.endswith("-" + target + ".tar.gz"))
        archive = fetch(base + name)
        if hashlib.sha256(archive).hexdigest() != digest:
            raise RuntimeError("Node download failed SHA-256 verification")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            for member in tar:
                safe_name(member.name)
                if member.issym() or member.islnk():
                    target_path = (tools / member.name).parent / member.linkname
                    if not target_path.resolve().is_relative_to(tools.resolve()):
                        raise ValueError("Unsafe runtime archive link")
                if sys.version_info >= (3, 12): tar.extract(member, tools, filter="data")
                else: tar.extract(member, tools)
        os.environ["PATH"] = str(tools / name.removesuffix(".tar.gz") / "bin") + os.pathsep + os.environ["PATH"]
    if not shutil.which("pnpm"):
        run(["npm", "install", "--prefix", str(tools / "pnpm"), "pnpm@12.8.1"], log)


def build_tools(root):
    """User-space compiler helpers; never invoke sudo or alter OS firewall/SSH settings."""
    log = root / "install.log"
    if not shutil.which("cargo"):
        installer = root / "tools/install-rust.sh"
        installer.write_bytes(fetch("https://sh.rustup.rs"))
        run(["sh", str(installer), "-y", "--profile", "minimal", "--no-modify-path"], log)
    if not shutil.which("protoc"):
        system = "osx" if platform.system() == "Darwin" else "linux"
        machine = "aarch_64" if platform.machine() in ("arm64", "aarch64") else "x86_64"
        data = fetch(f"https://github.com/protocolbuffers/protobuf/releases/download/v31.1/protoc-31.1-{system}-{machine}.zip")
        unzip(data, root / "tools/protoc")
        (root / "tools/protoc/bin/protoc").chmod(0o755)


def signature(secret, path, timestamp, nonce):
    return hmac.new(bytes.fromhex(secret), f"GET:{path}:{timestamp}:{nonce}".encode(), hashlib.sha256).hexdigest()


class ModelServer(ThreadingHTTPServer):
    daemon_threads = True


def cache_server(ip, config, roots):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            stamp, nonce = self.headers.get("X-Pool-Time", ""), self.headers.get("X-Pool-Nonce", "")
            try:
                valid = (abs(time.time() - int(stamp)) < 30 and re.fullmatch(r"[a-f0-9]{32}", nonce)
                         and hmac.compare_digest(self.headers.get("X-Pool-Signature", ""), signature(config["lan_secret"], self.path, stamp, nonce)))
                if not valid:
                    self.send_error(403)
                    return
                parts = urllib.parse.unquote(urllib.parse.urlparse(self.path).path).strip("/").split("/")
                if len(parts) < 4:
                    raise ValueError("Invalid model path")
                repo, revision, name = "/".join(parts[:2]), parts[2], "/".join(parts[3:])
                safe_name(name)
                model = roots[repo]
                if revision != model["revision"] or name not in model["files"]:
                    raise ValueError("Unknown model file")
                path = Path(model["snapshot"]) / name
                self.send_response(200)
                self.send_header("Content-Length", str(path.stat().st_size))
                self.end_headers()
                with path.open("rb") as source:
                    shutil.copyfileobj(source, self.wfile, 1024 * 1024)
            except (KeyError, ValueError):
                self.send_error(404)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ModelServer((ip, 5200), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024): digest.update(chunk)
    return digest.hexdigest()


def cache_candidates(parallax):
    roots = [Path(os.environ["HF_HOME"])] if os.environ.get("HF_HOME") else []
    return roots + [parallax / ".cache/huggingface", Path.home() / ".cache/huggingface"]


def reuse_file(sources, name, destination, metadata):
    for source in sources:
        candidate = source / name
        if candidate.is_file() and candidate.stat().st_size == metadata["size"] and digest_file(candidate) == metadata["sha256"]:
            destination.parent.mkdir(parents=True, exist_ok=True)
            try: os.link(candidate.resolve(), destination)
            except OSError: shutil.copyfile(candidate, destination)
            return True
    return False


def seed_coordinator_cache(root, parallax, repo):
    """Reuse complete existing HF snapshots, including the handoff's MLX cache layout."""
    folder = "models--" + repo.replace("/", "--")
    for cache in cache_candidates(parallax):
        ref = cache / "hub" / folder / "refs/main"
        if not ref.is_file(): continue
        revision = ref.read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{40}", revision): continue
        source = cache / "hub" / folder / "snapshots" / revision
        index = source / "model.safetensors.index.json"
        if index.is_file():
            files = set(json.loads(index.read_text()).get("weight_map", {}).values())
            if not files or not all((source / file).is_file() for file in files): continue
        elif not (source / "model.safetensors").is_file(): continue
        if not (source / "config.json").is_file(): continue
        target = root / "hf/hub" / folder / "snapshots" / revision
        for path in source.rglob("*"):
            if path.is_file():
                destination = target / path.relative_to(source)
                if not destination.exists():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    try: os.link(path.resolve(), destination)
                    except OSError: shutil.copyfile(path, destination)
        (target.parents[1] / "refs").mkdir(exist_ok=True)
        (target.parents[1] / "refs/main").write_text(revision)
        return revision
    return "main"


def coordinator_repos(model_config, backend):
    """(repo, required) pairs: the coordinator's own format first and required, the other format optional."""
    gpu, mlx = model_config["model_id"], model_config.get("mlx_variant")
    own, other = (mlx, gpu) if backend == "mlx" and mlx else (gpu, mlx)
    return [(own, True)] + ([(other, False)] if other else [])


def download_from_pool(root, config, repo, report, existing_caches=()):
    if repo not in config["snapshots"]:
        raise RuntimeError(f"The coordinator has no copy of {repo} for this laptop's backend. "
                           f"Download it on the coordinator (hf download {repo}), then click Retry setup")
    model = config["snapshots"][repo]
    folder = root / "hf/hub" / ("models--" + repo.replace("/", "--"))
    snapshot = folder / "snapshots" / model["revision"]
    total = sum(f["size"] for f in model["files"].values())
    done, last = 0, 0.0
    sources = [cache / "hub" / ("models--" + repo.replace("/", "--")) / "snapshots" / model["revision"] for cache in existing_caches]
    sources.append(Path.home() / "Models" / repo.split("/")[-1])
    if shutil.disk_usage(root).free < total * 1.1 and not snapshot.exists():
        raise RuntimeError("Not enough disk space for this model snapshot")
    for name, meta in model["files"].items():
        safe_name(name)
        destination = snapshot / name
        if destination.is_file() and destination.stat().st_size == meta["size"]:
            digest = hashlib.sha256()
            with destination.open("rb") as source:
                while chunk := source.read(1024 * 1024): digest.update(chunk)
            if digest.hexdigest() == meta["sha256"]:
                done += meta["size"]
                continue
        if not destination.exists() and reuse_file(sources, name, destination, meta):
            done += meta["size"]
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.with_name(destination.name + ".partial")
        path = "/" + urllib.parse.quote(repo + "/" + model["revision"] + "/" + name, safe="/")
        stamp, nonce = str(int(time.time())), os.urandom(16).hex()
        headers = {"X-Pool-Time": stamp, "X-Pool-Nonce": nonce, "X-Pool-Signature": signature(config["lan_secret"], path, stamp, nonce)}
        request_ = urllib.request.Request(f"http://{config['coordinator_ip']}:5200" + path, headers=headers)
        digest, size = hashlib.sha256(), 0
        try:
            with urllib.request.urlopen(request_, timeout=120) as response, temp.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > meta["size"]: raise RuntimeError("Model transfer exceeds expected size")
                    digest.update(chunk)
                    output.write(chunk)
                    if time.monotonic() - last > 2:
                        report("downloading", "Copying verified model files over Ethernet", done + size, total)
                        last = time.monotonic()
            if size != meta["size"] or digest.hexdigest() != meta["sha256"]:
                raise RuntimeError("Model transfer failed integrity verification")
            temp.replace(destination)
        finally:
            temp.unlink(missing_ok=True)
        done += size
    (folder / "refs").mkdir(parents=True, exist_ok=True)
    (folder / "refs/main").write_text(model["revision"])
    report("downloading", "Model cache verified", total, total)


def forward_job(base, token, job, private_port=3001):
    """Relay only the two fixed private Parallax endpoints, never a caller-supplied URL."""
    if job["path"] not in ("/v1/chat/completions", "/cluster/status_json"):
        raise RuntimeError("Unknown relay path")
    data = json.dumps(job["body"]).encode() if job["body"] is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{private_port}" + job["path"], data=data, headers={"content-type": "application/json"})
    try:
        upstream = urllib.request.urlopen(req, timeout=600)
    except urllib.error.HTTPError as error:
        upstream = error
    destination = urllib.parse.urlparse(base)
    connection = (http.client.HTTPSConnection if destination.scheme == "https" else http.client.HTTPConnection)(destination.hostname, destination.port, timeout=600)
    path = destination.path.rstrip("/") + "/provider/helper/jobs/" + job["id"] + "/parts"
    seq = 0

    def send_part(data, final):
        # One small POST per piece of the answer. A proxy in front of the gateway (Render/Cloudflare) buffers a
        # request body until it ends, so one long chunked upload would hold every token back until the end.
        nonlocal seq
        connection.request("POST", path, body=data, headers={
            "Authorization": "Bearer " + token, "User-Agent": USER_AGENT,
            "Content-Type": upstream.headers.get("content-type", "application/json"),
            "X-Upstream-Status": str(upstream.status), "X-Part-Seq": str(seq), "X-Part-Final": "1" if final else "0"})
        response = connection.getresponse()
        response.read()
        if response.status == 409:
            raise RuntimeError("Relay request was cancelled by the gateway")
        if response.status >= 400:
            raise RuntimeError(f"Gateway returned HTTP {response.status} for a relay part")
        seq += 1

    try:
        with upstream:
            streaming = upstream.headers.get("content-type", "").lower().startswith("text/event-stream")
            terminal_tail = b""
            # read1 returns what has arrived without waiting for a full buffer. While a part is in flight,
            # new tokens queue in the socket, so the next read1 batches them: one POST per round trip.
            while chunk := upstream.read1(16384):
                if streaming:
                    terminal = terminal_tail + chunk
                    # Parallax can leave the HTTP/RPC stream open after DONE. Waiting for
                    # EOF then blocks this helper's next OpenCode tool-result request.
                    if re.search(rb"(?:^|\r?\n)data:[ \t]*\[DONE\]\r?\n\r?\n", terminal):
                        send_part(chunk, True)
                        return
                    terminal_tail = terminal[-64:]
                send_part(chunk, False)
        send_part(b"", True)
    finally:
        connection.close()


# Relay jobs forwarded at once. The gateway queue admits max_concurrent_per_pool chat requests per
# pool and its relay holds at most 8 jobs per pool, so 8 workers never leave a delivered job waiting.
RELAY_WORKERS = 8


def relay_loop(stop, poll, forward, log, workers=RELAY_WORKERS):
    """One poller (a new poll replaces the previous one on the gateway); each job runs in its own
    thread, so a batched pool streams several answers at once. A worker slot is taken before polling."""
    free = threading.Semaphore(workers)

    def run_job(job):
        try: forward(job)
        except Exception as error:
            if not stop.is_set(): log("Inference relay: " + str(error))
        finally: free.release()

    while not stop.is_set():
        if not free.acquire(timeout=1): continue
        try:
            job = poll()
        except Exception as error:
            free.release()
            if not stop.is_set(): log("Inference relay: " + str(error))
            stop.wait(2)
            continue
        if job: threading.Thread(target=run_job, args=(job,), daemon=True).start()
        else: free.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway", required=True)
    parser.add_argument("--code")
    parser.add_argument("--resume", type=Path)
    parser.add_argument("--interface")
    args = parser.parse_args()
    clean_environment()
    base = args.gateway.rstrip("/")
    ENROLLMENT_CONTEXT.update(base=base, code=args.code)
    target = urllib.parse.urlparse(base)
    if target.scheme not in ("http", "https") or target.username or target.password:
        raise RuntimeError("Invalid gateway URL")
    resume = json.loads(args.resume.read_text()) if args.resume else None
    info = resume or request(base, "/enroll/info", {"code": args.code})
    if not re.fullmatch(r"pool_[a-f0-9]{24}", info["pool_id"]):
        raise RuntimeError("Invalid pool identifier")
    root = Path.home() / ".ramx/pools" / info["pool_id"]
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    lock = (root / "foreground.lock").open("w")
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: raise RuntimeError("This pool's helper is already running. Use its existing Terminal or stop it before reconnecting")
    print("Setting up this laptop. Keep Terminal open; approve Local Network access if macOS asks.", flush=True)
    ensure_tools(root)
    metadata = request(base, "/bootstrap")
    app = root / ("provider-app-" + metadata["bundle_sha256"][:16])
    if not app.exists():
        data = fetch(base + "/provider/bundle.zip")
        if hashlib.sha256(data).hexdigest() != metadata["bundle_sha256"]:
            raise RuntimeError("Application download failed SHA-256 verification")
        temporary = Path(tempfile.mkdtemp(prefix=".app-", dir=root))
        try:
            unzip(data, temporary)
            temporary.replace(app)
        finally:
            if temporary.exists(): shutil.rmtree(temporary)
    spec = importlib.util.spec_from_file_location("ramx_bootstrap_host", app / "pool/bootstrap/host.py")
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    member = {"ssh": "provider", "name": "local", **({"interface": args.interface} if args.interface else {})}
    for existing in [Path(os.environ.get("PARALLAX_DIR", "/nonexistent")), Path.home() / "parallax", Path.home() / "Desktop/parallax"]:
        if (existing / ".venv/bin/parallax").exists():
            member["parallax_dir"] = str(existing)
            break
    payload = {"pool_id": info["pool_id"], "member": member, "app": str(app)}
    facts = host.facts(payload)
    host.install(["uv", "sync", "--project", str(app / "node-agent"), "--locked"], root / "install.log")
    token = resume["token"] if resume else None
    if not token:
        key = root / "keys/node.key"
        script = ("import json,time; from pathlib import Path; from ramx_node.keys import load_or_create; "
                  "from ramx_node.parallax import detect_gpu; from ramx_node.signing import node_id,sign_register; "
                  f"a,_=load_or_create(Path({str(key)!r})); gpu,mem=detect_gpu(); ts=int(time.time()*1000); pool={info['pool_id']!r}; "
                  "print(json.dumps(dict(node_id=node_id(a),pool_id=pool,ts=ts,node_sig=sign_register(a,pool,ts),gpu=gpu,mem_gb=mem)))")
        registration = json.loads(host.run([str(app / "node-agent/.venv/bin/python"), "-c", script]))
        credentials = request(base, "/enroll/claim", {**registration, "code": args.code})
        token = credentials["token"]
        host.atomic_json(root / "helper.json", {**credentials, "gateway": base})
    stop = threading.Event()
    def interrupt(*_):
        stop.set()
        raise KeyboardInterrupt
    for sig in (signal.SIGINT, signal.SIGTERM): signal.signal(sig, interrupt)
    cache = None
    current = {}

    def report(stage, message, done=0, total=0):
        print(message, flush=True)
        return request(base, "/helper/progress", {"stage": stage, "message": message, "ip": facts["ip"],
                       "mem_gb": facts["memory_gb"],
                       "bytes_done": done, "bytes_total": total}, token)

    def keepalive():
        checked = 0.0
        while not stop.is_set():
            try:
                if time.monotonic() - checked > 15:
                    try:
                        _, actual_ip = host.wired_addresses(args.interface)
                        if actual_ip != facts["ip"]: raise RuntimeError("Ethernet address changed")
                    except Exception:
                        try: report("error", "Ethernet disconnected or its address changed. Reconnect Ethernet, then run a fresh helper command")
                        finally: stop.set()
                        return
                    checked = time.monotonic()
                fresh = request(base, "/helper/config", token=token)
                current.update(fresh)
            except Exception as error:
                print("Gateway connection interrupted: " + str(error), flush=True)
                if "revoked" in str(error).lower() or "expired" in str(error).lower(): stop.set()
            stop.wait(2)

    def jobs():
        relay_loop(stop, lambda: request(base, "/helper/jobs", token=token)["job"],
                   lambda job: forward_job(base, token, job), lambda text: print(text, flush=True))

    try:
        report("installing", "Installing and checking Parallax and node software")
        current.update(request(base, "/helper/config", token=token))
        threading.Thread(target=keepalive, daemon=True).start()
        if info["role"] == "coordinator": threading.Thread(target=jobs, daemon=True).start()
        report("installing", "Installing and checking Parallax and node software")
        parallax = Path(member.get("parallax_dir", str(root / "parallax"))).expanduser()
        if not (parallax / ".venv/bin/vllm-rs").exists(): build_tools(root)
        installed = host.prepare(payload)
        if stop.is_set(): raise RuntimeError("Helper stopped or enrollment revoked")
        facts.update(installed)
        payload.update(facts=facts, coordinator=facts, member_count=current["expected_members"], model=current["model"],
                       scheduler_port=5100, api_port=3001, gateway_url=base, frontend_url=base, dht_prefix=current["dht_prefix"],
                       batching=current.get("node_batching"), equal_layers=bool(current.get("equal_layers")))
        payload["member"].update(ssh="local" if info["role"] == "coordinator" else "provider", port=current["node_port"])
        if facts["backend"] == "mlx" and current["model"] == "Qwen/Qwen3-14B-FP8" and current["expected_members"] == 3:
            payload["member"]["param_mem_ratio"] = 0.37
        host.configure(payload)
        if info["role"] == "coordinator":
            models = {}
            for repo, required in coordinator_repos(current["model_config"], facts["backend"]):
                revision = seed_coordinator_cache(root, parallax, repo)
                # The other backend's format is shared only when it is already cached here: an all-Mac
                # pool must not download the ~30 GB GPU copy. A member that needs a missing format stops with a clear error.
                if not required and revision == "main": continue
                report("downloading", "Downloading and verifying " + repo)
                os.environ.pop("HF_HUB_OFFLINE", None)
                models[repo] = host.download({**payload, "repo": repo, "revision": revision})
            cache = cache_server(facts["ip"], current, models)
            request(base, "/helper/snapshots", {repo: {"revision": entry["revision"], "files": entry["files"]} for repo, entry in models.items()}, token)
        else:
            report("waiting", "Waiting for the coordinator's model cache")
            while not current.get("snapshots") or not current.get("coordinator_ip"):
                if stop.wait(2): return
            repo = current["model_config"]["mlx_variant"] if facts["backend"] == "mlx" else current["model"]
            download_from_pool(root, dict(current), repo, report, cache_candidates(parallax))
        host.service({**payload, "service": "agent"})
        report("prepared", "Prepared. Waiting for the other approved members")
        generation, joined, ready, warmed, spare_reported = 0, False, False, False, False
        joined_at = 0.0
        scheduler_generation = 0
        while not stop.wait(1):
            config = dict(current)
            if not config: continue
            if config["state"] == "stopped":
                report("stopped", "Pool stopped by coordinator")
                break
            if config["state"] == "preparing" and joined:
                host.stop(payload)
                host.service({**payload, "service": "agent"})
                joined, ready, warmed, spare_reported = False, False, False, False
                report("prepared", "Prepared for the next coordinated start")
            if config["state"] == "preparing" and config.get("stage") == "waiting":
                report("prepared", "Prepared for the next coordinated start")
            if config["state"] == "starting" and info["role"] == "coordinator" and scheduler_generation != config["generation"]:
                report("starting", "Starting the private Parallax scheduler")
                payload["member_count"] = config["expected_members"]
                payload["equal_layers"] = bool(config.get("equal_layers"))
                host.configure(payload)
                host.service({**payload, "service": "scheduler"})
                log = app / "pool/logs/scheduler.log"
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    text = log.read_text().rsplit("=== ramx start scheduler", 1)[-1] if log.exists() else ""
                    peers = re.findall(r"Stored scheduler peer id: (12D3\w+)", text)
                    if peers:
                        request(base, "/helper/scheduler", {"address": f"/ip4/{facts['ip']}/tcp/5100/p2p/{peers[-1]}"}, token)
                        scheduler_generation = config["generation"]
                        break
                    if stop.wait(1): return
                else: raise RuntimeError("Scheduler did not start; inspect pool/logs/scheduler.log")
            if config.get("start_at") and config["generation"] != generation:
                payload.update(scheduler_addr=config["scheduler_addr"], member_count=config["expected_members"],
                               batching=config.get("node_batching"))
                payload["member"]["port"] = config["node_port"]
                host.configure(payload)
                delay = max(0, (config["start_at"] - config["server_time"]) / 1000)
                if stop.wait(delay): return
                report("starting", "Joining the model pipeline")
                host.service({**payload, "service": "node"})
                joined, generation = True, config["generation"]
                joined_at = time.monotonic()
            if joined and not ready:
                log = app / "pool/logs/node.log"
                text = log.read_text().rsplit("=== ramx start node", 1)[-1] if log.exists() else ""
                if "Executor loaded successfully and ready to serve requests" in text:
                    report("online", "Model layers loaded; node agent is reporting its route")
                    ready = True
                elif config["state"] == "ready" and not spare_reported:
                    report("prepared", "Connected as spare capacity; Parallax has placed the active pipeline")
                    spare_reported = True
            if joined and config["state"] == "starting" and time.monotonic() - joined_at > 900:
                raise RuntimeError("Pool startup timed out. Check peer network permissions, scheduler logs and directory wallet gas")
            if joined and info["role"] == "coordinator" and config["state"] == "starting":
                try:
                    if not warmed:
                        with urllib.request.urlopen("http://127.0.0.1:3001/cluster/status_json", timeout=5) as response:
                            cluster = json.load(response)["data"]
                        if not cluster.get("max_running_request"): continue
                        with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3001/v1/chat/completions",
                            data=json.dumps({"model": config["model"], "messages": [{"role": "user", "content": "Say hello briefly."}], "max_tokens": 8,
                                             "stream": False, "chat_template_kwargs": {"enable_thinking": False}}).encode(), headers={"content-type": "application/json"}), timeout=180) as response:
                            warm = json.load(response)
                        warmed = bool(warm.get("usage", {}).get("completion_tokens"))
                    if warmed: request(base, "/helper/ready", {}, token)
                except Exception as error:
                    if warmed: report("online" if ready else "prepared", "Waiting for marketplace discovery: " + str(error)[:170])
                    stop.wait(3)
        print("Stopped. Run a new helper command from the website to reconnect.", flush=True)
    except Exception as error:
        try: report("error", str(error)[:240])
        except Exception: pass
        raise
    finally:
        stop.set()
        if cache: cache.shutdown(); cache.server_close()
        host.stop(payload)


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        if ENROLLMENT_CONTEXT.get("code"):
            try: request(ENROLLMENT_CONTEXT["base"], "/enroll/failure", {"code": ENROLLMENT_CONTEXT["code"], "message": str(error)[:240]})
            except Exception: pass
        print("Provider setup stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
