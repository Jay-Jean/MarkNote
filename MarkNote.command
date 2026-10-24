#!/bin/zsh

set -u

MARKNOTE_ROOT="$(cd "$(dirname "$0")" && pwd)"
open "${MARKNOTE_ROOT}/MarkNote.app"
