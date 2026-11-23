#!/usr/bin/env bash
# Start the read-only Noteful reader.
# Uses uv for environment setup when available, otherwise the system Python.
set -euo pipefail
cd "$(dirname "$0")"

if command -v uv >/dev/null 2>&1; then
  exec uv run python reader/app.py "$@"
fi
exec python3 reader/app.py "$@"
