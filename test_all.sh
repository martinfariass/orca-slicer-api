#!/bin/bash
#
# Everything, in the order that fails fastest first: types and lint (seconds,
# no Docker), then unit tests (no slicer), then the containerised e2e run
# against both slicer flavours.
#
# Usage:
#   ./test_all.sh              # full run
#   ./test_all.sh --quick      # skip e2e (no Docker needed)

set -e

cd "$(dirname "$0")"

./test_static.sh
./test_unit.sh

if [ "${1:-}" = "--quick" ]; then
    echo "Skipping e2e (--quick)"
    exit 0
fi

./test_e2e.sh
