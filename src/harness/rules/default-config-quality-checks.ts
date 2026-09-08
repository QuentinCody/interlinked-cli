// ===========================================
// Rules — Default Quality Checks Config
// ===========================================
// Extracted from default-config.ts. Contains the DEFAULT_QUALITY_CHECKS
// constant — the full catalog of PostToolUse quality check configs
// (tsc / biome / mypy / cargo / semgrep / gitleaks / etc.).
//
// Do NOT import from default-config.ts here (circular import). This file
// is imported BY default-config.ts.

import type { QualityCheckConfig } from "../types.js";

const SOFTWARE_REFERENCE_FILE_TYPES = [
	"package.json",
	"requirements.txt",
	"go.mod",
	"Cargo.toml",
	"Dockerfile",
	".dockerfile",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".json",
	".yaml",
	".yml",
	".toml",
	".md",
	".txt",
];

/**
 * Default quality-check catalog. Consumed by DEFAULT_CONFIG in
 * default-config.ts. Exported for direct use in tests and tools that need
 * the catalog without the full GuardRulesConfig shape.
 */
export const DEFAULT_QUALITY_CHECKS: Record<string, QualityCheckConfig> = {
	lint_import: {
		enabled: false,
		command: "interlinked lint check",
		file_types: [""],
		timeout_ms: 30_000,
		severity: "warning",
		description: "Imported project lint rules with existing-debt comparison; enabled by lint import --write",
	},
	typescript: {
		enabled: true,
		command:
			"npx tsgo --noEmit --pretty false 2>/dev/null || npx tsc --noEmit --pretty false",
		file_types: [".ts", ".tsx", ".mts", ".cts"],
		timeout_ms: 10_000,
		severity: "error",
		description: "TypeScript type checking after file edits",
	},
	biome_lint: {
		enabled: true,
		command: "npx --yes --package @biomejs/biome biome check --no-errors-on-unmatched",
		file_types: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
		timeout_ms: 5_000,
		severity: "warning",
		description: "Biome lint check after file edits",
	},
	eslint: {
		// Off by default — ESLint is a 5-15s subprocess that overlaps with biome
		// on most TS/JS projects. The runner already auto-skips when no
		// `.eslintrc.*` / `eslint.config.*` is present (see runEslint), but the
		// `npx eslint` spawn itself costs ~3-5s even on the no-config skip path.
		// Opt in via `.interlinked/guard-rules.local.json` for repos that
		// genuinely use ESLint instead of (or alongside) biome.
		enabled: false,
		command: "npx eslint --no-error-on-unmatched-pattern",
		file_types: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
		timeout_ms: 10_000,
		severity: "warning",
		description: "ESLint check (used when project has eslint, not biome)",
	},
	secrets_in_source: {
		enabled: true,
		file_types: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".env"],
		timeout_ms: 1_000,
		severity: "error",
		description: "Detect secrets written into source files",
	},
	strong_typing: {
		enabled: true,
		file_types: [".ts", ".tsx", ".mts", ".cts"],
		timeout_ms: 2_000,
		severity: "warning",
		description:
			"Detect explicit `any` and `unknown` types — encourage stronger typing (interfaces, generics, branded types)",
	},
	software_version_regression: {
		enabled: true,
		file_types: [...SOFTWARE_REFERENCE_FILE_TYPES],
		timeout_ms: 1_000,
		severity: "error",
		description:
			"PostToolUse attention block for possible stale-memory software downgrades: package versions, model IDs, Docker tags, GitHub Action versions, API dates, and common runtime/config version assignments",
	},
	freshness_sensitive_reference: {
		enabled: true,
		file_types: [...SOFTWARE_REFERENCE_FILE_TYPES],
		timeout_ms: 1_000,
		severity: "warning",
		description:
			"PostToolUse advisory when newly introduced software/model/API references require verification against official current sources",
	},
	strict_typing_block: {
		enabled: false,
		file_types: [".ts", ".tsx", ".mts", ".cts"],
		timeout_ms: 500,
		severity: "error",
		description:
			"PreToolUse hard-block when an edit introduces new type-erasure patterns: `as any`, `as unknown as` chains, unjustified `@ts-ignore`/`@ts-expect-error`, bare `: any` annotations. Off by default — opt in via `.interlinked/guard-rules.local.json` once the team is ready to enforce.",
	},
	inline_language_checks: {
		enabled: true,
		file_types: [
			".py", ".pyi", ".rs", ".go",
			".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx",
			".java", ".swift",
		],
		timeout_ms: 2_000,
		severity: "warning",
		description:
			"Per-language inline pattern checks (bare except, .unwrap(), unsafe blocks, force casts, ignored err, etc.) driven by LanguageProfile.inline_checks",
	},
	affected_tests: {
		// Off by default: paired-test execution is high-friction noise on most edits.
		// Re-enable per repo via .interlinked/guard-rules.local.json when you want it.
		// TypeScript/JS also runs the edited file's DIRECT importers' companion
		// tests (one hop, no project-graph build — quality-checks/direct-importers.ts),
		// bounded by `max_dependent_tests` (default DEFAULT_MAX_DEPENDENT_TESTS in
		// quality-checks/test-dispatchers.ts); over cap, that phase skips with a
		// "N dependent test files not run (over cap)" warning instead of running.
		enabled: false,
		file_types: [".ts", ".tsx", ".js", ".jsx"],
		timeout_ms: 15_000,
		severity: "error",
		description:
			"Run the test file corresponding to the edited source file (foo.ts → foo.test.ts)",
	},
	python_typecheck: {
		enabled: true,
		command: "python -m mypy --no-error-summary",
		file_types: [".py"],
		timeout_ms: 15_000,
		severity: "warning",
		description: "Python type checking with mypy",
	},
	ruff_lint: {
		enabled: true,
		command: "ruff check",
		file_types: [".py"],
		timeout_ms: 5_000,
		severity: "warning",
		description: "Python linting with ruff",
	},
	ruff_format: {
		enabled: true,
		command: "ruff format --check",
		file_types: [".py"],
		timeout_ms: 5_000,
		severity: "warning",
		description: "Python formatting check with ruff",
	},
	cargo_check: {
		enabled: true,
		command: "cargo check --message-format=short",
		file_types: [".rs"],
		timeout_ms: 30_000,
		severity: "error",
		description: "Rust compilation check",
	},
	cargo_clippy: {
		enabled: true,
		command: "cargo clippy --message-format=short -- -D warnings",
		file_types: [".rs"],
		timeout_ms: 30_000,
		severity: "warning",
		description: "Rust linting with clippy",
	},
	rustfmt_check: {
		enabled: true,
		command: "rustfmt --check",
		file_types: [".rs"],
		timeout_ms: 10_000,
		severity: "warning",
		description: "Rust formatting check (rustfmt --check)",
	},
	go_build: {
		enabled: true,
		command: "go build ./...",
		file_types: [".go"],
		timeout_ms: 15_000,
		severity: "error",
		description: "Go compilation check",
	},
	golangci_lint: {
		enabled: true,
		command: "golangci-lint run",
		file_types: [".go"],
		timeout_ms: 15_000,
		severity: "warning",
		description: "Go linting with golangci-lint",
	},
	c_compile: {
		enabled: true,
		command: "make",
		file_types: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
		timeout_ms: 30_000,
		severity: "error",
		description: "C/C++ compilation check",
	},
	clang_tidy: {
		enabled: true,
		command: "clang-tidy",
		file_types: [".c", ".cpp", ".cc", ".cxx"],
		timeout_ms: 15_000,
		severity: "warning",
		description: "C/C++ linting with clang-tidy",
	},
	semgrep: {
		// Off by default: requires `semgrep` on PATH and is slow + noisy on many repos.
		// Re-enable per repo via .interlinked/guard-rules.local.json once you've vetted FP rate.
		enabled: false,
		command: "semgrep scan --quiet --no-git-ignore --metrics off --config p/default",
		file_types: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".py",
			".go",
			".rs",
			".java",
			".c",
			".cpp",
			".rb",
			".php",
		],
		timeout_ms: 30_000,
		severity: "warning",
		skip_test_files: true,
		description:
			"SAST analysis with Semgrep — detects security vulnerabilities, injection flaws, and code quality issues",
	},
	dependency_audit: {
		enabled: true,
		file_types: [
			"package.json",
			"package-lock.json",
			"yarn.lock",
			"pnpm-lock.yaml",
			"requirements.txt",
			"pyproject.toml",
			"Pipfile.lock",
			"Cargo.toml",
			"Cargo.lock",
			"go.sum",
			"go.mod",
		],
		timeout_ms: 30_000,
		severity: "warning",
		description:
			"SCA dependency audit — scans for known CVEs in project dependencies when lock/manifest files change",
	},
	gitleaks: {
		enabled: true,
		command: "gitleaks detect --no-git --no-banner -v",
		file_types: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".py",
			".go",
			".rs",
			".java",
			".c",
			".cpp",
			".rb",
			".php",
			".env",
			".yaml",
			".yml",
			".json",
			".toml",
			".cfg",
			".ini",
			".properties",
			".xml",
		],
		timeout_ms: 10_000,
		severity: "error",
		skip_test_files: true,
		description:
			"Secrets scanning with gitleaks — detects leaked credentials, API keys, and tokens (800+ patterns)",
	},
	prompt_injection: {
		// Off by default: fires too readily on legitimate prose (READMEs, prompts, docs).
		// Re-enable per repo via .interlinked/guard-rules.local.json when handling untrusted docs.
		enabled: false,
		file_types: [
			".md",
			".txt",
			".json",
			".yaml",
			".yml",
			".csv",
			".xml",
			".html",
			".htm",
			".rst",
		],
		timeout_ms: 1_000,
		severity: "warning",
		description:
			"Detect prompt injection patterns in file content (indirect injection via documents)",
	},
	// --- New tool-runner checks ---
	shellcheck: {
		enabled: true,
		command: "shellcheck --format=json1 --severity=warning",
		file_types: [".sh", ".bash", ".zsh", ".ksh"],
		timeout_ms: 5_000,
		severity: "warning",
		description:
			"Shell script analysis — quoting bugs, undefined variables, POSIX compliance",
	},
	actionlint: {
		enabled: true,
		command: "actionlint",
		file_types: [".yml", ".yaml"],
		timeout_ms: 5_000,
		severity: "warning",
		description:
			"GitHub Actions workflow validation — syntax, expressions, action versions",
	},
	hadolint: {
		enabled: true,
		command: "hadolint --format json",
		file_types: ["Dockerfile", ".dockerfile"],
		timeout_ms: 5_000,
		severity: "warning",
		description: "Dockerfile linting — best practices, missing USER, unpinned base images",
	},
	taplo: {
		enabled: true,
		command: "taplo check",
		file_types: [".toml"],
		timeout_ms: 5_000,
		severity: "error",
		description: "TOML validation — syntax errors in Cargo.toml, pyproject.toml, etc.",
	},
	// --- New inline checks ---
	css_syntax: {
		enabled: true,
		file_types: [".css", ".scss", ".less"],
		timeout_ms: 1_000,
		severity: "warning",
		description: "CSS syntax validation — brace matching, unclosed strings",
	},
	sql_syntax: {
		enabled: true,
		file_types: [".sql"],
		timeout_ms: 1_000,
		severity: "warning",
		description:
			"SQL syntax validation — unbalanced parens, SELECT *, DELETE/UPDATE without WHERE",
	},
	package_json_consistency: {
		enabled: true,
		file_types: ["package.json"],
		timeout_ms: 1_000,
		severity: "warning",
		description: "package.json consistency — duplicate deps, invalid semver",
	},
	lockfile_drift: {
		enabled: true,
		file_types: ["package.json", "Cargo.toml", "pyproject.toml"],
		timeout_ms: 1_000,
		severity: "warning",
		description: "Lockfile drift — manifest changed but lockfile not regenerated",
	},
	schema_drift: {
		enabled: true,
		file_types: [".sql"],
		timeout_ms: 2_000,
		severity: "warning",
		description: "Schema drift — SQL migration references columns not in schema definition",
	},
};
