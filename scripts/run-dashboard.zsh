#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
export CLAUDE_PEERS_BROKER_URL="${CLAUDE_PEERS_BROKER_URL:-http://127.0.0.1:7899}"
exec bun dashboard-server.ts
