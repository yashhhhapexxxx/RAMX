# node-agent (C2, Python 3.12, uv)

Node key, registration link, signed heartbeats to the gateway (which builds the directory from them),
start/stop.

```bash
cd node-agent && cp .env.example .env && uv sync
uv run ramx-node init                 # create NODE_KEY_PATH if missing (0x hex + newline, mode 600); print the registration link
uv run ramx-node start                # pool/join-node.sh, then the heartbeat loop (foreground)
uv run ramx-node start --no-join      # Parallax node already runs
uv run ramx-node stop                 # stop the agent + pool/stop-all.sh, send a final offline heartbeat
uv run ramx-node stop --keep-parallax # stop only the agent
uv run pytest -q                         # signatures, body shape, key file, log parsing
uv run python tests/make_vector.py       # rewrite the cross-language vector (gateway/test/cross-language.test.ts checks it)
```

The node writes nothing on chain: the gateway builds the public directory from the signed heartbeats.

| What | How |
|---|---|
| Registration link | `<FRONTEND_URL>/register-node?node_id&pool_id&gpu&mem_gb&ts&node_sig`; `node_sig` = EIP-191 over `ramx-register:<node_id>:<pool_id>:<ts>`. The frontend posts the fields to `POST /nodes/register` with the session. Valid 24 h. |
| Heartbeat | Every `HEARTBEAT_SECONDS`: `NodeHeartbeat` JSON, header `x-ramx-node-signature` = EIP-191 over the exact body bytes. The response gives `owner_account` + `reliability`; the gateway lists the node from this heartbeat. |
| Layer range | From the Parallax node log `PARALLAX_NODE_LOG` (Parallax is not modified; `/cluster/status_json` has no ranges). Last of: `Join scheduler response: {… 'start_layer': S, 'end_layer': E …}` (`p2p/server.py:537`), `Layer allocation changed! … New: [S, E)` (`p2p/server.py:794`), `Reloading executor with layers [S, E)` (`launch.py:293`). ANSI codes stripped. |
| Status | `online` = a `parallax join` process runs and a range is known; `loading` = runs, no range; `offline` = not running. |
| GPU / memory | `nvidia-smi`; macOS: `sysctl machdep.cpu.brand_string` + `hw.memsize`; else CPU + RAM. |
| Stop | SIGTERM to the agent (`~/.ramx/agent.pid`), optional `stop-all.sh`, then one final signed heartbeat (offline). Without further heartbeats the listing expires after 120 s. |

## Post-MVP P5

| What | How |
|---|---|
| Peer ID (P5.4) | Read from `PEER_ID_FILE` (`pool/run/node.peer-id`, written by `pool/hooks` before the join; else the join log) and sent as `peer_id`. The gateway's admission allow-list is built from these signed heartbeats. |
| Served sessions (P5.9) | With `NOTIFY_PORT`, a listener on `127.0.0.1:NOTIFY_PORT/notify` takes Parallax `--notify-url` events and counts new distinct `session_id`s; each heartbeat sends `served_sessions` (kept if a heartbeat fails). |
| Memory (P5.7) | `usable_mem_gb`: Mac = memory − max(4 GB, 25 %); GPU = VRAM. `mem_pressure` = `swap_growing` when swap use grows > `SWAP_GROWTH_MB` within `SWAP_WINDOW_S` while Parallax runs (`sysctl vm.swapusage` / `/proc/meminfo`); the gateway then skips the pool. |
| LAN IP (P5.6) | `lan_ip` = local address used to reach the gateway. If it differs from `LAN_IP` in `pool/node.env`: `AUTO_RESTART=true` runs `pool/restart.sh --lan-ip <new>` (rewrites the env files, restarts); else prints the command once. The firewall allow-list still needs a human (sudo). |
| Clean restart (P5.5) | Heartbeat response `restart_id` > last executed → `AUTO_RESTART=true` runs `pool/restart.sh` (`--coordinator` on the coordinator; members `--join-delay RESTART_JOIN_DELAY_S`) in a background thread, then sends `restart_ack`. The ack is kept in `~/.ramx/agent-state.json`. Output: `pool/logs/restart.log`. |
| Stale layers | Lines before the last `=== ramx start` marker in the node log are ignored, so a restarting node never reports the old process's layers. |

Tests: `uv run pytest -q` (17 tests; `tests/test_p5.py` covers the parts above).

## SPEC §16.1 (automatic pools)

| What | How |
|---|---|
| `POOL_ID=auto` | Sends `p2p_port` (pool/node.env `TCP_PORT`) and measures TCP-connect delay to the `probe` peers (best of 3, background), reported as `rtt_ms`. On `assigned_pool`: `AUTO_RESTART=true` runs `pool/restart.sh --dht-prefix <prefix>` and keeps the pool in `~/.ramx/agent-state.json`; else prints the command. |
