#!/usr/bin/env bash
# ============================================================================
# Packaging + distribution checks
# ============================================================================
# The part of CI BEYOND typecheck / docs / test: build the dist, lint the
# package surface, verify the published types, and smoke-test the actual
# installed artifact. Mirrors the package-build / package-lint / package-smoke
# / onboarding jobs of .github/workflows/ci.yml.
#
# Shared by scripts/ci-local.sh and the pre-push hook so local and cloud can't
# drift. Each step prints a header; first failure exits non-zero.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

hdr() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m✗ packaging failed at: %s\033[0m\n' "$1"; exit 1; }

# Same shape as CI: pack ONCE (`npm pack` runs prepack → build), then judge
# those exact bytes with publint, attw and the install smoke. Onboarding is
# the independent fresh-source path and never sees the tarball.
PACK_DIR="$(mktemp -d)"
trap 'rm -rf "$PACK_DIR"' EXIT
hdr "pack (build + npm pack)"
npm pack --pack-destination "$PACK_DIR" >/dev/null              || die "pack"
TARBALL="$(find "$PACK_DIR" -name 'interlinked-cli-*.tgz' -print -quit)"
[ -f "$TARBALL" ]                                               || die "pack (no tarball)"
hdr "publint ($TARBALL)"
npx --yes publint run "$TARBALL"                                || die "publint"
hdr "attw (published types)"
npx --yes --package=@arethetypeswrong/cli attw "$TARBALL" --profile esm-only || die "attw"
hdr "tarball install smoke"
INTERLINKED_TARBALL="$TARBALL" bash scripts/smoke-tarball-install.sh || die "tarball install smoke"
hdr "onboarding smoke (git-clone install path)"
INTERLINKED_REPO_URL="$REPO_ROOT" INTERLINKED_REPO_REF=HEAD \
  bash scripts/smoke-onboarding.sh                             || die "onboarding smoke"
