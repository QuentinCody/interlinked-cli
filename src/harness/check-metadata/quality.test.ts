import { describe, expect, it } from "vitest";
import { QUALITY_CHECK_META } from "./quality.js";
import type { CheckMeta } from "./types.js";

// Keep the quality metadata contract executable. The generic shape test only
// proves that values have the right broad types; this table catches a check's
// public name, documentation, tier, determinism, and optional classification
// silently drifting or being dropped.
const EXPECTED: Record<string, CheckMeta> = {
	lint_import: {
		name: "Imported Lint",
		description: "Original project linters scheduled after edits with a tighten-only finding baseline",
		tier: 1,
		determinism: "partially_deterministic",
		externality: "local_write",
	},
	typescript: {
		name: "TypeScript",
		description: "TypeScript type checking after file edits",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	biome_lint: {
		name: "Biome Lint",
		description: "Biome lint check after file edits",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	eslint: {
		name: "ESLint",
		description: "ESLint check (used when project has eslint, not biome)",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	secrets_in_source: {
		name: "Secrets in Source",
		description: "Detect secrets written into source files",
		tier: 1,
		determinism: "fully_deterministic",
		asi: "ASI05",
		externality: "local_write",
	},
	strong_typing: {
		name: "Strong Typing",
		description: "Detect explicit `any` and `unknown` types",
		tier: 2,
		determinism: "heuristic",
	},
	software_version_regression: {
		name: "Software Version Regression",
		description:
			"Detect likely stale-memory downgrades of package versions, model IDs, Docker tags, GitHub Action versions, API dates, and common runtime/config version assignments",
		tier: 1,
		determinism: "heuristic",
		asi: "ASI04",
	},
	freshness_sensitive_reference: {
		name: "Freshness-Sensitive Reference",
		description:
			"Flag newly introduced model/API/software references that need verification against official current sources",
		tier: 2,
		determinism: "heuristic",
	},
	strict_typing_block: {
		name: "Strict Typing Block",
		description:
			"PreToolUse hard-block on new type-erasure patterns (`as any`, `as unknown as`, unjustified `@ts-ignore`/`@ts-expect-error`, bare `: any`). Off by default — opt in to enforce.",
		tier: 1,
		determinism: "partially_deterministic",
	},
	affected_tests: {
		name: "Affected Tests",
		description: "Run a shared affected-test plan; widen uncertain dependencies and retain deferred work",
		tier: 2,
		determinism: "fully_deterministic",
	},
	inline_language_checks: {
		name: "Inline Language Checks",
		description:
			"Per-language inline pattern checks (Python bare except, Rust .unwrap()/unsafe, Go ignored err, Swift force unwrap/cast/try, Java wildcard import, C/C++ unsafe functions)",
		tier: 1,
		determinism: "fully_deterministic",
	},
	python_typecheck: {
		name: "Python Typecheck",
		description: "Python type checking with mypy",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	ruff_lint: {
		name: "Ruff Lint",
		description: "Python linting with ruff",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	ruff_format: {
		name: "Ruff Format",
		description: "Python formatting check (ruff format --check)",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	cargo_check: {
		name: "Cargo Check",
		description: "Rust compilation check",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	cargo_clippy: {
		name: "Cargo Clippy",
		description: "Rust linting with clippy",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	rustfmt_check: {
		name: "Rustfmt",
		description: "Rust formatting check (rustfmt --check)",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	go_build: {
		name: "Go Build",
		description: "Go compilation check",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	golangci_lint: {
		name: "Golangci-lint",
		description: "Go linting with golangci-lint",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	c_compile: {
		name: "C/C++ Compile",
		description: "C/C++ compilation check",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	clang_tidy: {
		name: "Clang-Tidy",
		description: "C/C++ linting with clang-tidy",
		tier: 1,
		determinism: "fully_deterministic",
		externality: "local_write",
	},
	semgrep: {
		name: "Semgrep",
		description: "SAST analysis with Semgrep",
		tier: 2,
		determinism: "fully_deterministic",
		asi: "ASI05",
	},
	dependency_audit: {
		name: "Dependency Audit",
		description: "SCA dependency audit for known CVEs",
		tier: 2,
		determinism: "fully_deterministic",
		asi: "ASI04",
	},
	gitleaks: {
		name: "Gitleaks",
		description: "Secrets scanning with gitleaks",
		tier: 1,
		determinism: "fully_deterministic",
		asi: "ASI05",
	},
	prompt_injection: {
		name: "Prompt Injection",
		description: "Detect prompt injection patterns in file content",
		tier: 2,
		determinism: "heuristic",
		asi: "ASI06",
	},
	shellcheck: {
		name: "ShellCheck",
		description: "Shell script analysis",
		tier: 1,
		determinism: "fully_deterministic",
	},
	actionlint: {
		name: "Actionlint",
		description: "GitHub Actions workflow validation",
		tier: 1,
		determinism: "fully_deterministic",
	},
	hadolint: {
		name: "Hadolint",
		description: "Dockerfile linting",
		tier: 1,
		determinism: "fully_deterministic",
	},
	taplo: {
		name: "Taplo",
		description: "TOML validation",
		tier: 1,
		determinism: "fully_deterministic",
	},
	css_syntax: {
		name: "CSS Syntax",
		description: "CSS syntax validation — brace matching, unclosed strings",
		tier: 2,
		determinism: "fully_deterministic",
	},
	sql_syntax: {
		name: "SQL Syntax",
		description: "SQL syntax validation — unbalanced parens, SELECT *, DELETE without WHERE",
		tier: 2,
		determinism: "fully_deterministic",
	},
	package_json_consistency: {
		name: "Package JSON Consistency",
		description: "package.json consistency — duplicate deps, invalid semver",
		tier: 2,
		determinism: "fully_deterministic",
	},
	lockfile_drift: {
		name: "Lockfile Drift",
		description: "Lockfile drift — manifest changed but lockfile not regenerated",
		tier: 2,
		determinism: "fully_deterministic",
		asi: "ASI04",
	},
	schema_drift: {
		name: "Schema Drift",
		description: "Schema drift — SQL migration references columns not in schema definition",
		tier: 2,
		determinism: "fully_deterministic",
	},
};

describe("QUALITY_CHECK_META", () => {
	// test-contract: public-api — the exported quality-check catalog must retain each documented key and its exact user-facing metadata
	it("preserves the exact public metadata contract for every quality check", () => {
		expect(QUALITY_CHECK_META).toEqual(EXPECTED);
	});
});
