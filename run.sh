#!/usr/bin/env bash
# Start the read-only Noteful reader.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 reader/app.py "$@"
