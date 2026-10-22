#!/bin/zsh
set -euo pipefail
: "${CLOUDFLARED_TOKEN_FILE:?set CLOUDFLARED_TOKEN_FILE to the tunnel token file}"
exec cloudflared tunnel --loglevel info --no-autoupdate run --token-file "$CLOUDFLARED_TOKEN_FILE"
