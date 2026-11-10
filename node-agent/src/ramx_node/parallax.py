"""What the node agent learns from its local Parallax process (read-only; Parallax is not modified).

Layer range (route source, SPEC §5.5): Parallax `/cluster/status_json` has no layer ranges, but
`parallax join` logs its assignment (Parallax 162354a):
  - src/parallax/p2p/server.py:537  INFO  "Join scheduler response: {'node_id': '<peer>', 'model_name': '...',
                                           'start_layer': 29, 'end_layer': 40, ...}"   (first assignment)
  - src/parallax/p2p/server.py:794  WARN  "Layer allocation changed! Current: [a, b) -> New: [s, e) Model: X -> Y"
  - src/parallax/launch.py:293       INFO  "Reloading executor with layers [s, e)"   (after a re-placement)
The LAST of these lines in the node log is the current range. Lines carry ANSI colour codes.
"""
from __future__ import annotations

import ast
import platform
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;]*m")
JOIN = re.compile(r"Join scheduler response: (\{.*\})")
CHANGED = re.compile(r"Layer allocation changed!.*New: \[(\d+), (\d+)\) Model: .* -> (\S+)")
RELOAD = re.compile(r"Reloading executor with layers \[(\d+), (\d+)\)")
# pool/lib.sh start_group writes this line before each start: older lines belong to a dead process.
START = "=== ramx start"
TAIL_BYTES = 4 * 1024 * 1024


@dataclass
class Assignment:
    layers: list[int] | None = None
    model: str | None = None
    peer_id: str | None = None
    max_seq: int | None = None


def parse_log(text: str) -> Assignment:
    a = Assignment()
    for line in ANSI.sub("", text).splitlines():
        if line.startswith(START):
            a = Assignment()  # new process: forget the old assignment (no stale layers while loading)
        elif line.startswith("ramx max_seq="):
            value = line.split("=", 1)[1]
            a.max_seq = int(value) if value.isdigit() and int(value) > 0 else None
        elif m := JOIN.search(line):
            try:
                d = ast.literal_eval(m.group(1))
            except (ValueError, SyntaxError):
                continue
            if isinstance(d, dict) and d.get("start_layer") is not None and d.get("end_layer") is not None:
                a = Assignment([int(d["start_layer"]), int(d["end_layer"])], d.get("model_name"), d.get("node_id"), a.max_seq)
        elif m := CHANGED.search(line):
            a = Assignment([int(m.group(1)), int(m.group(2))], m.group(3), a.peer_id, a.max_seq)
        elif m := RELOAD.search(line):
            a = Assignment([int(m.group(1)), int(m.group(2))], a.model, a.peer_id, a.max_seq)
    return a


def read_assignment(log: Path) -> Assignment:
    if not log.exists():
        return Assignment()
    with log.open("rb") as f:
        size = log.stat().st_size
        f.seek(max(0, size - TAIL_BYTES))
        return parse_log(f.read().decode("utf-8", "replace"))


def read_peer_id(path: Path) -> str | None:
    """This node's current Parallax peer ID, written by pool/hooks before the join (P5.4)."""
    try:
        v = path.read_text().strip()
    except OSError:
        return None
    return v or None


def node_running() -> bool:
    """A `parallax join` process exists on this machine."""
    return subprocess.run(["pgrep", "-f", "parallax join"], capture_output=True).returncode == 0


def detect_gpu() -> tuple[str, float]:
    """(gpu name, memory GB). NVIDIA: nvidia-smi. Mac: chip name + unified memory. Else CPU + RAM."""
    if shutil.which("nvidia-smi"):
        r = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            name, mib = [x.strip() for x in r.stdout.strip().splitlines()[0].split(",")]
            return name, round(float(mib) / 1024, 1)
    if platform.system() == "Darwin":
        chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip() or "Apple Silicon"
        mem = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip() or 0)
        return chip, round(mem / 2**30, 1)
    pages = Path("/proc/meminfo").read_text().split("\n")[0].split()[1] if Path("/proc/meminfo").exists() else "0"
    return platform.processor() or "cpu", round(int(pages) / 2**20, 1)
