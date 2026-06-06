#!/bin/bash
# Build and push BOTH sidecar images (orca-slicer-api + bambu-studio-api)
# to GHCR + Docker Hub. Driven by Bambuddy's publish scripts so QNAP / Synology /
# Container Station users can pull instead of building.
#
# Usage (typically invoked from bambuddy/docker-publish*.sh):
#   ./docker-publish-sidecars.sh --channel stable --version 0.2.5 [--parallel] [--ghcr-only|--dockerhub-only]
#   ./docker-publish-sidecars.sh --channel beta   --version 0.2.5b1
#   ./docker-publish-sidecars.sh --channel daily  --version 0.2.5b1
#
# Channels and tags:
#   stable  -> :latest + :bambuddy-<version>
#   beta    -> :beta   + :bambuddy-<version>  (GHCR only — matches bambuddy-beta)
#   daily   -> :daily  (floating, no immutable tag)
#
# Safety guards (the "müssen wir aufpassen" net — see issue #1657 context):
#   1. Working directory must be this script's repo (orca-slicer-api)
#   2. Branch MUST be bambuddy/profile-resolver  -> abort otherwise
#   3. Working tree MUST be clean                -> abort otherwise
#   4. This script NEVER calls: git checkout / pull / fetch / reset / push
#
# Image layout:
#   Dockerfile               -> ghcr.io/maziggy/orca-slicer-api      (amd64 + arm64)
#   Dockerfile.bambu-studio  -> ghcr.io/maziggy/bambu-studio-api     (amd64 ONLY —
#                                BambuStudio has no upstream ARM64 AppImage)
#
# Same Docker login prerequisites as bambuddy/docker-publish.sh.

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_BRANCH="bambuddy/profile-resolver"
BUILDER_NAME="bambuddy-sidecar-builder"

GHCR_REGISTRY="ghcr.io"
DOCKERHUB_REGISTRY="docker.io"
ORCA_IMAGE_NAME="maziggy/orca-slicer-api"
BAMBU_IMAGE_NAME="maziggy/bambu-studio-api"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CHANNEL=""
VERSION=""
PARALLEL=false
PUSH_GHCR=true
PUSH_DOCKERHUB=true

while [ $# -gt 0 ]; do
    case "$1" in
        --channel)         CHANNEL="$2"; shift 2 ;;
        --version)         VERSION="$2"; shift 2 ;;
        --parallel)        PARALLEL=true; shift ;;
        --ghcr-only)       PUSH_DOCKERHUB=false; shift ;;
        --dockerhub-only)  PUSH_GHCR=false; shift ;;
        --help|-h)
            grep -E '^# ' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo -e "${RED}Unknown argument: $1${NC}"; exit 1 ;;
    esac
done

if [ -z "$CHANNEL" ] || [ -z "$VERSION" ]; then
    echo -e "${RED}Error: --channel and --version are required${NC}"
    echo "Run $0 --help for usage"
    exit 1
fi

case "$CHANNEL" in
    stable|beta|daily) ;;
    *) echo -e "${RED}Error: --channel must be one of: stable, beta, daily${NC}"; exit 1 ;;
esac

# Beta channel is a private GHCR package — never push to Docker Hub
if [ "$CHANNEL" = "beta" ]; then
    PUSH_DOCKERHUB=false
fi

cd "$REPO_DIR"

# ----------------------------------------------------------------------
# Safety guards — protect bambuddy/profile-resolver branch + clean tree
# ----------------------------------------------------------------------
echo -e "${BLUE}[guard 1/2] Verifying repo state...${NC}"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$REQUIRED_BRANCH" ]; then
    echo -e "${RED}ABORT: orca-slicer-api repo is on branch '${CURRENT_BRANCH}'${NC}"
    echo -e "${RED}       must be on '${REQUIRED_BRANCH}' to build sidecar images.${NC}"
    echo -e "${YELLOW}       Switch manually: cd ${REPO_DIR} && git checkout ${REQUIRED_BRANCH}${NC}"
    echo -e "${YELLOW}       This script will NOT switch branches automatically.${NC}"
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    echo -e "${RED}ABORT: orca-slicer-api working tree is dirty.${NC}"
    echo -e "${YELLOW}       Commit or stash changes before publishing sidecar images:${NC}"
    git status --short
    exit 1
fi

GIT_SHA=$(git rev-parse --short HEAD)
echo -e "${GREEN}  Branch: ${CURRENT_BRANCH} @ ${GIT_SHA}${NC}"
echo -e "${GREEN}  Working tree: clean${NC}"

# ----------------------------------------------------------------------
# Tag computation per channel
# ----------------------------------------------------------------------
case "$CHANNEL" in
    stable)
        FLOATING_TAG="latest"
        VERSIONED_TAG="bambuddy-${VERSION}"
        ;;
    beta)
        FLOATING_TAG="beta"
        VERSIONED_TAG="bambuddy-${VERSION}"
        ;;
    daily)
        FLOATING_TAG="daily"
        VERSIONED_TAG=""  # no immutable tag for daily
        ;;
esac

echo -e "${BLUE}[guard 2/2] Tag plan${NC}"
echo -e "${GREEN}  Channel: ${CHANNEL}${NC}"
echo -e "${GREEN}  Floating tag: ${FLOATING_TAG}${NC}"
[ -n "$VERSIONED_TAG" ] && echo -e "${GREEN}  Versioned tag: ${VERSIONED_TAG}${NC}"
echo -e "${GREEN}  Registries: GHCR=${PUSH_GHCR}, Docker Hub=${PUSH_DOCKERHUB}${NC}"

# ----------------------------------------------------------------------
# Login sanity checks (warn, don't fail — buildx will fail loudly anyway)
# ----------------------------------------------------------------------
if [ "$PUSH_GHCR" = true ] && ! grep -q "ghcr.io" ~/.docker/config.json 2>/dev/null; then
    echo -e "${YELLOW}Warning: not logged in to ghcr.io${NC}"
fi
if [ "$PUSH_DOCKERHUB" = true ] && ! grep -q "index.docker.io\|docker.io" ~/.docker/config.json 2>/dev/null; then
    echo -e "${RED}Error: not logged in to Docker Hub${NC}"
    exit 1
fi

# ----------------------------------------------------------------------
# Buildx builder (isolated from the main bambuddy-builder cache)
# ----------------------------------------------------------------------
CPU_COUNT=$(nproc 2>/dev/null || echo 4)
echo -e "${BLUE}Setting up isolated buildx builder: ${BUILDER_NAME}...${NC}"
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    docker buildx create \
        --name "$BUILDER_NAME" \
        --driver docker-container \
        --driver-opt network=host \
        --driver-opt "env.BUILDKIT_STEP_LOG_MAX_SIZE=10000000" \
        --buildkitd-flags "--allow-insecure-entitlement network.host --oci-worker-gc=false" \
        --config /dev/stdin <<EOF
[worker.oci]
  max-parallelism = ${CPU_COUNT}
EOF
    docker buildx inspect --bootstrap "$BUILDER_NAME"
fi
docker buildx use "$BUILDER_NAME"

if ! docker buildx inspect --bootstrap | grep -q "linux/arm64"; then
    echo -e "${YELLOW}Installing QEMU for cross-platform builds...${NC}"
    docker run --privileged --rm tonistiigi/binfmt --install all
fi

# ----------------------------------------------------------------------
# Tag-string assembly helper
# ----------------------------------------------------------------------
# Args: $1 = base image name (e.g. maziggy/orca-slicer-api)
build_tags_for() {
    local base="$1"
    local tags=""
    if [ "$PUSH_GHCR" = true ]; then
        tags="$tags -t ${GHCR_REGISTRY}/${base}:${FLOATING_TAG}"
        [ -n "$VERSIONED_TAG" ] && tags="$tags -t ${GHCR_REGISTRY}/${base}:${VERSIONED_TAG}"
    fi
    if [ "$PUSH_DOCKERHUB" = true ]; then
        tags="$tags -t ${DOCKERHUB_REGISTRY}/${base}:${FLOATING_TAG}"
        [ -n "$VERSIONED_TAG" ] && tags="$tags -t ${DOCKERHUB_REGISTRY}/${base}:${VERSIONED_TAG}"
    fi
    echo "$tags"
}

BUILD_ARGS="--provenance=false --sbom=false --no-cache --pull"

# ----------------------------------------------------------------------
# Build 1/2 — Orca (amd64 + arm64)
# ----------------------------------------------------------------------
echo ""
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}  Building orca-slicer-api (amd64 + arm64)${NC}"
echo -e "${GREEN}================================================${NC}"

ORCA_TAGS=$(build_tags_for "$ORCA_IMAGE_NAME")
DOCKER_BUILDKIT=1 docker buildx build \
    -f Dockerfile \
    --platform linux/amd64,linux/arm64 \
    ${BUILD_ARGS} \
    ${ORCA_TAGS} \
    --push \
    .

# ----------------------------------------------------------------------
# Build 2/2 — BambuStudio (amd64 only — no upstream ARM64 AppImage)
# ----------------------------------------------------------------------
echo ""
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}  Building bambu-studio-api (amd64 only)${NC}"
echo -e "${GREEN}================================================${NC}"

BAMBU_TAGS=$(build_tags_for "$BAMBU_IMAGE_NAME")
DOCKER_BUILDKIT=1 docker buildx build \
    -f Dockerfile.bambu-studio \
    --platform linux/amd64 \
    ${BUILD_ARGS} \
    ${BAMBU_TAGS} \
    --push \
    .

# ----------------------------------------------------------------------
# Verify
# ----------------------------------------------------------------------
echo ""
echo -e "${BLUE}Verifying manifests...${NC}"
if [ "$PUSH_GHCR" = true ]; then
    docker buildx imagetools inspect "${GHCR_REGISTRY}/${ORCA_IMAGE_NAME}:${FLOATING_TAG}"
    docker buildx imagetools inspect "${GHCR_REGISTRY}/${BAMBU_IMAGE_NAME}:${FLOATING_TAG}"
fi
if [ "$PUSH_DOCKERHUB" = true ]; then
    docker buildx imagetools inspect "${DOCKERHUB_REGISTRY}/${ORCA_IMAGE_NAME}:${FLOATING_TAG}"
    docker buildx imagetools inspect "${DOCKERHUB_REGISTRY}/${BAMBU_IMAGE_NAME}:${FLOATING_TAG}"
fi

echo ""
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}  Sidecar images published${NC}"
echo -e "${GREEN}================================================${NC}"
echo "  orca-slicer-api:  :${FLOATING_TAG}${VERSIONED_TAG:+ + :${VERSIONED_TAG}}  (amd64+arm64)"
echo "  bambu-studio-api: :${FLOATING_TAG}${VERSIONED_TAG:+ + :${VERSIONED_TAG}}  (amd64)"
echo "  Built from:       ${REQUIRED_BRANCH} @ ${GIT_SHA}"
echo ""
