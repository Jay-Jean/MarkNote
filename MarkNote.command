#!/bin/zsh

set -u

MARKNOTE_ROOT="$(cd "$(dirname "$0")" && pwd)"
MARKNOTE_PORT="4173"

python3 -m http.server "${MARKNOTE_PORT}" --directory "${MARKNOTE_ROOT}" >/tmp/marknote-http-server.log 2>&1 &
open "http://localhost:${MARKNOTE_PORT}/index.html"
