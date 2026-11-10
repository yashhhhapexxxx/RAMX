#!/usr/bin/env bash
# Run on the coordinator/gateway laptop. Remote members are reached through SSH.
set -euo pipefail
exec python3 "$(dirname "$0")/bootstrap/kickstart.py" "$@"
