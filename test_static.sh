#!/bin/bash
#
# Type-check + lint. No slicer, no Docker, no network -- runs anywhere.
#
# Usage:
#   ./test_static.sh

set -e

cd "$(dirname "$0")"

export NPM_CONFIG_UPDATE_NOTIFIER=false
export NPM_CONFIG_FUND=false

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}==> tsc --noEmit${NC}"
npx tsc --noEmit

echo -e "${BLUE}==> eslint${NC}"
npm run lint

echo -e "${GREEN}Static checks passed${NC}"
