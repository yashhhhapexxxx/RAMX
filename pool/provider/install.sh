#!/usr/bin/env bash
# Launch locally in Terminal, not through an SSH session. No marketplace key is installed.
set -euo pipefail
gateway=""; code=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --gateway) gateway="${2:?Missing gateway}"; shift 2 ;;
    --code) code="${2:?Missing enrollment code}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$gateway" ] && [ -n "$code" ] || { echo 'Get a new helper command from Getting Started.' >&2; exit 2; }
command -v python3 >/dev/null || { echo 'Install Python 3.10+ first, then rerun this command.' >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/ramx-provider.XXXXXX")"
trap 'rm -rf "$work"' EXIT
curl -fsSL "${gateway%/}/provider/helper.py" -o "$work/helper.py"
python3 "$work/helper.py" --gateway "$gateway" --code "$code"
