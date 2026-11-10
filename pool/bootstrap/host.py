"""Host operations sent over SSH by kickstart.py. No third-party control-plane dependencies.

stdin begins with one JSON line. `receive` then consumes a tar stream. Only explicitly
named hosts participate; there is no LAN scan, password automation, sudo or SSH change.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import platform
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
from pathlib import Path, PurePosixPath

PARALLAX_REF = "162354a03234a28cf6e2946e2e0b2203da7c3721"


def run(args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, **kwargs)
    if result.returncode:
        # Commands never include key material. Long install logs stay on the host.
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {result.stderr[-1500:]}")
    return result.stdout.strip()


def install(args, log, **kwargs):
    with log.open("a") as output:
        result = subprocess.run(args, stdout=output, stderr=output, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}); inspect {log}")


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2) + "\n")
    temp.chmod(0o600)
    temp.replace(path)


def root_for(payload):
    pool = payload["pool_id"]
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", pool):
        raise ValueError("invalid pool_id")
    return Path.home() / ".ramx" / "pools" / pool


def wired_addresses(interface=None):
    """Find active physical Ethernet IPv4 addresses. Fail on ambiguous adapters."""
    candidates = []
    if platform.system() == "Darwin":
        ports = run(["/usr/sbin/networksetup", "-listallhardwareports"])
        for block in ports.split("\n\n"):
            name = re.search(r"Hardware Port: (.+)", block)
            device = re.search(r"Device: (\S+)", block)
            # USB adapters often show only their chip name (e.g. "AX88179A"), so exclude the known
            # non-Ethernet ports instead of requiring "Ethernet" in the name. Ports without an IPv4 drop out below.
            if not name or not device or re.search(r"Wi-?Fi|AirPort|Bluetooth|Thunderbolt|iPhone|iPad|Bridge", name[1], re.I):
                continue
            dev = device[1]
            ip = subprocess.run(["/usr/sbin/ipconfig", "getifaddr", dev], capture_output=True, text=True)
            if ip.returncode == 0 and ip.stdout.strip():
                candidates.append((dev, ip.stdout.strip()))
    elif platform.system() == "Linux":
        for link in json.loads(run(["ip", "-j", "address", "show", "up"])):
            # iproute2 6.x can emit empty {} entries in its JSON output; skip them.
            dev = link.get("ifname")
            if not dev:
                continue
            physical = Path("/sys/class/net") / dev
            if not (physical / "device").exists() or (physical / "wireless").exists():
                continue
            for addr in link.get("addr_info", []):
                if addr.get("family") == "inet" and addr.get("scope") == "global":
                    candidates.append((dev, addr["local"]))
    else:
        raise RuntimeError("supported workers: Apple Silicon macOS or NVIDIA Linux")
    candidates = [(dev, ip) for dev, ip in candidates if not ipaddress.ip_address(ip).is_link_local]
    if interface:
        candidates = [(dev, ip) for dev, ip in candidates if dev == interface]
    if len(candidates) != 1:
        raise RuntimeError(f"select one active Ethernet interface in the manifest; found {candidates}")
    return candidates[0]


def facts(payload):
    interface, ip = wired_addresses(payload["member"].get("interface"))
    system = platform.system()
    if system == "Darwin":
        if platform.machine() != "arm64":
            raise RuntimeError("Intel Mac workers are not supported")
        memory = int(run(["sysctl", "-n", "hw.memsize"])) / 1024**3
        backend = "mlx"
    else:
        rows = run(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"]).splitlines()
        if len(rows) != 1:
            raise RuntimeError("this bootstrap supports one NVIDIA GPU per Linux member")
        memory = float(rows[0]) / 1024
        backend = "gpu"
    tools = {name: shutil.which(name) for name in ("git", "uv", "node", "pnpm", "protoc", "cargo")}
    node_major = int(run(["node", "--version"]).lstrip("v").split(".")[0]) if tools["node"] else 0
    return {"interface": interface, "ip": ip, "backend": backend, "memory_gb": memory,
            "tools": tools, "node_major": node_major, "home": str(Path.home()),
            "root": str(root_for(payload)), "disk_free_gb": shutil.disk_usage(Path.home()).free / 1024**3}


def app_paths(payload):
    root = root_for(payload)
    app = Path(payload.get("app", root / "app"))
    parallax = Path(payload["member"].get("parallax_dir", str(root / "parallax"))).expanduser()
    return root, app, parallax


def safe_member(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"unsafe archive entry: {name}")
    return path


def receive(payload, stream):
    """Only regular files, exactly those in the sender's manifest, with SHA-256 checks."""
    destination = Path(payload["destination"]).expanduser()
    expected = payload["files"]
    if destination.exists():
        raise RuntimeError(f"destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=".incoming-", dir=destination.parent))
    seen = set()
    try:
        with tarfile.open(fileobj=stream, mode="r|*") as archive:
            for entry in archive:
                safe_member(entry.name)
                if not entry.isfile() or entry.name not in expected or entry.name in seen:
                    raise ValueError(f"unexpected archive entry: {entry.name}")
                meta = expected[entry.name]
                if entry.size != meta["size"]:
                    raise ValueError(f"size mismatch: {entry.name}")
                target = temp / entry.name
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                with archive.extractfile(entry) as source, target.open("wb") as output:
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
                        output.write(chunk)
                if digest.hexdigest() != meta["sha256"]:
                    raise ValueError(f"SHA-256 mismatch: {entry.name}")
                target.chmod(meta.get("mode", 0o600) & 0o777)
                seen.add(entry.name)
        if seen != set(expected):
            raise ValueError("archive is incomplete")
        atomic_json(temp / ".bootstrap-files.json", expected)
        temp.replace(destination)
    finally:
        if temp.exists():
            shutil.rmtree(temp)
    return {"verified_files": len(seen)}


def deployment(payload):
    _, app, _ = app_paths(payload)
    if not app.exists():
        return {"exists": False}
    receipt = app / ".bootstrap-files.json"
    if not receipt.is_file():
        raise RuntimeError(f"refusing to replace an unrecognized application directory: {app}")
    files = json.loads(receipt.read_text())
    tree = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:16]
    if tree != payload["tree"]:
        raise RuntimeError("application source receipt differs")
    for name, meta in files.items():
        path = app / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != meta["size"] or hashlib.sha256(path.read_bytes()).hexdigest() != meta["sha256"]:
            raise RuntimeError(f"application source changed: {name}")
    return {"exists": True}


def prepare(payload):
    root, app, parallax = app_paths(payload)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    info = facts(payload)
    missing = [name for name in ("git", "uv", "node", "pnpm") if not info["tools"][name]]
    if missing or info["node_major"] < 24:
        raise RuntimeError(f"install prerequisites first: {missing}; Node >=24 required (found {info['node_major']})")
    log = root / "install.log"
    processes = run(["ps", "-axo", "pid=,command="])
    worker = re.compile(r"^\s*\d+\s+" + re.escape(str(parallax)) + r"/\.venv/bin/(?:python\S*|parallax|vllm-rs)(?:\s|$)", re.M)
    if worker.search(processes):
        raise RuntimeError(f"Parallax processes already use {parallax}; stop that pool before preparing (nothing was stopped)")
    if not parallax.exists():
        if not info["tools"]["protoc"] or not info["tools"]["cargo"]:
            raise RuntimeError("new Parallax installs need protoc and a Rust toolchain; see bootstrap documentation")
        install(["git", "clone", "https://github.com/GradientHQ/parallax.git", str(parallax)], log)
        install(["git", "-C", str(parallax), "checkout", "--detach", PARALLAX_REF], log)
    actual = run(["git", "-C", str(parallax), "rev-parse", "HEAD"])
    if actual != PARALLAX_REF:
        raise RuntimeError(f"Parallax revision {actual} != required {PARALLAX_REF}; existing installation untouched")
    if not (parallax / ".venv/bin/vllm-rs").exists() or not (parallax / ".venv/bin/parallax").exists():
        if not info["tools"]["protoc"] or not info["tools"]["cargo"]:
            raise RuntimeError("building Parallax requires protoc and Rust; bootstrap never invokes sudo")
        install(["bash", "install.sh", "--extras", "mac" if info["backend"] == "mlx" else "gpu", "--python", "3.12"], log, cwd=parallax)
    python = parallax / ".venv/bin/python"
    install(["uv", "pip", "install", "--python", str(python), "httpx[socks]>=0.26,<0.29"], log)
    cuda = ""
    if info["backend"] == "gpu":
        install(["uv", "pip", "install", "--python", str(python), "nvidia-cuda-nvcc==13.0.*",
                 "nvidia-cuda-cccl==13.0.*", "nvidia-nvvm==13.0.*", "nvidia-cuda-crt==13.0.*"], log)
        cuda = run([str(python), "-c", "import sysconfig; print(sysconfig.get_path('purelib') + '/nvidia/cu13')"])
        for name, target in (("lib64", "lib"), ("lib/libcudart.so", "libcudart.so.13")):
            link = Path(cuda) / name
            if not link.exists() and not link.is_symlink():
                link.symlink_to(target)
        if not (Path(cuda) / "bin/nvcc").is_file():
            raise RuntimeError("CUDA compiler was not installed")
    install(["uv", "sync", "--project", str(app / "node-agent"), "--locked"], log)
    # Fail if installed Parallax methods differ from those the hooks patch.
    env = {**os.environ, "PARALLAX_SRC": str(parallax)}
    install(["uv", "run", "--project", str(app / "node-agent"), "pytest",
             str(app / "pool/hooks/test_hooks.py"), "-q"], log, env=env)
    return {**info, "parallax": str(parallax), "cuda_home": cuda}


def env_file(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    # pool/*.env is read by bash. Node-agent values below do not contain shell quotes.
    path.write_text("".join(f"{key}={shlex.quote(str(value))}\n" for key, value in values.items()))
    path.chmod(0o600)


# SPEC §16.1 batching: Parallax node flags (pool/join-node.sh). The gateway sends node_batching in
# /provider/helper/config; these defaults apply when it does not. micro batch = 4 // 2 = 2, so one
# stage works on one micro-batch while the next stage works on the other.
BATCHING_DEFAULTS = {"max_batch_size": 4, "micro_batch_ratio": 2, "scheduler_wait_ms": 50}


def batching_env(batching):
    values = {**BATCHING_DEFAULTS, **(batching or {})}
    for key in ("max_batch_size", "micro_batch_ratio"):
        if not isinstance(values[key], int) or isinstance(values[key], bool) or values[key] < 1:
            raise ValueError(key + " must be a positive integer")
    if not isinstance(values["scheduler_wait_ms"], int) or isinstance(values["scheduler_wait_ms"], bool) or values["scheduler_wait_ms"] < 0:
        raise ValueError("scheduler_wait_ms must be a non-negative integer")
    return {"MAX_BATCH_SIZE": values["max_batch_size"], "MICRO_BATCH_RATIO": values["micro_batch_ratio"],
            "SCHEDULER_WAIT_MS": values["scheduler_wait_ms"]}


def configure(payload):
    root, app, parallax = app_paths(payload)
    member = payload["member"]
    info = payload["facts"]
    flags = ["--kv-cache-memory-fraction", "0.25", "--max-sequence-length", "4096"] if info["backend"] == "mlx" else []
    if member.get("param_mem_ratio") is not None:
        flags += ["--param-mem-ratio", str(member["param_mem_ratio"])]
    base = {"PARALLAX_DIR": str(parallax), "DHT_PREFIX": payload["dht_prefix"], "LAN_IP": info["ip"],
            "HF_HOME": str(root / "hf"), "HOOKS": 1, "NOTIFY_PORT": 5190,
            "EXTRA_FLAGS": " ".join(flags), "CUDA_HOME": info.get("cuda_home", ""),
            **batching_env(payload.get("batching"))}
    env_file(app / "pool/node.env", {**base, "ROLE": "node", "TCP_PORT": member["port"], "UDP_PORT": member["port"],
                                    "SCHEDULER_ADDR": payload.get("scheduler_addr", "")})
    if member["ssh"] == "local":
        env_file(app / "pool/scheduler.env", {**base, "ROLE": "scheduler", "MODEL": payload["model"],
                 "INIT_NODES": payload["member_count"], "TCP_PORT": payload["scheduler_port"],
                 "UDP_PORT": payload["scheduler_port"], "API_PORT": payload["api_port"],
                 "EXTRA_FLAGS": "--host 127.0.0.1", "NOTIFY_PORT": "",
                 # Scheduler hook: cap every node at ceil(layers / members) so all members get an equal share.
                 "EQUAL_LAYERS_NODES": payload["member_count"] if payload.get("equal_layers") else ""})
    agent = {"GATEWAY_URL": payload["gateway_url"], "FRONTEND_URL": payload["frontend_url"], "POOL_ID": payload["pool_id"],
             "NODE_KEY_PATH": str(root / "keys/node.key"),
             "IS_COORDINATOR": "true" if member["ssh"] == "local" else "false",
             "POOL_DIR": str(app / "pool"),
             "POOL_NODE_ENV": str(app / "pool/node.env"), "PARALLAX_NODE_LOG": str(app / "pool/logs/node.log"),
             "AUTO_RESTART": "false", "NOTIFY_PORT": "5190"}
    # The Python .env reader strips enclosing quotes, not bash escaping.
    for value in agent.values():
        if "\n" in value or "'" in value or '"' in value:
            raise ValueError("agent configuration cannot contain quotes or newlines")
    env_file(app / "node-agent/.env", agent)
    return {"configured": True}


def agent_env(app):
    env = dict(os.environ)
    # Do not inherit World/server credentials into the provider agent.
    for key in list(env):
        if key.startswith(("WORLD_", "SETTLER_", "X402_RELAYER_", "NEAR_GATEWAY_")) or key in ("JWT_SECRET", "GATEWAY_SIGNING_KEY", "TRANSCRIPT_KEY", "NEARAI_API_KEY"):
            env.pop(key)
    for line in (app / "node-agent/.env").read_text().splitlines():
        key, value = line.split("=", 1)
        env[key] = shlex.split(value)[0] if value else ""
    return env


def registration(payload):
    root, app, _ = app_paths(payload)
    script = """
import json
from ramx_node import keys, parallax
from ramx_node.config import load
from ramx_node.cli import cmd_init
cfg = load()
cmd_init(cfg)
"""
    return {"registration": run([str(app / "node-agent/.venv/bin/python"), "-c", script], env=agent_env(app))}


def registered(payload):
    _, app, _ = app_paths(payload)
    script = """
import time, httpx
from ramx_node import keys
from ramx_node.config import load
from ramx_node.signing import heartbeat_body, node_id, sign_body
c = load(); a = keys.load(c.node_key_path)
b = heartbeat_body(node_id(a), c.pool_id, int(time.time()*1000), False, None, None, None)
r = httpx.post(c.gateway_url+'/nodes/heartbeat', content=b, headers={'content-type':'application/json', 'x-ramx-node-signature':sign_body(a,b)}, timeout=10)
if r.status_code != 200: raise SystemExit('Node registration not ready: HTTP '+str(r.status_code))
"""
    run([str(app / "node-agent/.venv/bin/python"), "-c", script], env=agent_env(app))
    return {"registered": True}


def process_stamp(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], text=True, capture_output=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def alive(record):
    try:
        stamp = process_stamp(record["pid"])
        return bool(stamp) and stamp == record["stamp"] and os.getpgid(record["pid"]) == record["pid"]
    except ProcessLookupError:
        return False


def launch(root, name, args, cwd, env=None):
    record_path = root / f"{name}.process.json"
    if record_path.exists() and alive(json.loads(record_path.read_text())):
        return {"service": name, "already_running": True}
    with (root / f"{name}.log").open("ab") as log:
        process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True)
    time.sleep(0.5)
    if process.poll() is not None:
        raise RuntimeError(f"{name} exited; inspect {root / (name + '.log')}")
    atomic_json(record_path, {"pid": process.pid, "stamp": process_stamp(process.pid)})
    return {"service": name, "pid": process.pid}


def service(payload):
    root, app, _ = app_paths(payload)
    name = payload["service"]
    if name == "agent":
        # The existing agent defaults to singleton files in ~/.ramx. Isolate its state
        # for this bootstrap without changing the node-agent or any pre-existing agent.
        script = ("from pathlib import Path; from ramx_node import agent, cli; "
                  f"agent.STATE=Path({str(root / 'agent-state.json')!r}); "
                  f"agent.PID=Path({str(root / 'agent.pid')!r}); cli.main()")
        return launch(root, name, [str(app / "node-agent/.venv/bin/python"), "-c", script, "start", "--no-join"], app, agent_env(app))
    if name == "gateway":
        frontend = urllib.parse.urlparse(payload["frontend_url"])
        env = {**os.environ, "PORT": str(payload["gateway_port"]), "HOST": "0.0.0.0",
               "POOL_COORDINATOR_URL": f"http://127.0.0.1:{payload['api_port']}",
               "POOL_COORDINATORS": json.dumps({payload["pool_id"]: f"http://127.0.0.1:{payload['api_port']}"}),
               "POOL_COORDINATORS_FILE": "", "PARALLAX_ROUTE_LOG": str(app / "pool/run/routes.jsonl"),
               "PARALLAX_ALLOWED_PEERS_FILE": "", "VERIFICATION_ENABLED": "false", "DB_RESET_ON_MISMATCH": "false",
               "CORS_ORIGINS": f"{frontend.scheme}://{frontend.netloc}"}
        # The existing operator env file is never copied to another machine or printed.
        env_path = Path(payload["gateway_env"]).expanduser()
        if not env_path.is_file():
            raise RuntimeError(f"configure the coordinator gateway credentials at {env_path}; see gateway/.env.example")
        # Validate configuration without printing any values from the operator's file.
        check = (f"import {{loadConfig}} from {json.dumps(str(app / 'gateway/src/config.ts'))}; "
                 "const e=loadConfig().env; const required=['JWT_SECRET','GATEWAY_SIGNING_KEY','WORLD_APP_ID','WORLD_RP_ID','WORLD_RP_SIGNING_KEY']; "
                 "const missing=required.filter(k=>!e[k]); if(missing.length) throw Error('Missing gateway settings: '+missing.join(', '));")
        run(["node", f"--env-file={env_path}", "--input-type=module", "-e", check], cwd=env_path.parent, env=env)
        # Preserve the meaning of relative DATABASE_PATH in the existing operator env.
        return launch(root, name, ["node", f"--env-file={env_path}", str(app / "gateway/src/main.ts")], env_path.parent, env)
    if name in ("scheduler", "node"):
        pgid_path = app / f"pool/run/{name}.pgid"
        record_path = root / f"{name}.process.json"
        if record_path.exists() and alive(json.loads(record_path.read_text())):
            return {"service": name, "already_running": True}
        script = "start-scheduler.sh" if name == "scheduler" else "join-node.sh"
        output = run(["bash", str(app / "pool" / script)], timeout=20)
        pid = int(pgid_path.read_text())
        atomic_json(record_path, {"pid": pid, "stamp": process_stamp(pid)})
        return {"service": name, "pid": pid, "output": output}
    raise ValueError("unknown service")


def stop(payload):
    root, _, _ = app_paths(payload)
    # Only our recorded groups. Never use the existing machine-wide stop-all sweep.
    for name in ("agent", "node", "scheduler", "gateway"):
        record_path = root / f"{name}.process.json"
        if not record_path.exists():
            continue
        record = json.loads(record_path.read_text())
        if alive(record):
            pid = record["pid"]
            # Parallax's CLI can create another session for its backend. Include those
            # descendant groups, rather than assuming every child shares the CLI PGID.
            rows = [line.split() for line in run(["ps", "-axo", "pid=,ppid=,pgid="]).splitlines()]
            tree = {pid}
            while True:
                expanded = tree | {int(row[0]) for row in rows if len(row) == 3 and int(row[1]) in tree}
                if expanded == tree:
                    break
                tree = expanded
            groups = {}
            for child, _, group in rows:
                if int(child) in tree:
                    groups.setdefault(int(group), {})[int(child)] = process_stamp(int(child))

            def still_owned(group):
                return any(stamp and process_stamp(child) == stamp for child, stamp in groups[group].items())

            for group in groups:
                if still_owned(group):
                    try:
                        os.killpg(group, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and any(still_owned(group) for group in groups):
                time.sleep(0.25)
            for group in groups:
                if still_owned(group):
                    try:
                        os.killpg(group, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        record_path.unlink()
    return {"stopped": True, "listings": "Directory listings expire when the node stops sending heartbeats"}


def status(payload):
    root, app, _ = app_paths(payload)
    services = {}
    for path in root.glob("*.process.json"):
        services[path.name.split(".")[0]] = alive(json.loads(path.read_text()))
    assignment = None
    if (app / "node-agent/.venv/bin/python").exists():
        script = "import json; from dataclasses import asdict; from ramx_node.parallax import read_assignment; from pathlib import Path; print(json.dumps(asdict(read_assignment(Path('pool/logs/node.log')))))"
        assignment = json.loads(run([str(app / "node-agent/.venv/bin/python"), "-c", script], cwd=app))
    return {"services": services, "assignment": assignment}


def snapshot_files(snapshot):
    out = {}
    for path in sorted(snapshot.rglob("*")):
        if path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
            out[path.relative_to(snapshot).as_posix()] = {"size": path.stat().st_size, "sha256": digest.hexdigest()}
    return out


def download(payload):
    root, _, parallax = app_paths(payload)
    cache = root / "hf/hub"
    script = """
import json, sys
from huggingface_hub import snapshot_download
print(json.dumps({'snapshot': snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], cache_dir=sys.argv[3])}))
"""
    result = json.loads(run([str(parallax / ".venv/bin/python"), "-c", script, payload["repo"], payload.get("revision", "main"), str(cache)]))
    snapshot = Path(result["snapshot"])
    if not re.fullmatch(r"[a-f0-9]{40}", snapshot.name):
        raise RuntimeError("Hugging Face did not resolve a full immutable model revision")
    files = snapshot_files(snapshot)
    if "config.json" not in files or not any(name.endswith(".safetensors") for name in files):
        raise RuntimeError("download is not a complete safetensors model snapshot")
    refs = snapshot.parents[1] / "refs"
    refs.mkdir(exist_ok=True)
    (refs / "main").write_text(snapshot.name)
    return {"snapshot": str(snapshot), "revision": snapshot.name, "files": files}


def cached(payload):
    root, _, _ = app_paths(payload)
    folder = root / "hf/hub" / ("models--" + payload["repo"].replace("/", "--"))
    snapshot = folder / "snapshots" / payload["revision"]
    if not snapshot.exists():
        return {"cached": False, "destination": str(folder)}
    if snapshot_files(snapshot) != payload["files"]:
        raise RuntimeError("existing model snapshot failed verification; refusing to overwrite it")
    if (folder / "refs/main").read_text().strip() != payload["revision"]:
        raise RuntimeError("model cache main reference differs from the locked revision")
    return {"cached": True, "destination": str(folder)}


def main():
    os.environ["PATH"] = os.pathsep.join([str(Path.home() / ".local/bin"), str(Path.home() / ".cargo/bin"),
                                          "/opt/homebrew/bin", "/usr/local/bin", os.environ.get("PATH", "")])
    payload = json.loads(sys.stdin.buffer.readline())
    action = sys.argv[1]
    actions = {"facts": facts, "prepare": prepare, "configure": configure, "registration": registration,
               "registered": registered, "service": service, "stop": stop, "status": status,
               "download": download, "cached": cached, "deployment": deployment}
    result = receive(payload, sys.stdin.buffer) if action == "receive" else actions[action](payload)
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"bootstrap: {error}", file=sys.stderr)
        sys.exit(1)
