"""Machine checks for the node agent (post-MVP P5.6 network address, P5.7 memory)."""
from __future__ import annotations

import platform
import re
import socket
import subprocess
import time
import hashlib
import json
from collections import deque
from pathlib import Path
from urllib.parse import urlparse

# ---------- P5.6: LAN IP ----------


def current_lan_ip(gateway_url: str) -> str | None:
    """The local IPv4 address used to reach the gateway (no packet is sent: UDP connect only)."""
    host = urlparse(gateway_url).hostname or "8.8.8.8"
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((host, 9))
        ip = s.getsockname()[0]
        return None if ip.startswith("127.") or ip == "0.0.0.0" else ip
    except OSError:
        return None
    finally:
        s.close()


def env_value(node_env: Path, key: str) -> str | None:
    """One KEY=value from pool/node.env (comments and quotes removed)."""
    try:
        for line in node_env.read_text().splitlines():
            if line.startswith(f"{key}="):
                v = line.split("=", 1)[1].split("#", 1)[0].strip().strip('"').strip("'")
                return v or None
    except OSError:
        return None
    return None


def configured_lan_ip(node_env: Path) -> str | None:
    """LAN_IP from pool/node.env (what Parallax announces)."""
    return env_value(node_env, "LAN_IP")


# ---------- SPEC §16.1 automatic pool formation: delay to other nodes ----------

def tcp_rtt_ms(ip: str, port: int, timeout: float = 1.0) -> float | None:
    """Round trip of a TCP connect to ip:port. A refused connection still answers (RST), so it also
    measures the delay. No answer within `timeout` = None (not reachable / filtered)."""
    t0 = time.perf_counter()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((ip, port))
    except ConnectionRefusedError:
        pass
    except OSError:
        return None
    finally:
        s.close()
    return round((time.perf_counter() - t0) * 1000, 3)


def measure_rtts(probe: list[dict], tries: int = 3) -> dict[str, float]:
    """node_id → best of `tries` connect round trips (ms) for the peers the gateway asked about."""
    out: dict[str, float] = {}
    for p in probe:
        vals = [v for v in (tcp_rtt_ms(p["lan_ip"], int(p["port"])) for _ in range(tries)) if v is not None]
        if vals:
            out[p["node_id"]] = min(vals)
    return out


# ---------- P5.7: memory ----------

def parse_mac_swapusage(text: str) -> float | None:
    """`sysctl -n vm.swapusage` → used MB. Example: 'total = 2048.00M  used = 1024.50M  free = ...'."""
    m = re.search(r"used = ([0-9.]+)([MG])", text)
    if not m:
        return None
    v = float(m.group(1))
    return v * 1024 if m.group(2) == "G" else v


def parse_meminfo_swap(text: str) -> float | None:
    """/proc/meminfo → used swap MB."""
    vals = {}
    for line in text.splitlines():
        k, _, rest = line.partition(":")
        if k in ("SwapTotal", "SwapFree"):
            vals[k] = int(rest.split()[0])
    if len(vals) != 2:
        return None
    return (vals["SwapTotal"] - vals["SwapFree"]) / 1024


def swap_used_mb() -> float | None:
    try:
        if platform.system() == "Darwin":
            return parse_mac_swapusage(subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout)
        return parse_meminfo_swap(Path("/proc/meminfo").read_text())
    except OSError:
        return None


def usable_mem_gb(mem_gb: float, is_mac: bool) -> float:
    """Memory the model may use: Macs keep max(4 GB, 25%) for macOS and apps (unified memory)."""
    if not is_mac:
        return mem_gb  # dedicated VRAM
    return round(max(0.0, mem_gb - max(4.0, 0.25 * mem_gb)), 1)


def capability_challenge(challenge_id: str, seed: str, gpu: str, memory_gb: float, node_env: Path) -> dict:
    """Run a small real-backend matmul challenge inside Parallax's runtime; cap work and memory."""
    values = {}
    try:
        for line in node_env.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep:
                values[key.strip()] = value.split("#", 1)[0].strip().strip('"').strip("'")
    except OSError:
        pass
    parallax_dir = Path(values.get("PARALLAX_DIR", "")).expanduser()
    python = parallax_dir / ".venv" / "bin" / "python"
    if not python.is_file():
        python = Path("/usr/bin/python3")
    script = r'''import hashlib, json, platform, sys, time
seed = int(sys.argv[1], 16)
start = time.perf_counter()
backend = "unavailable"
memory = 0.0
state = seed & 0xffffffff
def matrix():
    global state
    out = []
    for _ in range(64 * 64):
        state = (1664525 * state + 1013904223) & 0xffffffff
        out.append(state % 31 - 15)
    return [out[i:i+64] for i in range(0, len(out), 64)]
av, bv = matrix(), matrix()
values = []
try:
    if platform.system() == "Darwin":
        import mlx.core as mx
        backend = "mlx"
        a = mx.array(av, dtype=mx.float32)
        b = mx.array(bv, dtype=mx.float32)
        for _ in range(4):
            c = a @ b
            mx.eval(c)
        values = [int(round(float(x))) for x in c.reshape((-1,))[:16].tolist()]
    else:
        import torch
        if torch.cuda.is_available():
            backend = "cuda"
            device = torch.device("cuda:0")
            memory = torch.cuda.get_device_properties(device).total_memory / (1024 ** 3)
            a = torch.tensor(av, dtype=torch.float32, device=device)
            b = torch.tensor(bv, dtype=torch.float32, device=device)
            for _ in range(4): c = a @ b
            torch.cuda.synchronize()
            values = [int(round(float(x))) for x in c.flatten()[:16].cpu().tolist()]
except Exception as e:
    print(json.dumps({"backend":"unavailable","memory_gb":memory,"error":type(e).__name__}))
    raise SystemExit(0)
elapsed = max(1, int((time.perf_counter() - start) * 1000))
if backend == "mlx": memory = float(sys.argv[2])
out = hashlib.sha256(json.dumps(values, separators=(",", ":")).encode()).hexdigest()
print(json.dumps({"backend":backend,"memory_gb":round(memory,1),"elapsed_ms":elapsed,"output_hash":"0x"+out}))
'''
    try:
        proc = subprocess.run([str(python), "-c", script, seed.removeprefix("0x"), str(memory_gb)], capture_output=True, text=True, timeout=45)
        body = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else {}
        backend = body.get("backend", "unavailable")
        result_memory = float(body.get("memory_gb", memory_gb if backend == "mlx" else 0))
        elapsed = int(body.get("elapsed_ms", 0))
        output_hash = body.get("output_hash", "0x" + "0" * 64)
    except (OSError, subprocess.TimeoutExpired, ValueError, json.JSONDecodeError):
        backend, result_memory, elapsed, output_hash = "unavailable", 0.0, 60_000, "0x" + "0" * 64
    result_hash = hashlib.sha256(f"{challenge_id}:{seed}:{backend}:{elapsed}:{output_hash}".encode()).hexdigest()
    return {"challenge_id": challenge_id, "backend": backend, "memory_gb": round(result_memory, 1), "elapsed_ms": elapsed,
            "output_hash": output_hash, "result_hash": "0x" + result_hash}


def mem_pressure(swap: "SwapWatch", serving: bool, system_name: str | None = None) -> str | None:
    """P5.7 swap watch, for unified-memory (macOS / MLX) nodes only. On CUDA nodes the weights and KV
    cache live in VRAM, so host swap (browser, gateway, other apps) does not slow inference and must
    not take the pool out of routing: report "ok"."""
    if (system_name or platform.system()) != "Darwin":
        return "ok"
    return swap.sample(swap_used_mb(), serving)


class SwapWatch:
    """"swap_growing" when swap use rose by more than `growth_mb` within `window_s` while serving."""

    def __init__(self, growth_mb: float, window_s: float) -> None:
        self.growth_mb = growth_mb
        self.window_s = window_s
        self.samples: deque[tuple[float, float]] = deque()

    def sample(self, used_mb: float | None, serving: bool, now: float | None = None) -> str | None:
        if used_mb is None:
            return None
        now = time.monotonic() if now is None else now
        if not serving:
            self.samples.clear()
            return "ok"
        self.samples.append((now, used_mb))
        while self.samples and now - self.samples[0][0] > self.window_s:
            self.samples.popleft()
        low = min(u for _, u in self.samples)
        return "swap_growing" if used_mb - low > self.growth_mb else "ok"
