#!/usr/bin/env python3
"""Merge `KEY=value` lines from stdin into an env file, in place.

Runs on the server, fed by `push-env.sh` over ssh.

# Why a merge and not an overwrite

The server owns values the workstation has never seen. `FOMV_ADMIN_TOKEN` is
generated on the box by the installer and has never left it; replacing the file
wholesale would silently rotate it and lock the operator out of their own
inbox.

# Why python and not sed

These values are RPC URLs and base64 secrets: slashes, ampersands, equals signs
and question marks, in any combination. Choosing a sed delimiter that none of
them will ever contain is a bet that eventually loses, and it loses by writing
a corrupted credential rather than by failing.

Values arrive on stdin rather than as arguments. An argument is visible in the
process list to every user on both machines for as long as the command runs.
"""

import re
import sys

KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: merge-env.py <env-file>", file=sys.stderr)
        return 2
    path = sys.argv[1]

    updates: dict[str, str] = {}
    for line in sys.stdin.read().splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        # A later line wins, which is how a shell sourcing the file would
        # behave, so a duplicated key does not apply the stale copy.
        updates[key] = value

    if not updates:
        print("  nothing on stdin; refusing to rewrite the file", file=sys.stderr)
        return 1

    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")

    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        m = KEY.match(line)
        if m and m.group(1) in updates:
            key = m.group(1)
            out.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            out.append(line)

    # A key the file has never carried is appended rather than dropped, so a
    # variable added to the project does not need the template regenerated.
    for key, value in updates.items():
        if key not in seen:
            out.append(f"{key}={value}")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out))

    print(f"  {len(seen)} updated, {len(updates) - len(seen)} added")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
