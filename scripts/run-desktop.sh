#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ELECTRON="$ROOT/desktop/node_modules/electron/dist/electron"
if [ "$(uname -s)" = Darwin ]; then
  ELECTRON="$ROOT/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
fi
if [ ! -x "$ELECTRON" ]; then
  echo 'Electron runtime missing. From the project directory run:' >&2
  echo '  npm --prefix desktop ci && npm --prefix desktop run install:runtime' >&2
  exit 1
fi
exec "$ELECTRON" "$ROOT/desktop" "$@"
