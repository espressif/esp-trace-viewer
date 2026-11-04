#!/usr/bin/env bash
#
# Run the Playwright e2e suite inside the pinned Linux image to generate and compare
# screenshot baselines in the CI environment and avoid cross-platform font rasterization discrepancies.
#
# Usage:
#   scripts/e2e-docker.sh                     # run the suite against baselines
#   scripts/e2e-docker.sh --update-snapshots  # (re)generate the baselines
#   scripts/e2e-docker.sh -g "introspection"  # any extra `playwright test` args
#
# A named Docker volume stores node_modules so the container installs Linux
# dependencies without modifying host node_modules. The repository is bind-mounted
# so updated baselines under test/e2e/__screenshots__ persist to the host.
set -euo pipefail

# Keep this tag in lockstep with the @playwright/test version in package.json
# and the images in .gitlab-ci.yml and .github/workflows/ci.yml.
IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec docker run --rm \
  -v "${REPO_ROOT}":/work \
  -v trace-viewer-e2e-node-modules:/work/node_modules \
  -w /work \
  "${IMAGE}" \
  bash -lc 'npm ci --no-audit --no-fund && exec npx playwright test "$@"' -- "$@"
