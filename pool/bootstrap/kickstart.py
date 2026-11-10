#!/usr/bin/env python3
"""Coordinator-side pool bootstrap. See docs/POOL-KICKSTART.md before live use."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request

import host

REPO = Path(__file__).resolve().parents[2]
HOST_SOURCE = Path(__file__).with_name("host.py").read_text()
TRANSPORT_IPS = {}


def manifest(path):
    config = json.loads(path.read_text())
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", config.get("pool_id", "")):
        raise ValueError("pool_id must contain 1–64 letters, digits, underscores or hyphens")
    if config["pool_id"] == "auto":
        raise ValueError("choose an explicit pool_id; 'auto' is reserved for gateway-managed formation")
    catalog = json.loads((REPO / "shared/config/ramx.config.json").read_text())["models"]
    model = next((m for m in catalog if m["model_id"] == config.get("model")), None)
    if not model:
        raise ValueError("model must already be in shared/config/ramx.config.json and Parallax's catalog")
    members = config.get("members", [])
    if not 2 <= len(members) <= 16 or members[0].get("ssh") != "local":
        raise ValueError("first member must be the local coordinator; supply 2–16 members including it")
    if len({m.get("name") for m in members}) != len(members) or len({m.get("ssh") for m in members}) != len(members):
        raise ValueError("member names and SSH destinations must be unique")
    for index, member in enumerate(members):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", member.get("name", "")):
            raise ValueError("every member needs a simple unique name")
        target = member.get("ssh", "")
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@-]*", target) or (index and target == "local"):
            raise ValueError("ssh must be a configured SSH alias or user@hostname (no shell options)")
        if "param_mem_ratio" in member and not 0 < member["param_mem_ratio"] < 1:
            raise ValueError("param_mem_ratio must be between 0 and 1")
        member.setdefault("port", 5101 + index)
    for name, default in (("scheduler_port", 5100), ("api_port", 3001), ("gateway_port", 8080)):
        config.setdefault(name, default)
    ports = [config[k] for k in ("scheduler_port", "api_port", "gateway_port")] + [m["port"] for m in members]
    if any(type(port) is not int or not 1024 <= port <= 65535 for port in ports) or len(set(ports)) != len(ports):
        raise ValueError("bootstrap ports must be distinct integers in 1024–65535")
    frontend = urllib.parse.urlparse(config.get("frontend_url", ""))
    if frontend.scheme not in ("http", "https") or not frontend.hostname or frontend.username or frontend.password:
        raise ValueError("frontend_url must be the actual marketplace URL, without credentials")
    config.setdefault("gateway_env", "gateway/.env")
    if config.get("gateway_url"):
        gateway = urllib.parse.urlparse(config["gateway_url"])
        if gateway.scheme not in ("http", "https") or not gateway.hostname or gateway.username or gateway.password:
            raise ValueError("gateway_url must be an HTTP(S) URL without credentials")
    for revision in config.get("model_revisions", {}).values():
        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise ValueError("model_revisions must contain full Hugging Face commit hashes")
    env = Path(config["gateway_env"]).expanduser()
    config["gateway_env"] = str(env if env.is_absolute() else REPO / env)
    return config, model


def command(member, action):
    if member["ssh"] == "local":
        return [sys.executable, str(Path(__file__).with_name("host.py")), action]
    remote = shlex.join(["python3", "-c", HOST_SOURCE, action])
    args = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"]
    if action not in ("facts", "status", "stop") and member["name"] in TRANSPORT_IPS:
        # Use the discovered WIRED address for all subsequent traffic, retaining the
        # originally paired host-key identity and SSH alias/user/key configuration.
        settings = subprocess.run(["ssh", "-G", member["ssh"]], text=True, capture_output=True, check=True)
        settings = dict(line.split(" ", 1) for line in settings.stdout.splitlines() if " " in line)
        identity = settings.get("hostkeyalias", settings["hostname"])
        args += ["-o", "Hostname=" + TRANSPORT_IPS[member["name"]], "-o", "HostKeyAlias=" + identity]
    return args + [member["ssh"], remote]


def call(member, action, payload, timeout=60):
    result = subprocess.run(command(member, action), input=json.dumps(payload) + "\n", text=True,
                            capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{member['name']}: {result.stderr.strip()[-2000:]}")
    try:
        return json.loads(result.stdout)
    except ValueError as error:
        raise RuntimeError(f"{member['name']}: host did not return valid JSON; check SSH shell startup output") from error


def parallel(members, function):
    # Inspect all results, including failures; never leave an unobserved install running.
    results, failures = {}, []
    with ThreadPoolExecutor(max_workers=len(members)) as executor:
        futures = {m["name"]: executor.submit(function, m) for m in members}
        for name, future in futures.items():
            try:
                results[name] = future.result()
            except Exception as error:
                failures.append(str(error))
    if failures:
        raise RuntimeError("\n".join(failures))
    return results


def payload_for(config, member, state=None):
    result = {**config, "member": member, "member_count": len(config["members"])}
    if state:
        info = state["hosts"][member["name"]]
        result.update(facts=info, app=info["app"], coordinator=state["hosts"][config["members"][0]["name"]],
                      dht_prefix=state["dht_prefix"], gateway_url=state["gateway_url"])
    return result


def inspect(config):
    return parallel(config["members"], lambda m: call(m, "facts", payload_for(config, m)))


def file_metadata(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return {"size": path.stat().st_size, "sha256": digest.hexdigest(), "mode": path.stat().st_mode & 0o777}


def source_files():
    result = subprocess.run(["git", "ls-files", "-z"], cwd=REPO, capture_output=True, check=True)
    paths = set(result.stdout.decode().split("\0")) - {""}
    paths.update(str(p.relative_to(REPO)) for p in (REPO / "pool/bootstrap").glob("*.py"))
    paths.add("pool/kickstart.sh")
    output = {}
    for name in sorted(paths):
        path = REPO / name
        # Only source, never local env files, model caches, wallet keys, git state or dependencies.
        if path.is_symlink():
            raise ValueError(f"refusing to deploy source symlink: {name}")
        if path.is_file() and not any(part in ("node_modules", ".git", ".venv", "__pycache__") for part in path.parts):
            if (path.name.startswith(".env") and path.name != ".env.example") or path.suffix in (".env", ".key", ".pem", ".db", ".sqlite", ".sqlite3") or path.name == "keys.txt":
                continue
            output[name] = file_metadata(path)
    return output


def transfer(member, payload, destination, files, path_for):
    request = {**payload, "destination": destination, "files": files}
    process = subprocess.Popen(command(member, "receive"), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        process.stdin.write((json.dumps(request) + "\n").encode())
        with tarfile.open(fileobj=process.stdin, mode="w|") as archive:
            for name, meta in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = meta["size"]
                entry.mode = meta.get("mode", 0o600)
                with path_for(name).open("rb") as source:
                    archive.addfile(entry, source)
        process.stdin.close()
        process.stdin = None
        stdout, stderr = process.communicate()
    except BaseException:
        process.kill()
        process.communicate()
        raise
    if process.returncode:
        raise RuntimeError(f"{member['name']}: transfer failed: {stderr.decode()[-1500:]}")
    return json.loads(stdout)


def get_json(url, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def wait_for(description, function, seconds):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            result = function()
            if result:
                return result
        except (OSError, ValueError, RuntimeError) as error:
            last = str(error)
        time.sleep(2)
    raise RuntimeError(f"timed out waiting for {description}" + (f": {last}" if last else ""))


def prepare(config, model, state, save):
    facts = inspect(config)
    if len({info["ip"] for info in facts.values()}) != len(facts):
        raise RuntimeError("two member destinations resolve to the same Ethernet address")
    TRANSPORT_IPS.update({name: info["ip"] for name, info in facts.items()})
    frontend = urllib.parse.urlparse(config["frontend_url"]).hostname
    if frontend.endswith(".example"):
        raise ValueError("replace frontend_url with the real marketplace URL")
    source = source_files()
    tree = hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest()[:16]
    for member in config["members"]:
        info = facts[member["name"]]
        info["app"] = str(Path(info["root"]) / f"app-{tree}")
        # Existing immutable deployments are reused only if their source receipt matches.
        remote = call(member, "status", {**payload_for(config, member), "app": info["app"]})
        if any(remote["services"].values()):
            raise RuntimeError("stop this managed pool with down before preparing it again")
        deployed = call(member, "deployment", {**payload_for(config, member), "app": info["app"], "tree": tree})
        if not deployed["exists"]:
            print(f"{member['name']}: copying application source", flush=True)
            transfer(member, payload_for(config, member), info["app"], source, lambda name: REPO / name)
    state.update(hosts=facts, dht_prefix=state.get("dht_prefix", "gp-" + secrets.token_hex(12)),
                 gateway_url=config.get("gateway_url", f"http://{facts[config['members'][0]['name']]['ip']}:{config['gateway_port']}"),
                 phase="installing", preparation_complete=False)
    save()
    print("Installing/checking dependencies on all hosts; per-host install.log records progress.", flush=True)
    installed = parallel(config["members"], lambda m: call(m, "prepare", payload_for(config, m, state), timeout=7200))
    for name, info in installed.items():
        state["hosts"][name].update(info)
    # Read directory connection settings only. Never ship the operator's signer to members.
    env_file = Path(config["gateway_env"])
    tls = {}
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            key, value = line.split("=", 1)
            if key.strip() in ("TLS_CERT_FILE", "TLS_KEY_FILE"):
                tls[key.strip()] = value.strip().strip("\"'")
    if all(tls.get(key) for key in ("TLS_CERT_FILE", "TLS_KEY_FILE")) and not config.get("gateway_url"):
        raise ValueError("TLS is configured: supply gateway_url with the HTTPS hostname matching the certificate")
    coordinator = config["members"][0]
    variants = {model["model_id"]}
    if any(info["backend"] == "mlx" for info in facts.values()):
        if not model.get("mlx_variant"):
            raise ValueError("model has no MLX variant for the Apple members")
        variants.add(model["mlx_variant"])
    locks = state.setdefault("models", {})
    for repo in sorted(variants):
        print(f"coordinator: downloading/verifying {repo} (once per format)", flush=True)
        revision = locks.get(repo, {}).get("revision", config.get("model_revisions", {}).get(repo, "main"))
        locks[repo] = call(coordinator, "download", {**payload_for(config, coordinator, state), "repo": repo, "revision": revision}, timeout=7200)
        save()
    for member in config["members"][1:]:
        repo = model["mlx_variant"] if facts[member["name"]]["backend"] == "mlx" else model["model_id"]
        lock = locks[repo]
        payload = {**payload_for(config, member, state), "repo": repo, **lock}
        cached = call(member, "cached", payload, timeout=7200)
        if cached["cached"]:
            print(f"{member['name']}: verified existing snapshot", flush=True)
            continue
        required = sum(meta["size"] for meta in lock["files"].values())
        if facts[member["name"]]["disk_free_gb"] * 1024**3 < required * 1.1:
            raise RuntimeError(f"{member['name']}: insufficient model disk space")
        print(f"{member['name']}: streaming {repo} over SSH/Ethernet; verifying SHA-256", flush=True)
        # A valid HF cache needs refs/main plus snapshots/<exact commit>. No token/cache credentials.
        files = {f"snapshots/{lock['revision']}/{name}": meta for name, meta in lock["files"].items()}
        ref = Path(lock["snapshot"]).parents[1] / "refs/main"
        files["refs/main"] = file_metadata(ref)
        snapshot = Path(lock["snapshot"])
        transfer(member, payload, cached["destination"], files,
                 lambda name: ref if name == "refs/main" else snapshot / snapshot_tail(name))
    parallel(config["members"], lambda m: call(m, "configure", payload_for(config, m, state)))
    state["phase"] = "prepared"
    state["preparation_complete"] = True
    save()
    print("Prepared. Next: register (starts the gateway and prints each owner's registration link).", flush=True)


def snapshot_tail(name):
    return "/".join(name.split("/")[2:])


def service(config, state, member, name):
    return call(member, "service", {**payload_for(config, member, state), "service": name}, timeout=30)


def gateway(config, state):
    coordinator = config["members"][0]
    result = service(config, state, coordinator, "gateway")
    print(json.dumps(result), flush=True)
    wait_for("gateway health", lambda: get_json(state["gateway_url"].rstrip("/") + "/healthz").get("ok"), 20)


def register(config, state):
    gateway(config, state)
    for member in config["members"]:
        print(f"\n{member['name']}:\n" + call(member, "registration", payload_for(config, member, state))["registration"], flush=True)


def up(config, state, save):
    current = inspect(config)
    if any(current[name]["ip"] != info["ip"] for name, info in state["hosts"].items()):
        raise RuntimeError("an Ethernet address changed; run down, then prepare again")
    gateway(config, state)
    # This gate is before expensive model startup. Missing World registration is never bypassed.
    parallel(config["members"], lambda m: call(m, "registered", payload_for(config, m, state)))
    coordinator = config["members"][0]
    service(config, state, coordinator, "scheduler")
    log = Path(state["hosts"][coordinator["name"]]["app"]) / "pool/logs/scheduler.log"

    def scheduler_address():
        text = log.read_text() if log.exists() else ""
        text = text.rsplit("=== ramx start scheduler", 1)[-1]
        peers = re.findall(r"Stored scheduler peer id: (12D3\w+)", text)
        return f"/ip4/{state['hosts'][coordinator['name']]['ip']}/tcp/{config['scheduler_port']}/p2p/{peers[-1]}" if peers else None

    address = wait_for("fresh scheduler identity", scheduler_address, 60)
    parallel(config["members"], lambda m: call(m, "configure", {**payload_for(config, m, state), "scheduler_addr": address}))
    print("Starting agents, then releasing all prepared worker joins together.", flush=True)
    parallel(config["members"], lambda m: service(config, state, m, "agent"))
    parallel(config["members"], lambda m: service(config, state, m, "node"))
    api = f"http://127.0.0.1:{config['api_port']}"

    def ready():
        data = get_json(api + "/cluster/status_json")["data"]
        return data if (data.get("max_running_request", 0) > 0 and not data.get("need_more_nodes")
                        and len(data.get("node_list", [])) == len(config["members"])) else None

    cluster = wait_for("an executable Parallax pipeline", ready, 600)
    print("Pipeline ready; running a short private warm-up.", flush=True)
    completion = get_json(api + "/v1/chat/completions", {"model": config["model"], "messages": [{"role": "user", "content": "Reply with a short greeting."}],
                          "max_tokens": 16, "temperature": 0, "stream": False,
                          "chat_template_kwargs": {"enable_thinking": False}}, timeout=120)
    if not completion.get("usage", {}).get("completion_tokens") or not completion.get("choices"):
        raise RuntimeError("warm-up returned no measured output")
    gw = state["gateway_url"].rstrip("/")

    def advertised():
        pool = get_json(gw + "/pools/" + config["pool_id"])
        models = get_json(gw + "/v1/models")
        network = get_json(gw + "/network")
        listed = any(p["pool_id"] == config["pool_id"] and p["status"] == "ready" and config["model"] in p["models"]
                     for p in network.get("pools", []))
        return pool if (listed and pool.get("status") == "ready"
                        and any(m["id"] == config["model"] for m in models.get("data", []))) else None

    pool = wait_for("fresh signed heartbeats and marketplace discovery", advertised, 180)
    workers = parallel(config["members"], lambda m: call(m, "status", payload_for(config, m, state)))
    if any(not info["services"].get("node") or not info["services"].get("agent") for info in workers.values()):
        raise RuntimeError("a worker or agent exited during startup; inspect status/logs before retrying")
    state.update(phase="ready", scheduler_addr=address, evidence={"cluster": cluster, "pool": pool, "warmup_usage": completion["usage"], "ts": int(time.time() * 1000)})
    save()
    print("READY: inference passed and the marketplace advertises the model. No paid request was sent.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "doctor", "setup", "prepare", "register", "up", "status", "down"))
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    config, model = manifest(args.manifest)
    if args.action == "plan":
        print(json.dumps({"pool": config["pool_id"], "model": model, "members": config["members"],
              "phases": ["doctor", "prepare: install, resolve Ethernet, download, verify and distribute", "register: gateway + owner consent", "up: simultaneous joins + warm-up + marketplace discovery"],
              "parallax_revision": host.PARALLAX_REF, "remote_transport": "SSH keys with strict host verification"}, indent=2))
        return
    state_dir = REPO / "pool/run/kickstart" / config["pool_id"]
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state_dir / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = state_dir / "state.json"
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        TRANSPORT_IPS.update({name: info["ip"] for name, info in state.get("hosts", {}).items()})
        digest = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
        if state.get("config_hash") not in (None, digest):
            raise RuntimeError("manifest changed; use the original manifest to down, then a new pool_id for the new configuration")
        state["config_hash"] = digest
        save = lambda: host.atomic_json(state_path, state)
        if args.action == "doctor":
            print(json.dumps(inspect(config), indent=2))
        elif args.action in ("prepare", "setup"):
            prepare(config, model, state, save)
            if args.action == "setup":
                register(config, state)
                print("Waiting up to 15 minutes for owners to verify and register their nodes.", flush=True)

                def owners_ready():
                    parallel(config["members"], lambda m: call(m, "registered", payload_for(config, m, state)))
                    return True

                wait_for("node-owner registrations", owners_ready, 900)
                up(config, state, save)
        else:
            if state.get("phase") not in ("prepared", "ready"):
                if args.action not in ("down", "status") or not state.get("hosts"):
                    raise RuntimeError("run prepare successfully first")
            if args.action == "register":
                register(config, state)
            elif args.action == "up":
                up(config, state, save)
            elif args.action == "status":
                print(json.dumps(parallel(config["members"], lambda m: call(m, "status", payload_for(config, m, state))), indent=2))
            elif args.action == "down":
                print(json.dumps(parallel(config["members"], lambda m: call(m, "stop", payload_for(config, m, state), timeout=180)), indent=2))
                state["phase"] = "prepared" if state.get("preparation_complete") else "installing"
                save()


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(f"kickstart: {error}", file=sys.stderr)
        sys.exit(1)
