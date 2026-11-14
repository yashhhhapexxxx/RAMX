# pool (C1: Parallax pool runner)

Website onboarding: `/getting-started` → Create Pool / Join Pool → World login → native local
helper command.
`provider/helper.py` keeps marketplace credentials on the central gateway and runs locally
in each owner's Terminal; it does not require SSH sessions between laptops.

Bash; works on Linux and macOS. Parallax is an installed dependency (`$PARALLAX_DIR`), never forked here.

For a new group with the gateway on its coordinator, use `pool/kickstart.sh`. One manifest names the enrolled SSH
hosts; the bootstrap discovers Ethernet IPs, prepares software and model caches, prints
owner registration links, and starts the pool together. This workflow has local tests;
the complete four-laptop setup still needs live validation.

| Script | What it does |
|---|---|
| `start-scheduler.sh [env]` | `parallax run -m $MODEL -n $INIT_NODES` (default env `pool/scheduler.env`, `ROLE=scheduler`). No `HF_HUB_OFFLINE` (the scheduler downloads small config files). |
| `join-node.sh [env]` | `parallax join` (default env `pool/node.env`, `ROLE=node`). Sets `HF_HUB_OFFLINE=1`; `CUDA_HOME` + `PATH` on CUDA nodes; `$EXTRA_FLAGS` (Mac memory flags). |
| `stop-all.sh` | TERM → KILL each recorded process group, then sweeps every `parallax/.venv/bin/(python\|vllm-rs)` process (`spawn_main`, `resource_tracker`, ghosts). Fails if `pgrep -f "parallax/.venv/bin/python"` is not empty. |
| `status.sh` | `GET http://127.0.0.1:3001/cluster/status_json` (override `PARALLAX_API`). |
| `warmup.sh` | One warm-up request (SPEC §3.2 step 5): no logprobs, `enable_thinking: false`. |

Every start uses `-u`, `--dht-prefix`, fixed `--tcp-port/--udp-port`, and
`--announce-maddrs /ip4/$LAN_IP/tcp/$TCP_PORT /ip4/$LAN_IP/udp/$UDP_PORT/quic-v1`.
Processes start in a new session (`setsid`; on macOS `POSIX::setsid` via perl, because macOS has no `setsid(1)`),
in `cd $PARALLAX_DIR` (the scheduler's `p2p.key` lives there; delete it for a new peer ID).
Logs: `pool/logs/<name>.log`. Process group IDs: `pool/run/<name>.pgid` (both git-ignored).

`DRY_RUN=1 <script>` prints the command and changes nothing.

## Start procedure (SPEC §3.2)

```bash
pool/stop-all.sh                      # on every machine
pool/start-scheduler.sh               # coordinator
pool/join-node.sh                     # every node, ALL within 30 s of each other
pool/status.sh                        # wait until all nodes are ready
pool/warmup.sh
```

Download the model on each node **before** joining (nodes are offline: `HF_HUB_OFFLINE=1`).

Note: `/cluster/status_json` (Parallax `162354a`) lists `node_id` (libp2p peer ID), `status`, `gpu_name`,
`gpu_memory` per node, but **no layer ranges**.

## Post-MVP P5 resilience

| Part | Where | What |
|---|---|---|
| Runtime hooks | `hooks/sitecustomize.py`, `hooks/ramx_hooks.py` | `lib.sh use_hooks` puts `pool/hooks` on `PYTHONPATH` with `RAMX_HOOKS=1`; every Parallax Python process patches some Parallax classes after import. `HOOKS=0` turns this off. Parallax files are never changed. |
| P5.3 grace hook | `NodeManager.activate` / `register_pipelines` | A node that waited for placement gets a fresh heartbeat clock when it becomes active, so slow joiners are no longer dropped at placement. |
| P5.4 ghost guard | `RPCConnectionHandler.build_node` | Rejects `node_update` from peers the scheduler does not know (no auto-join of leftover processes) and `node_join` without hardware details. With `ALLOWED_PEERS_FILE` (scheduler env) a join waits ≤ 30 s for its peer ID in the gateway's allow-list. |
| P5.8 route log | `RequestHandler._prepare_backend_request` | Logs `{ramx_req_id, routing_table}` to `pool/run/routes.jsonl` and strips the field. Gateway: `PARALLAX_ROUTE_LOG`. |
| Peer ID file | `GradientServer.get_node_info` (node side) | Writes `pool/run/node.peer-id` before the join; the node agent reports it. |
| P5.5 / P5.6 restart | `restart.sh [--coordinator] [--join-delay S] [--lan-ip IP]` | Stop the process group, (coordinator: start the scheduler), join again. The node agent runs it on a gateway restart order or a LAN IP change (`AUTO_RESTART=true`). |
| P5.7 memory | `join-node.sh` | A Mac without `--kv-cache-memory-fraction` and `--max-sequence-length` in `EXTRA_FLAGS` does not start (`ALLOW_MAC_DEFAULT_MEMORY=1` to override). |
| P5.9 notify | `join-node.sh` | With `NOTIFY_PORT`, Parallax gets `--notify-url http://127.0.0.1:$NOTIFY_PORT/notify`; the node agent counts the sessions it serves. |

Each start writes `=== ramx start <name> <time> ===` to its log; the node agent ignores older lines.
Hook tests (no Parallax needed): `python3 -m pytest pool/hooks`. Pin check against Parallax source:
`PARALLAX_SRC=<parallax checkout at 162354a> python3 -m pytest pool/hooks`.
Not verified on the live pool yet: run the start procedure once with hooks on and check the log lines
`ramx hooks: patched ...` in `pool/logs/scheduler.log` and `node.log`.

## SPEC §16.1 pools (SPEC §3.5)

| Part | Where | What |
|---|---|---|
| Node leave cool-down | `hooks/ramx_hooks.py` (`Scheduler`) | Waits `REBALANCE_COOLDOWN_S` before Parallax reloads every node; cancelled if the pool is whole again. |
| Many pools | `start-scheduler.sh` `API_PORT`, `PROCESS_NAME` | Several schedulers on the gateway host, each on its own `127.0.0.1` API port. |
| Automatic formation | `pools-up.sh [gateway-url]` | Gateway host: reads `GET /pools/plan`, starts a scheduler per formed pool (`schedulers/<pool>.env`, API 3101+, P2P 5300+), writes `run/coordinators.json` (gateway `POOL_COORDINATORS_FILE`). Open the new P2P ports for the members (manual). |
| Join a formed pool | `restart.sh --dht-prefix P` | The node agent runs it when the gateway assigns the node to a pool. |
| WAN | `SCHEDULER_ADDR`, `RELAY_SERVERS`, `INITIAL_PEERS` | Our own relay / bootstrap multiaddrs; not tested over the internet. |
| Privacy / batching | `START_LAYER`/`END_LAYER`, `MAX_BATCH_SIZE` | Parallax `--start-layer/--end-layer`, `--max-batch-size`. |
