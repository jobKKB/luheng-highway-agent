#!/usr/bin/env sh
# Run on a normal graphical Linux development host, not a syscall-restricted shell.
# Each test suite uses isolated temporary data; this script does not alter the live app.
set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT" || exit 2
mkdir -p artifacts
npm test > artifacts/backend-final-test-output.txt 2>&1
backend_status=$?
printf '%s\n' "$backend_status" > artifacts/backend-final-test-exit-code.txt
npm --prefix desktop run check > artifacts/desktop-final-test-output.txt 2>&1
desktop_status=$?
printf '%s\n' "$desktop_status" > artifacts/desktop-final-test-exit-code.txt
if [ -f tests/ui-smoke.mjs ]; then
  npm run test:ui > artifacts/ui-final-test-output.txt 2>&1
  ui_status=$?
else
  printf '%s\n' 'UI smoke script has not been supplied yet.' > artifacts/ui-final-test-output.txt
  ui_status=3
fi
printf '%s\n' "$ui_status" > artifacts/ui-final-test-exit-code.txt
printf '{"backendExit":%s,"desktopExit":%s,"uiExit":%s}\n' "$backend_status" "$desktop_status" "$ui_status" > artifacts/final-test-summary.json
[ "$backend_status" -eq 0 ] && [ "$desktop_status" -eq 0 ] && [ "$ui_status" -eq 0 ]
