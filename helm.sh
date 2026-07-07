#!/usr/bin/env bash
# HELM — start the console and open it in the default browser (macOS / Linux).
set -e
cd "$(dirname "$0")"

URL="http://127.0.0.1:${HELM_PORT:-7777}"

# Open the browser once the port is up, without blocking the server.
( sleep 1
  if command -v open >/dev/null 2>&1; then open "$URL"          # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" # Linux
  fi ) >/dev/null 2>&1 &

exec node server.js
