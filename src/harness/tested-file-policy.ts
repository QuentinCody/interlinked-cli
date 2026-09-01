// ===========================================
// Tested-file policy — the single source of truth for the every-file-tested gate
// ===========================================
// Modeled EXACTLY on `large-file-policy.ts`. One module, one verify surface:
//   - verify : the `untested_files` check (commands/verify/file-checks.ts),
//              a report-only finding in the same enforcement tier as
//              `large_files` (the finding-count harness, not a per-section
//              process exit).
//
// A source file is "untested" when it has NEITHER a companion test file NOR
// line coverage at/above the threshold. The threshold and the grandfather list
// live in a checked-in JSON file, `.interlinked/untested-files-baseline.json`,
// so the current offenders are recorded once and the gate becomes a RATCHET:
// the list may shrink (a file gets a test or coverage and drops off) but a new
// untested file that is NOT on the list fails immediately.
//
// Why a synthesis of companion-presence AND coverage (vs. the two existing
// advisory checks `no_test_file` / `files_without_test`, which are
// companion-only): a file can be thoroughly exercised by integration tests
// without owning a sibling `*.test.ts`, and conversely a sibling test file can
// be a near-empty stub. Requiring EITHER axis is the honest "is this file
// actually tested" question; the two advisory checks stay as-is for the deep
// `--all-checks` audit.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { isGeneratedFile } from "./checks/shared.js";
import { stripCommentsAndStrings } from "./checks/shared-text-utils.js";
import { hasCompanionTest as hasAnyCompanionTest } from "./evaluator/companion-test.js";
import { hasTddExemptDirective, isTddExemptPath } from "./evaluator/tdd-new-file-gate.js";

/**
 * Default minimum line-coverage percent that counts a companion-less file as
 * "tested" on the coverage axis.
 *
 * THE canonical threshold. This constant and the committed baseline's
 * `min_coverage_pct` (.interlinked/untested-files-baseline.json) are the SAME
 * number — a regression test in `tested-file-policy.test.ts` pins them equal so
 * the threshold can never be two different values depending on whether a
 * baseline loaded. `evaluateTestedFile` reads the baseline value when present
 * and falls back to this constant when absent; keeping them equal means the
 * fallback is never a *different* threshold.
 *
 * 60% is deliberately modest: the gate's job is to flag files with essentially
 * no test exposure (no companion AND thin coverage), not to enforce a coverage
 * target — `coverage-ratchet` / `metrics` own the "drive coverage up" work.
 */
export const DEFAULT_MIN_COVERAGE_PCT = 60;

/** Repo-relative path of the baseline file. Module-private — callers go
 *  through `loadUntestedFilesBaseline` / `minCoverageFor`. */
const UNTESTED_BASELINE_REL = ".interlinked/untested-files-baseline.json";

/**
 * Source extensions whose test exposure we judge. Mirrors metrics'
 * `ANALYZABLE_EXT_RE` (tsx?/jsx?/mjs/cjs/py/rs/go) deliberately — NOT
 * tdd-new-file-gate's TS-only `SOURCE_EXT_RE`, which would let the companion
 * axis over-fire on a `.go` file that has no `*.test.go` sibling convention we
 * model. Path exclusions (tests, fixtures, declarations, landing/, …) come
 * from `isTddExemptPath`; this regex is purely the language gate.
 */
const TESTABLE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs|py|rs|go)$/;

/**
 * Benchmark sources — a `bench/` directory segment or a `.bench.<ext>` infix.
 * Vitest benchmarks measure performance against the public API; they are not
 * unit-test TARGETS themselves and own no companion-test convention, so the
 * every-file-tested gate exempts them (parallels `isTddExemptPath`'s exclusion
 * of `scripts/` and the test-path families, which don't cover `bench/`).
 */
const BENCH_PATH_RE = /(?:^|\/)bench\/|\.bench\.[cm]?[jt]sx?$/;

/** Per-file coverage threshold config + grandfather list. */
export interface UntestedFilesBaseline {
	/** Schema version. */
	version: number;
	/** Coverage % at/above which a companion-less file counts as tested. */
	min_coverage_pct: number;
	/**
	 * Grandfathered offenders: repo-relative POSIX paths currently untested.
	 * A listed file is allowed to stay untested; remove it once it gains a
	 * companion test or crosses the coverage threshold. The list may shrink
	 * but adding a new untested file (not listed) fails the gate.
	 */
	files: Set<string>;
}

let baselineCache = new Map<string, UntestedFilesBaseline | null>();

/**
 * Load `.interlinked/untested-files-baseline.json` for `cwd`. Memoized per
 * cwd (cheap for verify's hundreds of per-file calls). Fail-soft: a missing
 * or malformed file yields `null` — callers fall back to
 * `DEFAULT_MIN_COVERAGE_PCT` with no grandfathering.
 *
 * The cache is process-lifetime; the harness daemon picks up baseline edits on
 * restart (the standard post-edit `harness restart` flow). Tests can force a
 * reload via `resetUntestedFilesBaselineCache()`.
 */
export function loadUntestedFilesBaseline(cwd: string): UntestedFilesBaseline | null {
	const cached = baselineCache.get(cwd);
	if (cached !== undefined) return cached;

	let result: UntestedFilesBaseline | null = null;
	try {
		const path = join(cwd, UNTESTED_BASELINE_REL);
		if (existsSync(path)) {
			// `: unknown` annotation (not an `as` cast) narrows JSON.parse's
			// `any` return to `unknown` — normalizeBaseline validates it.
			const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
			result = normalizeBaseline(raw);
		}
	} catch {
		result = null; // malformed JSON -> default threshold, no grandfathering
	}
	baselineCache.set(cwd, result);
	return result;
}

/** Expected raw shape of a parsed baseline file — every field is `unknown`
 *  until validated by `normalizeBaseline`. */
interface RawBaseline {
	version?: unknown;
	min_coverage_pct?: unknown;
	files?: unknown;
}

/** Validate + normalize a parsed baseline; returns null when unusable. */
function normalizeBaseline(raw: unknown): UntestedFilesBaseline | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as RawBaseline;
	if (typeof obj.min_coverage_pct !== "number" || obj.min_coverage_pct < 0) return null;
	const files = new Set<string>();
	if (Array.isArray(obj.files)) {
		for (const entry of obj.files) {
			if (typeof entry === "string" && entry.length > 0) {
				files.add(entry.replace(/\\/g, "/"));
			}
		}
	}
	return {
		version: typeof obj.version === "number" ? obj.version : 1,
		min_coverage_pct: obj.min_coverage_pct,
		files,
	};
}

/** Clear the memoized baseline (after writing/regenerating the file). */
export function resetUntestedFilesBaselineCache(): void {
	baselineCache = new Map();
}

/**
 * Persist a baseline to `.interlinked/untested-files-baseline.json` for `cwd`.
 * The writer half of `loadUntestedFilesBaseline` (mirrors
 * `large-file-policy.ts::saveLargeFileBaseline` — the two orphan water-lines
 * gained their creation path together). Used by `interlinked adopt`, the
 * human-invoked bootstrap: plain `fs` writes from the CLI process never pass
 * through the PreToolUse baseline-integrity gate.
 *
 * The exemption Set serializes as a sorted array (the on-disk schema
 * `normalizeBaseline` reads back), so re-runs produce stable, diff-friendly
 * output. The loader cache is invalidated so a subsequent
 * `loadUntestedFilesBaseline` in the same process sees the new state.
 */
export function saveUntestedFilesBaseline(cwd: string, baseline: UntestedFilesBaseline): void {
	const path = join(cwd, UNTESTED_BASELINE_REL);
	mkdirSync(dirname(path), { recursive: true });
	const payload = {
		version: baseline.version,
		min_coverage_pct: baseline.min_coverage_pct,
		files: [...baseline.files].map((f) => f.replace(/\\/g, "/")).sort(),
	};
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	resetUntestedFilesBaselineCache();
}

/** The active coverage threshold for `cwd` (baseline override, else default). */
export function minCoverageFor(cwd: string): number {
	return loadUntestedFilesBaseline(cwd)?.min_coverage_pct ?? DEFAULT_MIN_COVERAGE_PCT;
}

/**
 * Content marker exempting a file from the every-file-tested gate without the
 * blanket `@generated` semantics. Reused verbatim from `large-file-policy.ts`
 * (same constant, same bounded header scan) so the two file-policy gates agree
 * on what "codegen DATA" means. Covers the `src/lib/hook-template-chunks/*`
 * modules whose bodies are template STRINGS spliced into the generated `.mjs`
 * hook script: there is no hand-written runtime logic to test — the file is a
 * data carrier for the emitted artifact.
 */
const CODEGEN_DATA_MARKER = "@codegen-data";

/** Bounded header scan (first 20 lines), mirroring `isGeneratedFile` /
 *  `large-file-policy.ts` — the marker must sit in the file header. */
function hasCodegenDataMarker(content: string): boolean {
	return content.split("\n", 20).join("\n").includes(CODEGEN_DATA_MARKER);
}

/**
 * Logic tokens whose presence (outside comments/strings) means the module has
 * executable behavior worth testing. `=>` and `function` cover function/arrow
 * definitions; the control-flow keywords cover any executable body. A `new X()`
 * or a bare call in a `const` initializer is deliberately NOT a logic token —
 * those occur in pure-data initializers (`new RegExp(...)`, `new Set([...])`)
 * and don't introduce a testable function. Verified against the TypeScript AST:
 * every baseline module this predicate calls "data-only" has zero function-like
 * AST nodes.
 */
const LOGIC_TOKEN_RE = /\b(?:function|return|if|for|while|switch|throw|try|catch|await|yield|do)\b|=>/;

/** A module that actually declares something (a value or a type). Guards against
 *  calling an empty / pure-side-effect file "data-only". */
const DATA_DECLARATION_RE = /\b(?:const|enum|type|interface)\b/;

/**
 * Whether a TS module is a pure DATA / type-only module — exports only `const`
 * data records/arrays/strings/regex and `type`/`interface`/`enum` declarations,
 * with NO top-level function, arrow, method, or control-flow logic. Such a
 * module has nothing behavioral to unit-test (tsc already validates the shapes);
 * the check-metadata records, the built-in guard-rule arrays, and the like fall
 * here. CONSERVATIVE: comments and string/template-literal bodies are stripped
 * first (so the word "function" inside a `description:` string doesn't count),
 * then ANY surviving logic token marks the module testable. A regex literal's
 * body is NOT stripped, so a data module whose regex happens to contain a logic
 * keyword reads as testable — the failure mode is "kept in the baseline", never
 * "wrongly exempted". For those few, an explicit `// interlinked-tdd: exempt`
 * marker is the documented escape hatch. TS-only by extension: `interface`/
 * `type`/`const` aren't reliable data markers in Go/Rust/Python.
 */
function isDataOnlyModule(filePath: string, content: string): boolean {
	if (!/\.(?:ts|tsx|mts|cts)$/i.test(filePath)) return false;
	const code = stripCommentsAndStrings(content);
	if (LOGIC_TOKEN_RE.test(code)) return false;
	return DATA_DECLARATION_RE.test(code);
}

/**
 * Whether the every-file-tested gate applies to this file. True only for
 * hand-written source modules with genuinely testable runtime behavior.
 *
 * Exemptions, in order:
 *   - extension gate: only the coverage-adapter languages (tsx?/jsx?/mjs/cjs/
 *     py/rs/go); everything else (md/json/…) is out of scope.
 *   - path exclusions (tests, fixtures, declarations, generated dirs,
 *     landing/web/site, scripts, node_modules, .claude/.interlinked, config
 *     files) — delegated to `isTddExemptPath` so the exempt set stays
 *     single-sourced with the TDD gate.
 *   - benchmark sources (`bench/`, `*.bench.*`) via `BENCH_PATH_RE` — perf
 *     measurements, not unit-test targets.
 *   - the `// interlinked-tdd: exempt` content directive (same convention the
 *     TDD gate honors) — for genuinely-untestable surfaces the heuristics below
 *     don't cleanly catch.
 *   - the `@codegen-data` header marker (shared with `large-file-policy.ts`) —
 *     codegen DATA modules (template-string carriers).
 *   - `@generated` files (via `isGeneratedFile`) — no hand-written logic.
 *   - pure DATA / type-only modules (`isDataOnlyModule`).
 *
 * Mirrors `large-file-policy.ts::isCappableFile`'s `{ filePath, content }`
 * shape: the content-based exemptions need the file body.
 */
export function isTestableSourceFile(file: { filePath: string; content: string }): boolean {
	const norm = file.filePath.replace(/\\/g, "/");
	if (!TESTABLE_EXT_RE.test(norm)) return false;
	if (isTddExemptPath(norm)) return false;
	if (BENCH_PATH_RE.test(norm)) return false;
	if (hasTddExemptDirective(file.content)) return false;
	if (hasCodegenDataMarker(file.content)) return false;
	if (isGeneratedFile(file.content)) return false;
	if (isDataOnlyModule(norm, file.content)) return false;
	return true;
}

/** Whether a companion test file exists on disk for `relPath`. `cwd` resolves
 *  the relative path to absolute and doubles as the project root for
 *  separate-tree layouts. Delegates to the shared qualified-name predicate
 *  (`evaluator/companion-test.ts`), which subsumes the infixed conventions
 *  this module used to enumerate by hand (`<base>.coverage.test`,
 *  `<base>.fixtures.test`) — ANY `<base>.<qualifier>.test/.spec` now counts. */
export function hasCompanionTest(relPath: string, cwd: string): boolean {
	const abs = isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
	return hasAnyCompanionTest(abs, cwd);
}

/** Verify-side verdict for a single file's test exposure. */
export interface TestedFileVerdict {
	/** No companion test AND coverage below threshold (or absent). */
	untested: boolean;
	/** Listed in the baseline — recorded offender, does not fail the gate. */
	grandfathered: boolean;
}

/**
 * Judge a single file's test exposure against the companion-presence axis, the
 * coverage axis, and the grandfather list. Used by the `untested_files` verify
 * check.
 *
 * Untested iff there is NO companion test AND (coverage is absent — `null`,
 * meaning the file appears nowhere in the coverage report — OR coverage is
 * below the threshold). A `null` coverage is treated as untested rather than
 * fail-open: a source file the coverage report never mentions ran zero of its
 * lines under the suite, which is exactly the "essentially no test exposure"
 * case the gate targets. The companion axis is the escape hatch — a file with
 * a sibling test passes regardless of coverage data availability.
 */
export function evaluateTestedFile(args: {
	input: { relPath: string; hasCompanion: boolean; coveragePct: number | null };
	baseline: UntestedFilesBaseline | null;
}): TestedFileVerdict {
	const { relPath, hasCompanion, coveragePct } = args.input;
	const threshold = args.baseline?.min_coverage_pct ?? DEFAULT_MIN_COVERAGE_PCT;
	const coveredEnough = coveragePct !== null && coveragePct >= threshold;
	const untested = !hasCompanion && !coveredEnough;
	const grandfathered =
		untested && (args.baseline?.files.has(relPath.replace(/\\/g, "/")) ?? false);
	return { untested, grandfathered };
}
