#!/bin/bash
#
# Unit tests. These never spawn a slicer -- the upload-limit specs stop at
# multer, and the rest are pure functions -- so they run on the host with no
# Docker and no AppImage.
#
# Usage:
#   ./test_unit.sh              # run once
#   ./test_unit.sh --watch      # re-run on change

set -e

cd "$(dirname "$0")"

# npm's version banner is noise around a test result.
export NPM_CONFIG_UPDATE_NOTIFIER=false
export NPM_CONFIG_FUND=false

if [ "$1" = "--watch" ]; then
    exec npx vitest tests/unit
fi

exec npx vitest run tests/unit
