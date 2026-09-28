#!/usr/bin/env bash
# ============================================================================
# Tarball install smoke
# ============================================================================
# Pack the package, install it into a throwaway project, and exercise the
# published bins (interlinked + interlinked-hook). Catches broken exports / bin
# paths / missing dist files BEFORE they ship — the class of failure unit tests
# can't see because they run against src/, not the packed artifact.
#
# Single source of truth: invoked by .github/workflows/ci.yml, scripts/
# ci-packaging.sh (→ ci:local), and the pre-push hook, so the published-package
# check can't drift between cloud and local.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
CONTRACT_DIGEST="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync("protocol/mutation-v3/contract-digest.json","utf8")).digest)')"

PACK_DIR="$(mktemp -d)"
SMOKE_DIR="$(mktemp -d)"
cleanup() { rm -rf "$PACK_DIR" "$SMOKE_DIR"; }
trap cleanup EXIT

# `npm pack` runs prepack → build, so the tarball reflects current source.
# CI packs ONCE in its build job and hands the exact bytes down via
# INTERLINKED_TARBALL, so lint (publint/attw) and this smoke judge the same
# artifact; locally the script packs for itself.
if [ -n "${INTERLINKED_TARBALL:-}" ]; then
  [ -f "$INTERLINKED_TARBALL" ] || { echo "INTERLINKED_TARBALL is not a file: $INTERLINKED_TARBALL" >&2; exit 1; }
  TARBALL="$(cd "$(dirname "$INTERLINKED_TARBALL")" && pwd)/$(basename "$INTERLINKED_TARBALL")"
else
  npm pack --pack-destination "$PACK_DIR" >/dev/null
  TARBALL="$(find "$PACK_DIR" -name 'interlinked-cli-*.tgz' -print -quit)"
fi
echo "Installing: $TARBALL"

cd "$SMOKE_DIR"
npm init -y >/dev/null
npm install --no-save "$TARBALL" >/dev/null

# The cloud compatibility fence must survive bundling. The source contract
# directory is intentionally not published; its digest is compiled into the
# installed runtime and checked before any admission or evaluation.
grep -R -q -- "$CONTRACT_DIGEST" node_modules/interlinked-cli/dist

INTERLINKED=./node_modules/.bin/interlinked
HOOK=./node_modules/.bin/interlinked-hook

"$INTERLINKED" --version
"$INTERLINKED" --help | head -5
"$INTERLINKED" install-hooks --runner claude-code --mode balanced --json >/dev/null
test -f .claude/settings.json
grep -q -- "--runner 'claude-code'" .claude/settings.json
printf '{"session_id":"smoke","cwd":"%s","tool_name":"Read","tool_input":{"file_path":"README.md"}}' "$PWD" \
  | "$HOOK" --runner claude-code --event PreToolUse >/dev/null
mkdir -p src
"$INTERLINKED" write src/smoke.ts --stdin --json <<< 'export const smoke: number = 1;' >/dev/null

# Project e2e surface (plan 31 Unit F2): a git-initialized host built from the
# TypeScript CLI fixture (copied as data), driven through the installed bin only —
# doctor, check, a supervised run, check --staged / --revision, and the PE-35
# unstaged-edit inversion. The host never touches the Interlinked source tree.
HOST_DIR="$(mktemp -d)"
trap 'cleanup; rm -rf "$HOST_DIR"' EXIT
node "$REPO_ROOT/scripts/smoke-tarball-e2e.mjs" "$SMOKE_DIR/node_modules/.bin/interlinked" "$REPO_ROOT/src/harness/project-e2e/__fixtures__/ts-cli" "$HOST_DIR"

echo "✓ tarball install smoke passed"
