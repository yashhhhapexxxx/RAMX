"""Node key file: one line, 0x + 64 hex, newline, mode 600 (same format as ~/.ramx/node.key)."""
from __future__ import annotations

import os
from pathlib import Path

from eth_account import Account
from eth_account.signers.local import LocalAccount


def load_or_create(path: Path) -> tuple[LocalAccount, bool]:
    """Returns (account, created)."""
    if path.exists():
        raw = path.read_text().strip()
        key = raw if raw.startswith("0x") else "0x" + raw
        return Account.from_key(key), False
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    acct = Account.create()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("0x" + acct.key.hex().removeprefix("0x") + "\n")
    return acct, True


def load(path: Path) -> LocalAccount:
    if not path.exists():
        raise SystemExit(f"error: no key at {path}; run `ramx-node init` first")
    return load_or_create(path)[0]
