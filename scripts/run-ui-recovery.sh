#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p artifacts/recovery
node tests/ui-recovery.mjs > artifacts/recovery/ui-recovery.log 2>&1
