"""Count the Parallax sessions this node serves (post-MVP P5.9 coordinator cross-check).

pool/join-node.sh starts Parallax with --notify-url http://127.0.0.1:NOTIFY_PORT/notify. For each
forward batch Parallax posts [{"session_id", "step_id", "block_idx", "total_blocks", "status"}, ...]
(Parallax 162354a, src/parallax/p2p/server.py send_notify). One session = one request routed through
this node. The agent reports the number of NEW distinct sessions in each signed heartbeat; the
gateway compares it with the scheduler's routes.
"""
from __future__ import annotations

import json
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEEP = 20_000  # session IDs remembered for de-duplication


class SessionCounter:
    def __init__(self) -> None:
        self._seen: set[str] = set()
        self._order: deque[str] = deque()
        self._new = 0
        self._lock = threading.Lock()

    def add(self, events: object) -> None:
        if not isinstance(events, list):
            return
        with self._lock:
            for e in events:
                sid = e.get("session_id") if isinstance(e, dict) else None
                if not isinstance(sid, str) or not sid or sid in self._seen:
                    continue
                self._seen.add(sid)
                self._order.append(sid)
                self._new += 1
                if len(self._order) > KEEP:
                    self._seen.discard(self._order.popleft())

    def take(self) -> int:
        """New distinct sessions since the previous call."""
        with self._lock:
            n, self._new = self._new, 0
            return n


def serve(counter: SessionCounter, port: int) -> ThreadingHTTPServer:
    """Listen on 127.0.0.1 only (Parallax runs on the same machine)."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            try:
                n = int(self.headers.get("content-length") or 0)
                counter.add(json.loads(self.rfile.read(min(n, 4 * 1024 * 1024)) or b"[]"))
                self.send_response(204)
            except (ValueError, json.JSONDecodeError):
                self.send_response(400)
            self.end_headers()

        def log_message(self, *a):  # quiet
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd
