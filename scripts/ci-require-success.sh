#!/usr/bin/env bash
# ============================================================================
# Aggregate status gate for a required check
# ============================================================================
# The `main` ruleset requires the status check named `package (Linux / Node
# 22)`. Packaging is now four jobs (package-build / package-lint /
# package-smoke / onboarding), so a job with exactly that name runs after all
# of them under `if: always()` and calls this script with one environment
# VARIABLE NAME per dependency; each variable holds that job's `needs.<job>.result`.
#
# The gate passes only when EVERY named variable is exactly `success`.
# `failure`, `cancelled`, `skipped`, an empty value and an unset variable all
# fail — a skipped or cancelled dependency must never satisfy a required check.
#
#   bash scripts/ci-require-success.sh PACKAGE_BUILD PACKAGE_LINT ...
set -uo pipefail

if [ "$#" -eq 0 ]; then
    echo "usage: ci-require-success.sh VAR [VAR...]" >&2
    exit 2
fi

status=0
for name in "$@"; do
    value="${!name:-}"
    if [ "$value" = "success" ]; then
        echo "✓ $name: success"
    else
        echo "✗ $name: ${value:-<unset>} (required: success)"
        status=1
    fi
done
exit "$status"
