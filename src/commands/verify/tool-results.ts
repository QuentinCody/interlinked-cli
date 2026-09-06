// ===========================================
// Per-tool code quality check collection
// ===========================================
// Runs the battery of inline checks (from `../../harness/generic-checks.ts`
// and siblings) across every discovered file and returns a big bucket per
// check. The shape (`CodeQualityResults`) is consumed by:
//   - `output-json.ts` (JSON formatter)
//   - `streaming-output.ts` (human-readable streaming)
//   - `verify.ts` (passes through to both)
//
// The per-file check battery (~80 inline checks) lives in `./file-checks.ts`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { parseEnvDocumentation } from "../../harness/generic-checks.js";
import { parseExports } from "../../harness/project-graph.js";
import { type FileSuppressions, loadFileSuppressions } from "../../harness/suppressions.js";

// `validateSuppressionFile` lived in an upstream branch that enforces
// rationale/expiry on persisted suppressions. It's not in this repo, so the
// hygiene-findings pipe is disabled until that helper lands.
const validateSuppressionFile = (
	_interlinkedDir: string,
): Array<{ name: string; file: string; message: string }> => [];

import { runVerifyParityChecks } from "../../harness/verify-parity.js";
import { readSharedConfig } from "../../lib/config.js";
import { nonNull } from "../../lib/non-null.js";
import { JS_TS_EXTS } from "./advisory.js";
import { runPerFileChecks } from "./file-checks.js";
import type { PiiOpts } from "./file-checks-shared.js";
import {
	type ScanProgress,
	YIELD_EVERY_FILES,
	yieldToEventLoop,
} from "./scan-progress.js";
import {
	type CodeQualityIssue,
	type CodeQualityResults,
	CQ_RESULT_KEYS,
	emptyResults,
} from "./tool-results-types.js";

/**
 * Public API — consumed by `verify.ts`.
 *
 * Drop every issue whose `check` name appears in `skipChecks`. Returns a fresh
 * `CodeQualityResults` object; does not mutate the input.
 */
export function filterCodeQualityResults(
	results: CodeQualityResults,
	skipChecks: Set<string>,
): CodeQualityResults {
	const filtered = {} as CodeQualityResults;
	for (const key of CQ_RESULT_KEYS) {
		filtered[key] = results[key].filter((issue) => !skipChecks.has(issue.check));
	}
	return filtered;
}

/**
 * Memory-bounded variant for the verify orchestrator, which owns its freshly
 * collected result. Compacts each bucket in place so filtering never holds a
 * second project-wide copy of every finding at the scan/output boundary.
 */
export function filterCodeQualityResultsInPlace(
	results: CodeQualityResults,
	skipChecks: Set<string>,
): CodeQualityResults {
	for (const key of CQ_RESULT_KEYS) {
		const rows = results[key];
		let retained = 0;
		for (const issue of rows) {
			if (skipChecks.has(issue.check)) continue;
			rows[retained] = issue;
			retained += 1;
		}
		rows.length = retained;
	}
	return results;
}

/** Drop finding references once human-readable output has consumed them. */
export function clearCodeQualityResults(results: CodeQualityResults): void {
	for (const key of CQ_RESULT_KEYS) results[key].length = 0;
}

function buildUndocumentedEnvIssues(
	allEnvRefs: Map<string, Array<{ file: string; line: number }>>,
	documentedEnvVars: Set<string>,
): CodeQualityIssue[] {
	const issues: CodeQualityIssue[] = [];

	for (const [envVar, refs] of [...allEnvRefs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		if (documentedEnvVars.has(envVar)) continue;
		const firstRef = refs
			.slice()
			.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)[0];
		const fileCount = new Set(refs.map((ref) => ref.file)).size;
		issues.push({
			check: "undocumented_env_vars",
			file: nonNull(firstRef).file,
			line: nonNull(firstRef).line,
			message: `env var "${envVar}" is undocumented (${refs.length} references across ${fileCount} files)`,
		});
	}

	return issues;
}

/**
 * Pass 1, one file: record the module's exported names (used by mock-drift).
 * A file that cannot be read contributes nothing, exactly as before.
 */
function collectOneModuleExport(file: string, moduleExportsCache: Map<string, string[]>): void {
	let content: string;
	try {
		content = readFileSync(file, "utf-8");
	} catch {
		return;
	}
	const ext = extname(file).toLowerCase();
	if (!JS_TS_EXTS.has(ext) || file.endsWith(".d.ts")) return;
	const exports = parseExports(content);
	moduleExportsCache.set(
		file,
		exports.map((e) => e.name),
	);
}

/**
 * Mutable state threaded through both scan passes. Extracted so the
 * synchronous and the progress-reporting entry points share one
 * implementation of every pass and cannot drift apart.
 */
interface CqRunContext {
	r: CodeQualityResults;
	piiOpts: PiiOpts;
	documentedEnvVars: Set<string>;
	allEnvRefs: Map<string, Array<{ file: string; line: number }>>;
	moduleExportsCache: Map<string, string[]>;
}

function prepareRun(cwd: string): CqRunContext {
	// Load PII config from shared config (if available). Build with conditional
	// spreads so absent keys stay absent rather than being set to `undefined`
	// — `PiiOpts` (derived from checkPiiInSource) is exact-optional.
	const sharedConfig = readSharedConfig(cwd);
	const piiOpts = {
		...(sharedConfig?.pii_opt_in ? { optIn: sharedConfig.pii_opt_in } : {}),
		...(sharedConfig?.pii_patterns ? { customPatterns: sharedConfig.pii_patterns } : {}),
	};
	return {
		r: emptyResults(),
		piiOpts,
		documentedEnvVars: parseEnvDocumentation(cwd, { existsSync, readFileSync, readdirSync }, join),
		allEnvRefs: new Map(),
		moduleExportsCache: new Map(),
	};
}

/** Pass 2, one file: the ~200-detector battery. Unreadable files are skipped. */
function runOneFileChecks(file: string, cwd: string, ctx: CqRunContext): void {
	let content: string;
	try {
		content = readFileSync(file, "utf-8");
	} catch {
		return;
	}
	runPerFileChecks({
		file,
		content,
		cwd,
		r: ctx.r,
		moduleExportsCache: ctx.moduleExportsCache,
		allEnvRefs: ctx.allEnvRefs,
		piiOpts: ctx.piiOpts,
	});
}

/** Pass 3 + post-loop aggregation + suppression filtering. */
function finalizeRun(ctx: CqRunContext, files: string[], cwd: string): CodeQualityResults {
	// Pass 2 is the last consumer of the project-wide export census. Release it
	// before parity/suppression aggregation allocates its own cross-file rows.
	ctx.moduleExportsCache.clear();
	applyParityFindings(ctx.r, files, cwd);
	// Emit one issue per undocumented env var instead of one per reference.
	ctx.r.undocumentedEnvVars.push(
		...buildUndocumentedEnvIssues(ctx.allEnvRefs, ctx.documentedEnvVars),
	);
	ctx.allEnvRefs.clear();
	ctx.documentedEnvVars.clear();
	applyPersistedSuppressions(ctx.r, join(cwd, ".interlinked"));
	return ctx.r;
}

/**
 * Drive one pass over every file, reporting progress and yielding to the
 * event loop every `YIELD_EVERY_FILES` files so the process stays
 * interruptible (Ctrl-C) instead of being one opaque synchronous span.
 */
async function forEachFileWithProgress(
	files: string[],
	progress: ScanProgress,
	phase: string,
	visit: (file: string) => void,
): Promise<void> {
	progress.start(phase);
	let seen = 0;
	for (const file of files) {
		const startedAt = Date.now();
		visit(file);
		progress.advance(file, Date.now() - startedAt);
		seen += 1;
		if (seen % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
	}
}

function applyParityFindings(r: CodeQualityResults, files: string[], cwd: string): void {
	const parity = runVerifyParityChecks(files);
	for (const sr of parity.crossFileSwitchDiscriminant) {
		r.crossFileSwitchDiscriminant.push({
			check: "cross_file_switch_discriminant",
			file: relative(cwd, sr.file),
			line: 0,
			message: sr.message,
		});
	}
	for (const sr of parity.singleImplementationInterface) {
		r.singleImplementationInterface.push({
			check: "single_implementation_interface",
			file: relative(cwd, sr.file),
			line: 0,
			message: sr.message,
		});
	}
	for (const fw of parity.filesWithoutTest) {
		r.filesWithoutTest.push({
			check: "files_without_test",
			file: relative(cwd, fw.file),
			line: 0,
			message: `No test file on disk (expected ${relative(cwd, fw.expectedTest)}).`,
		});
	}
	if (parity.projectLocRatio?.exceeded) {
		r.projectLocRatio.push({
			check: "project_loc_ratio",
			file: "<project>",
			line: 0,
			message: `Project prod/test LOC ratio is ${
				Number.isFinite(parity.projectLocRatio.ratio)
					? parity.projectLocRatio.ratio.toFixed(1)
					: "∞"
			}:1 (limit ${parity.projectLocRatio.limit}:1). Prod ${parity.projectLocRatio.prodLoc} LOC, test ${parity.projectLocRatio.testLoc} LOC.`,
		});
	}
}

/**
 * Exported so the currently-unreachable hygiene-findings branch (below) can be
 * exercised directly: `validateSuppressionFile` is a hardcoded stub that
 * always returns `[]` until the upstream rationale/expiry helper lands, so
 * there is no way to make `hygieneFindings` non-empty through the public
 * `runCodeQualityChecks` entry point. `validate` defaults to that same stub —
 * production behavior is unchanged — and exists only so a test can supply a
 * fake generator to reach the loop body beneath it.
 */
export function applyPersistedSuppressions(
	r: CodeQualityResults,
	interlinkedDir: string,
	validate: (
		dir: string,
	) => Array<{ name: string; file: string; message: string }> = validateSuppressionFile,
): void {
	const suppressionCache = new Map<string, FileSuppressions>();
	function getFileSuppressions(relPath: string): FileSuppressions {
		let cached = suppressionCache.get(relPath);
		if (!cached) {
			cached = loadFileSuppressions(interlinkedDir, relPath);
			suppressionCache.set(relPath, cached);
		}
		return cached;
	}

	for (const key of CQ_RESULT_KEYS) {
		r[key] = r[key].filter((issue) => {
			const fileSup = getFileSuppressions(issue.file);
			return !fileSup.has(issue.check);
		});
	}

	const hygieneFindings = validate(interlinkedDir);
	for (const f of hygieneFindings) {
		r.suppressionHygiene.push({
			check: f.name,
			file: f.file,
			line: 0,
			message: f.message,
		});
	}
}

/**
 * Public API — consumed by `verify.ts` (batch JSON + streaming modes).
 *
 * Run all code quality checks using shared functions from generic-checks.ts
 * and quality-checks.ts. These are the SAME functions the harness evaluator
 * uses, ensuring verify and PostToolUse always agree.
 */
export function runCodeQualityChecks(files: string[], cwd: string): CodeQualityResults {
	const ctx = prepareRun(cwd);

	// Pass 1: collect all project exports (used by mock-drift check)
	for (const file of files) collectOneModuleExport(file, ctx.moduleExportsCache);

	// Pass 2: per-file checks (delegated to file-checks.ts)
	for (const file of files) runOneFileChecks(file, cwd, ctx);

	// Pass 3 + aggregation + suppressions
	return finalizeRun(ctx, files, cwd);
}

/**
 * Public API — consumed by `verify.ts` (both the streaming and the JSON path).
 *
 * Same passes, same order, same result as `runCodeQualityChecks`, but the two
 * per-file passes report progress to `progress` and yield to the event loop as
 * they go. This is the entry point every interactive run should use: the
 * synchronous variant produces no output for minutes on a large tree and
 * cannot be interrupted.
 */
export async function runCodeQualityChecksProgressive(
	files: string[],
	cwd: string,
	progress: ScanProgress,
): Promise<CodeQualityResults> {
	const ctx = prepareRun(cwd);

	await forEachFileWithProgress(files, progress, "exports", (file) => {
		collectOneModuleExport(file, ctx.moduleExportsCache);
	});
	await forEachFileWithProgress(files, progress, "checks", (file) => {
		runOneFileChecks(file, cwd, ctx);
	});
	progress.finish();

	return finalizeRun(ctx, files, cwd);
}

/** Public API — consumed by `verify.ts` and tests. Re-exports helper. */
export { checkProjectSetup } from "../../harness/generic-checks.js";

/** Public API — consumed by `verify.ts` and tests. Re-export from ./suggestions.js. */
export { runSuggestions } from "./suggestions.js";
