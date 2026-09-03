// External-verifier tool ids — extracted from advisory.ts (2026-08-10) when
// the skip-policy file hit the 500-line cap; the id table and the demotion
// policy are separate concerns. advisory.ts re-exports for back-compat.

/** Public API — consumed by `verify.ts`, `tool-results.ts`, and tests. */
export const TOOL_IDS = [
	"tsc",
	"biome",
	"eslint",
	"semgrep",
	"gitleaks",
	"dep-audit",
	"mypy",
	"ruff",
	"cargo-check",
	"cargo-clippy",
	"go-build",
	"golangci-lint",
	"go-test",
	"c-compile",
	"clang-tidy",
	"oxlint",
	"knip",
	"shellcheck",
	"actionlint",
	"hadolint",
	"taplo",
	"swiftlint",
	"swift-build",
] as const;
