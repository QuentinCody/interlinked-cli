// ===========================================
// Coverage Adapters — per-language LCOV producers
// ===========================================
// An adapter answers exactly two questions for one language / framework:
//   1. "Is this language present in the project?"  → detection (markers)
//   2. "What command makes its native coverage engine emit ITS LCOV report?"
//
// Everything *after* that — parse, normalize, ratchet, CRAP, the per-test map —
// is shared and written once:
//   native engine → LCOV → coverage-lcov.ts → coverage-canonical.ts → coverage-ratchet.ts
// because LCOV is the single interchange format. Adapters therefore never parse
// a language-specific report shape and never reimplement instrumentation; they
// WRAP the native engine (vitest/v8, coverage.py, cargo-llvm-cov, gcov, …) and
// point its LCOV reporter at a PER-LANGUAGE path — every adapter once wrote the
// one canonical `coverage/lcov.info`, so in a polyglot repo each language's run
// CLOBBERED the previous one's report and the ratchet/metrics silently lost a
// language (finding 2026-06). The readers (`commands/coverage.ts`,
// `commands/metrics.ts`) MERGE every existing report via
// {@link lcovReportPaths}. Two languages flowing through the one parser is the
// proof the architecture is language-agnostic
// (docs/plans/13-test-quality-suite-implementation-plan.md §C4).
//
// Pure + dependency-free apart from filesystem existence checks for detection,
// mirroring `language-profiles.ts`. No formatting/ANSI lives here — rendering is
// the caller's job (e.g. `commands/coverage.ts`).

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The legacy/aggregate repo-relative LCOV path. Adapters no longer WRITE here
 * (each owns a per-language path — finding 2026-06: shared output clobbered),
 * but it stays FIRST among the read candidates: a project whose own tooling is
 * configured to emit `coverage/lcov.info` (this repo's vitest.config does) keeps
 * working unchanged, and pre-fix reports remain readable.
 */
export const CANONICAL_LCOV_PATH = "coverage/lcov.info";

/** How one language's native coverage engine is wrapped to emit LCOV. */
interface CoverageAdapter {
	/** Stable id, e.g. `"javascript"` | `"python"`. */
	id: string;
	/** Human-readable language name, for guidance output. */
	language: string;
	/** The native engine this adapter wraps (never reimplements). */
	engine: string;
	/**
	 * Project-root files that signal this language is in use. Detection is an
	 * any-match against these in the project root — mirroring
	 * `language-profiles.ts` `project_root_markers`, plus coverage-specific
	 * signals (`.coveragerc`, `pytest.ini`) that strengthen the guess.
	 */
	markers: string[];
	/**
	 * Command that produces this language's LCOV report from a clean checkout. It
	 * runs the suite under the native engine and points the engine's LCOV
	 * reporter at `reportRelPath`. Self-contained where possible so it works
	 * without any project-specific coverage config.
	 */
	lcovCommand: string;
	/**
	 * Variant that ALSO records the native per-test map — "which tests cover
	 * which line" (the P2 keystone in the plan). `null` when the engine has no
	 * first-class per-test context exposed through a single flag.
	 */
	perTestLcovCommand: string | null;
	/** Where `lcovCommand` writes the report — PER-LANGUAGE and unique across
	 *  adapters (pinned by a regression test), so polyglot runs never clobber
	 *  each other's reports (finding 2026-06). Readers merge every existing
	 *  report via {@link lcovReportPaths}. */
	reportRelPath: string;
}

// ===========================================
// Adapter definitions
// ===========================================

/**
 * TypeScript / JavaScript via vitest + `@vitest/coverage-v8`. The reporter +
 * output dir are passed on the CLI so the command emits `coverage/lcov.info`
 * even in a project without a coverage block configured (this repo configures
 * both in `vitest.config.ts`, so a bare `vitest run --coverage` also works).
 *
 * Per-test attribution from V8's test-lifecycle is not exposed through a single
 * flag, so the per-test map for JS falls back to the file-level dependency
 * graph (plan P2) — hence `perTestLcovCommand: null`.
 */
const JAVASCRIPT_ADAPTER: CoverageAdapter = {
	id: "javascript",
	language: "TypeScript / JavaScript",
	engine: "vitest + @vitest/coverage-v8",
	markers: ["package.json", "tsconfig.json", "vitest.config.ts", "vite.config.ts"],
	// The lcov reporter's filename is fixed (`lcov.info`), so the per-language
	// separation rides the reports DIRECTORY (finding 2026-06: writing the shared
	// coverage/ dir clobbered the other languages' reports).
	lcovCommand:
		"npx vitest run --coverage --coverage.reporter=lcov --coverage.reportsDirectory=coverage/javascript",
	perTestLcovCommand: null,
	reportRelPath: "coverage/javascript/lcov.info",
};

/**
 * Python via coverage.py. `coverage lcov` (coverage.py ≥ 6.3) exports the
 * `.coverage` data file as LCOV; `-o` directs it at the canonical path. This is
 * the literal `coverage.py → coverage lcov` path the plan names.
 *
 * The per-test variant uses pytest-cov's `--cov-context=test`, which records a
 * dynamic coverage context per test function — coverage.py's NATIVE per-test
 * map, carried through the LCOV export. It is the strongest per-test signal of
 * any engine the suite targets, which is why Python leads the adapter rollout.
 */
const PYTHON_ADAPTER: CoverageAdapter = {
	id: "python",
	language: "Python",
	engine: "coverage.py",
	markers: [
		"pyproject.toml",
		"setup.py",
		"setup.cfg",
		"requirements.txt",
		"Pipfile",
		".coveragerc",
		"pytest.ini",
		"tox.ini",
	],
	lcovCommand: "coverage run -m pytest && coverage lcov -o coverage/lcov-python.info",
	perTestLcovCommand: "pytest --cov --cov-context=test --cov-report=lcov:coverage/lcov-python.info",
	reportRelPath: "coverage/lcov-python.info",
};

/**
 * Rust via cargo-llvm-cov. `cargo llvm-cov --lcov --output-path …` runs the
 * test suite under LLVM source-based coverage and exports LCOV directly — the
 * native engine wrapped, no reimplementation.
 *
 * LLVM source-based coverage has no single-flag per-test context (unlike
 * coverage.py), so the per-test map falls back to the file-level dependency
 * graph (plan P2) — hence `perTestLcovCommand: null`, same posture as JS.
 */
const RUST_ADAPTER: CoverageAdapter = {
	id: "rust",
	language: "Rust",
	engine: "cargo-llvm-cov (LLVM source-based coverage)",
	markers: ["Cargo.toml"],
	lcovCommand: "cargo llvm-cov --lcov --output-path coverage/lcov-rust.info",
	perTestLcovCommand: null,
	reportRelPath: "coverage/lcov-rust.info",
};

/**
 * Registry, in detection-precedence order. Each new language is one appended
 * entry — JS (vitest/v8), Python (coverage.py), Rust (cargo-llvm-cov) ship;
 * Go (`go test -coverprofile` → lcov) and Java (JaCoCo → genhtml) are the same
 * shape. The parser and ratchet downstream are untouched by any addition.
 */
export const COVERAGE_ADAPTERS: readonly CoverageAdapter[] = [
	JAVASCRIPT_ADAPTER,
	PYTHON_ADAPTER,
	RUST_ADAPTER,
];

// ===========================================
// Detection
// ===========================================

/** True when any of the adapter's markers exists directly in `dir`. */
function adapterMatches(dir: string, adapter: CoverageAdapter): boolean {
	return adapter.markers.some((marker) => existsSync(join(dir, marker)));
}

/**
 * Every adapter whose language is present in the project root `cwd`. A polyglot
 * repo (this one — `package.json` + a future `pyproject.toml`) returns more than
 * one; an empty / unrecognized directory returns `[]`.
 */
export function detectCoverageAdapters(cwd: string): CoverageAdapter[] {
	return COVERAGE_ADAPTERS.filter((adapter) => adapterMatches(cwd, adapter));
}

/**
 * The single best-guess adapter for `cwd`, or `null` if none detected. Registry
 * order is the only tie-break, so this is meaningful only in a polyglot root;
 * callers that want every match use `detectCoverageAdapters`.
 */
export function detectCoverageAdapter(cwd: string): CoverageAdapter | null {
	return detectCoverageAdapters(cwd)[0] ?? null;
}

/** Look up an adapter by id (e.g. for an explicit `--language` override). */
export function coverageAdapterById(id: string): CoverageAdapter | null {
	return COVERAGE_ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

/**
 * Every repo-relative LCOV path a reader should consider: the legacy/aggregate
 * canonical path first (a project's own tooling may still emit it), then each
 * adapter's per-language report. Readers parse ALL that exist and MERGE —
 * one language's run must never shadow another's (finding 2026-06).
 */
export function lcovReportPaths(): string[] {
	return [...new Set([CANONICAL_LCOV_PATH, ...COVERAGE_ADAPTERS.map((a) => a.reportRelPath)])];
}

// ===========================================
// Guidance
// ===========================================

/**
 * Plain-text (no ANSI) "here's how to produce a coverage report" guidance,
 * tailored to the languages actually detected in `cwd`. When detection finds
 * nothing, every adapter is listed so the user still sees their options.
 *
 * Returned as data, not printed, so any surface (the coverage command's
 * no-report message, a future Stop nudge) can render it however it likes.
 */
export function coverageSetupGuidance(cwd: string): string {
	const detected = detectCoverageAdapters(cwd);
	const adapters = detected.length > 0 ? detected : COVERAGE_ADAPTERS;
	const lines: string[] = [];
	for (const adapter of adapters) {
		lines.push(`  ${adapter.language} (${adapter.engine}):`);
		lines.push(`    ${adapter.lcovCommand}`);
		if (adapter.perTestLcovCommand) {
			lines.push(`    # with the per-test map: ${adapter.perTestLcovCommand}`);
		}
	}
	return lines.join("\n");
}
