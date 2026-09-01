// ===========================================
// Per-file check battery
// ===========================================
// Applies every generic + taste check to a single file's content and
// appends findings to the shared `CodeQualityResults`. This is the bulk of
// `runCodeQualityChecks` — extracted into its own module so `tool-results.ts`
// stays under the 800-line file-size threshold.
//
// `runPerFileChecks` is a thin orchestrator: it runs the core checks that
// need shared local state (large-file cap, JSON-validity early return, strong
// typing, phantom imports, env-ref accumulation, mock drift) inline, then
// fans the remaining ~200 stateless detectors out to per-group helpers in the
// sibling `file-checks-<group>.ts` modules. Each helper takes the shared
// `FileCheckContext` and mutates `r` in place. Because every `r.<bucket>`
// array is independent, the only ordering that matters is per-bucket
// statement order — preserved verbatim across the split.

import { basename, extname, relative } from "node:path";
import { isGeneratedFile } from "../../harness/checks/shared.js";
import {
	checkConsoleDebug,
	checkFunctionComplexity,
	checkMissingReturnTypes,
	checkSilentCatch,
	checkTestFileExists,
	checkTestRegressions,
	checkTsconfigStrictness,
	extractEnvReferences,
	extractMockDefinitions,
} from "../../harness/generic-checks.js";
import {
	countLines,
	evaluateLargeFile,
	isCappableFile,
	loadLargeFileBaseline,
	maxLinesFor,
} from "../../harness/large-file-policy.js";
import {
	computeFunctionTokens,
	functionTokenAnalyzerStatus,
} from "../../harness/function-tokens/index.js";
import { maxFunctionTokensFor } from "../../harness/metric-caps.js";
import { parseImports, resolveImportPath } from "../../harness/project-graph.js";
import { findAnyTypes } from "../../harness/quality-checks.js";
import {
	type InlineSuppressions,
	isSuppressed,
	scanInlineSuppressions,
} from "../../harness/suppressions.js";
import {
	evaluateTestedFile,
	hasCompanionTest,
	isTestableSourceFile,
	loadUntestedFilesBaseline,
} from "../../harness/tested-file-policy.js";
import { loadMetricsCoverage, type MetricsCoverage } from "../metrics.js";
import { JS_TS_EXTS } from "./advisory.js";
import { runAgentSafetyChecks, runCrapCheck } from "./file-checks-agent-safety.js";
import { runTypeRedundancyChecks } from "./file-checks-type-redundancy.js";
import { runEndpointAndLazinessChecks } from "./file-checks-endpoint-laziness.js";
import { runReactAndTasteChecks } from "./file-checks-react-test.js";
import type { FileCheckContext, PiiOpts } from "./file-checks-shared.js";
import { toIssues } from "./file-checks-shared.js";
import { runUbsChecks } from "./file-checks-ubs.js";
import { collectSuppressionFindings } from "./suppressions.js";
import type { CodeQualityIssue, CodeQualityResults } from "./tool-results-types.js";
import { CQ_RESULT_KEYS } from "./tool-results-types.js";

export type { FileCheckContext, PiiOpts };

const JSON_EXT = ".json";
const TS_EXT = ".ts";
const TSX_EXT = ".tsx";
const DTS_SUFFIX = ".d.ts";
const ANY_KIND = "any";
const JSON_PARSE_ERR_SLICE = 150;

interface MockDriftArgs {
	mocks: ReturnType<typeof extractMockDefinitions>;
	moduleExportsCache: Map<string, string[]>;
	file: string;
	relPath: string;
	cwd: string;
	out: CodeQualityIssue[];
}

/**
 * Compare mock definitions in a test file against the real module exports we
 * cached earlier, and emit a finding when a mock references a name that is
 * NOT exported.
 */
function collectMockDriftFindings(args: MockDriftArgs): void {
	const { mocks, moduleExportsCache, file, relPath, cwd, out } = args;
	for (const mock of mocks) {
		const resolved = resolveImportPath(file, mock.modulePath);
		if (!resolved) continue;
		const cachedExports = moduleExportsCache.get(resolved);
		if (!cachedExports) continue;
		const exportSet = new Set(cachedExports);
		const missing = mock.mockedNames.filter((name) => !exportSet.has(name));
		if (missing.length === 0) continue;
		for (const name of missing) {
			out.push({
				check: "mock_drift",
				file: relPath,
				line: mock.line,
				message: `mock references "${name}" which is not exported by "${relative(cwd, resolved)}"`,
			});
		}
	}
}

interface RunFileChecksArgs {
	file: string;
	content: string;
	cwd: string;
	r: CodeQualityResults;
	moduleExportsCache: Map<string, string[]>;
	allEnvRefs: Map<string, Array<{ file: string; line: number }>>;
	piiOpts: PiiOpts;
}

/**
 * Public API — consumed by `tool-results.ts`.
 *
 * Run every per-file check against a single file. Mutates `r` in place.
 * Returns early for `.d.ts` files and for JSON files (after validating them).
 *
 * Inline `// interlinked-ignore: <check> — <reason>` comments are honored on
 * the DEFAULT gate here (previously only the scored `--suggestions` path
 * respected them). We snapshot every result bucket's length before running the
 * per-file detectors, then drop any newly-added finding whose `(line, check)`
 * pair is suppressed by an inline-ignore on that line. Tool-based findings
 * (tsc/biome/etc.) are produced elsewhere and are untouched.
 */
export function runPerFileChecks(args: RunFileChecksArgs): void {
	const { content, r } = args;

	// Snapshot bucket lengths so the post-pass only re-examines findings this
	// file contributed — accumulated findings from earlier files are left alone.
	// Production callers pass the full `emptyResults()` object; the `?? 0` guard
	// only matters for partial test fixtures that omit some buckets.
	const before = new Map<keyof CodeQualityResults, number>();
	for (const key of CQ_RESULT_KEYS) before.set(key, r[key]?.length ?? 0);

	collectPerFileFindings(args);

	// Files with no ignore comments take a fast path: scanInlineSuppressions
	// returns an empty map and we change nothing.
	const inlineSuppressions = scanInlineSuppressions(content);
	if (inlineSuppressions.size === 0) return;

	dropInlineSuppressed(r, before, inlineSuppressions);
}

/**
 * Drop the just-added inline-check findings (per bucket, from each bucket's
 * pre-run length onward) whose `(line, check)` matches an inline-ignore comment.
 * The check-name match is case-insensitive — `scanInlineSuppressions`
 * lower-cases the names it parses, so we lower-case the finding's `check` too.
 */
function dropInlineSuppressed(
	r: CodeQualityResults,
	before: Map<keyof CodeQualityResults, number>,
	inlineSuppressions: InlineSuppressions,
): void {
	const NO_FILE_SUPPRESSIONS = new Set<string>();
	for (const key of CQ_RESULT_KEYS) {
		const start = before.get(key) ?? 0;
		const bucket = r[key];
		// Defensive: production passes the full `emptyResults()`; a partial test
		// fixture may omit a bucket entirely.
		if (!bucket || bucket.length === start) continue; // nothing new for this file
		const kept = bucket
			.slice(start)
			.filter(
				(issue) =>
					!isSuppressed(
						issue.check.toLowerCase(),
						issue.line,
						inlineSuppressions,
						NO_FILE_SUPPRESSIONS,
					),
			);
		bucket.length = start;
		bucket.push(...kept);
	}
}

/**
 * Oversized written-code files — enforced cap (default gate). Generated,
 * test, .d.ts and non-code files are exempt; files in the baseline are
 * grandfathered up to their recorded size (a ratchet — they may shrink
 * or hold but not grow). See harness/large-file-policy.ts.
 */
function collectLargeFileFinding(file: string, content: string, cwd: string, relPath: string, r: CodeQualityResults): void {
	if (!isCappableFile({ filePath: file, content })) return;
	const baseline = loadLargeFileBaseline(cwd);
	// The EFFECTIVE cap — `maxLinesFor` layers the `.interlinked/metric-caps.json`
	// override (`interlinked caps set lines`) over the baseline. verify previously
	// passed only the baseline, so a lowered cap was honored at write/nudge time
	// but silently IGNORED here (finding 2026-06, round 8). Grandfathering still
	// comes from `baseline.files` inside evaluateLargeFile.
	const cap = maxLinesFor(cwd);
	const verdict = evaluateLargeFile({ relPath, lines: countLines(content), baseline, maxLines: cap });
	if (!verdict.overCap || verdict.grandfathered) return;
	r.largeFiles.push({
		check: "large_files",
		file: relPath,
		line: 0,
		message: `${verdict.lines} lines — over the ${cap}-line cap for hand-written code. Split into smaller, focused modules.`,
	});
}

function collectFunctionTokenFindings(
	file: string,
	content: string,
	cwd: string,
	relPath: string,
	r: CodeQualityResults,
): void {
	if (!isCappableFile({ filePath: file, content, root: cwd })) return;
	const entries = computeFunctionTokens(content, file);
	if (entries === null) {
		const status = functionTokenAnalyzerStatus(file);
		if (status.language === "unknown") return;
		r.complexity.push({
			check: "function_tokens_not_measured",
			file: relPath,
			line: 0,
			message: `${status.language} functions not measured: ${status.reason ?? "exact analyzer unavailable"}`,
		});
		return;
	}
	const cap = maxFunctionTokensFor(cwd);
	for (const entry of entries) {
		if (entry.canonicalTokens <= cap) continue;
		r.complexity.push({
			check: "function_tokens",
			file: relPath,
			line: entry.line,
			message:
				`${entry.qualifiedName} has ${entry.canonicalTokens} canonical code tokens ` +
				`(cap ${cap}, tokenizer interlinked-code-v1). Split it into cohesive named helpers.`,
		});
	}
}

/**
 * Per-cwd memo for the coverage accessor. `loadMetricsCoverage` parses the
 * istanbul/LCOV report; the per-file battery calls `collectUntestedFileFinding`
 * hundreds of times in one verify run, so we load the accessor once per cwd
 * (mirrors `loadLargeFileBaseline`'s cwd-keyed cache). Process-lifetime; tests
 * reset via `resetUntestedCoverageCache()`.
 */
let untestedCoverageCache = new Map<string, MetricsCoverage>();

function coverageFor(cwd: string): MetricsCoverage {
	const cached = untestedCoverageCache.get(cwd);
	if (cached) return cached;
	const cov = loadMetricsCoverage(cwd);
	untestedCoverageCache.set(cwd, cov);
	return cov;
}

/** Clear the memoized per-cwd coverage accessor (test seam). */
export function resetUntestedCoverageCache(): void {
	untestedCoverageCache = new Map();
}

/**
 * Source files with NEITHER a companion test NOR coverage at/above the
 * threshold — the every-file-tested ratchet (default gate, report-only tier,
 * same as `large_files`). Current offenders are grandfathered in
 * `.interlinked/untested-files-baseline.json`; the list may shrink but a new
 * untested file fails immediately. See harness/tested-file-policy.ts.
 */
function collectUntestedFileFinding(
	file: string,
	cwd: string,
	relPath: string,
	r: CodeQualityResults,
	content: string,
): void {
	const rel = relPath.replace(/\\/g, "/");
	if (!isTestableSourceFile({ filePath: rel, content })) return;
	const baseline = loadUntestedFilesBaseline(cwd);
	const verdict = evaluateTestedFile({
		input: {
			relPath: rel,
			hasCompanion: hasCompanionTest(file, cwd),
			coveragePct: coverageFor(cwd).linePct(rel),
		},
		baseline,
	});
	if (!verdict.untested || verdict.grandfathered) return;
	r.untestedFiles.push({
		check: "untested_files",
		file: relPath,
		line: 0,
		message:
			"no companion test and line coverage below threshold — add a sibling " +
			"*.test file or cover it from an existing suite.",
	});
}

/**
 * JSON-file handling: parse-validity finding + tsconfig strictness. Returns
 * `true` when the file was a `.json` (caller must then short-circuit the rest
 * of the per-file battery, preserving the original early-return semantics).
 */
function collectJsonFindings(file: string, content: string, ext: string, relPath: string, r: CodeQualityResults): boolean {
	if (ext !== JSON_EXT) return false;
	try {
		JSON.parse(content);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		r.jsonValidity.push({
			check: "json_validity",
			file: relPath,
			line: 0,
			message: msg.slice(0, JSON_PARSE_ERR_SLICE),
		});
	}
	// tsconfig*.json strictness check — runs BEFORE the early return so
	// tsconfig files surface in `interlinked verify` the same way they
	// surface at PostToolUse. The detector handles its own basename
	// filter (`tsconfig.json` / `tsconfig.*.json`) and node_modules skip
	// internally, so we can call it unconditionally for any .json file.
	r.tsconfigStrictness.push(
		...toIssues("tsconfig_strictness", relPath, checkTsconfigStrictness(content, file)),
	);
	return true;
}

/** Strong typing — shared findAnyTypes (non-test, non-generated TS/TSX only). */
function collectStrongTypingFindings(file: string, content: string, ext: string, relPath: string, r: CodeQualityResults): void {
	const base = basename(file, ext);
	const isTest = base.endsWith(".test") || base.endsWith(".spec") || file.includes("__tests__");
	if (isTest || (ext !== TS_EXT && ext !== TSX_EXT) || isGeneratedFile(content)) return;
	for (const m of findAnyTypes(content)) {
		if (m.kind !== ANY_KIND) continue;
		r.strongTyping.push({
			check: "strong_typing",
			file: relPath,
			line: m.line,
			message: m.text,
		});
	}
}

/** Phantom imports — relative/absolute specifiers that resolve to no file. */
function collectPhantomImportFindings(file: string, content: string, relPath: string, r: CodeQualityResults): void {
	for (const imp of parseImports(content, file)) {
		if (!imp.specifier.startsWith(".") && !imp.specifier.startsWith("/")) continue;
		if (imp.specifier.endsWith(JSON_EXT)) continue;
		if (resolveImportPath(file, imp.specifier)) continue;
		r.phantomImports.push({
			check: "phantom_imports",
			file: relPath,
			line: 0,
			message: `imports "${imp.specifier}" which does not resolve to any file`,
		});
	}
}

function collectPerFileFindings(args: RunFileChecksArgs): void {
	const { file, content, cwd, r, moduleExportsCache, allEnvRefs, piiOpts } = args;

	const ext = extname(file).toLowerCase();
	const relPath = relative(cwd, file);
	const isDts = file.endsWith(DTS_SUFFIX);

	collectLargeFileFinding(file, content, cwd, relPath, r);
	collectFunctionTokenFindings(file, content, cwd, relPath, r);
	collectUntestedFileFinding(file, cwd, relPath, r, content);

	if (collectJsonFindings(file, content, ext, relPath, r)) return;

	if (isDts) return;

	collectStrongTypingFindings(file, content, ext, relPath, r);

	r.consoleStatements.push(
		...toIssues("console_statements", relPath, checkConsoleDebug(content, file)),
	);
	r.silentCatches.push(...toIssues("silent_catches", relPath, checkSilentCatch(content, file)));

	if (JS_TS_EXTS.has(ext) && !isGeneratedFile(content)) {
		collectSuppressionFindings(content, relPath, r.suppressions);
	}

	if (JS_TS_EXTS.has(ext)) {
		collectPhantomImportFindings(file, content, relPath, r);
	}

	const testResult = checkTestRegressions(content, file);
	if (testResult.skipped.length > 0) {
		r.testRegressions.push(...toIssues("test_regressions", relPath, testResult.skipped));
	}

	for (const ref of extractEnvReferences(content, file)) {
		const entry = allEnvRefs.get(ref.name) || [];
		entry.push({ file: relPath, line: ref.line });
		allEnvRefs.set(ref.name, entry);
	}

	if (JS_TS_EXTS.has(ext)) {
		const mocks = extractMockDefinitions(content, file);
		collectMockDriftFindings({
			mocks,
			moduleExportsCache,
			file,
			relPath,
			cwd,
			out: r.mockDrift,
		});
	}

	r.missingReturnTypes.push(
		...toIssues("missing_return_types", relPath, checkMissingReturnTypes(content, file)),
	);
	r.noTestFile.push(...toIssues("no_test_file", relPath, checkTestFileExists(file, content)));
	r.complexity.push(...toIssues("complexity", relPath, checkFunctionComplexity(content, file)));

	// Remaining stateless detector groups — fanned out to sibling modules. The
	// shared context carries everything they need; each group mutates `r` in
	// place, preserving the original inline statement order per bucket.
	const ctx: FileCheckContext = { file, content, relPath, cwd, r, piiOpts };
	runCrapCheck(ctx);
	runAgentSafetyChecks(ctx);
	runTypeRedundancyChecks(ctx);
	runReactAndTasteChecks(ctx);
	runUbsChecks(ctx);
	runEndpointAndLazinessChecks(ctx);
}
