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
import { getProjectCheckEvidence, withProjectCheckEvidence } from "../../harness/checks/project-check-evidence.js";
import { checkRepeatedImplementationAsync, type RepeatedImplementationMatch } from "../../harness/checks/repeated-implementation.js";
import { currentProcessSignal } from "../../harness/check-engine/process-cancellation.js";
import { type FileSuppressions, loadFileSuppressions } from "../../harness/suppressions.js";

// Suppression-file hygiene: entries that name a missing file match nothing
// (`suppression-hygiene.ts`; antithesis intake backlog #16). Rationale/expiry
// validation from the upstream branch is still not in this repo.
const validateSuppressionFile = staleFileSuppressions;

import { runVerifyParityChecks } from "../../harness/verify-parity.js";
import { readSharedConfig } from "../../lib/config.js";
import { nonNull } from "../../lib/non-null.js";
import { JS_TS_EXTS } from "./advisory.js";
import { classifySetAside } from "./set-aside.js";
import { sweepFileChecks } from "./registry-sweep.js";
import { sweepProjectChecks } from "./project-sweep.js";
import type { SetAsideRow } from "./scan-ledger.js";
import { recordVerifyInputExclusion, measureVerifyCheck, measureVerifyCheckAsync, isVerifyCheckSelected, recordVerifyInputDeferral, recordSetAside, currentScanLedger, verifyDeadlinePassed, markVerifyPartial } from "./check-timing.js";
import { runPerFileChecks } from "./file-checks.js";
import { staleFileSuppressions } from "./suppression-hygiene.js";
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
	const filtered = emptyResults();
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
 * Read/parse failures retain an explicit coverage gap and allow siblings through.
 */
function collectOneModuleExport(file: string, cwd: string, ctx: CqRunContext): void {
	const ext = extname(file).toLowerCase();
	if (!JS_TS_EXTS.has(ext)) return;
	const content = readInput(file, cwd, ctx);
	if (content === null) return;
	if (setAsideFor(file, cwd, ctx, content)) return;
	if (file.endsWith(".d.ts")) return;
	try {
		ctx.moduleExportsCache.set(file, parseExports(content).map(exported => exported.name));
	} catch (error) {
		recordVerifyInputDeferral("module_exports_unavailable", { file: relative(cwd, file), reason: inputFailureReason(error) });
	}
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
	unreadableFiles: Set<string>;
	/** Per-file role decision, computed once: a row when the file is set aside, null when its content checks run. */
	setAside: Map<string, SetAsideRow | null>;
}

/** Decide once per file whether source roles set it aside; set-aside files stay consumption context for project checks. */
function setAsideFor(file: string, cwd: string, ctx: CqRunContext, content: string): SetAsideRow | null {
	const cached = ctx.setAside.get(file);
	if (cached !== undefined) return cached;
	const row = classifySetAside(cwd, file, content);
	ctx.setAside.set(file, row);
	if (row) getProjectCheckEvidence(cwd)?.excludeFile(file, row.evidence_kind === "marker" ? row.evidence_detail : row.role);
	return row;
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
		unreadableFiles: new Set(),
		setAside: new Map(),
	};
}

function inputFailureReason(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : "Unknown check error";
}

/** Both passes share the invocation snapshot, including a failed read. */
function readInput(file: string, cwd: string, ctx: CqRunContext): string | null {
	if (ctx.unreadableFiles.has(file)) return null;
	try {
		const evidence = getProjectCheckEvidence(cwd);
		return evidence ? evidence.readFile(file) : readFileSync(file, "utf-8");
	} catch (error) {
		ctx.unreadableFiles.add(file);
		recordVerifyInputDeferral("file_read_unavailable", { file: relative(cwd, file), reason: inputFailureReason(error) });
		return null;
	}
}

/** Pass 2, one file: complete bodies with explicit exclusions and failures. */
function runOneFileChecks(file: string, cwd: string, ctx: CqRunContext, repeatedImplementation?: RepeatedImplementationMatch[]): void {
	const content = readInput(file, cwd, ctx);
	if (content === null) return;
	const aside = setAsideFor(file, cwd, ctx, content);
	if (aside) {
		recordSetAside(aside);
		if (aside.evidence_kind === "marker") recordVerifyInputExclusion(`input_excluded:${aside.evidence_detail}`, { file: aside.file, reason: aside.evidence_detail });
		return;
	}
	const ledger = currentScanLedger();
	if (ledger) ledger.measuredFiles++;
    try {
        runPerFileChecks({ file, content, cwd, r: ctx.r, moduleExportsCache: ctx.moduleExportsCache,
            allEnvRefs: ctx.allEnvRefs, piiOpts: ctx.piiOpts,
			...(repeatedImplementation === undefined ? {} : { repeatedImplementation }) });
        sweepFileChecks({ file, relPath: relative(cwd, file), content });
    } catch (error) {
        // Malformed/adversarial input must not abort every other file's checks.
        // Findings already collected remain observations, but this file is incomplete.
        recordVerifyInputDeferral("file_checks_unavailable", {
            file: relative(cwd, file), reason: inputFailureReason(error),
        });
    }
}

/** Public verify awaits the managed Python parser before synchronous detectors. */
async function runOneFileChecksProgressive(file: string, cwd: string, ctx: CqRunContext): Promise<void> {
	currentProcessSignal()?.throwIfAborted();
	const content = readInput(file, cwd, ctx);
	if (content === null) return;
	let repeated: RepeatedImplementationMatch[] = [];
	if (!setAsideFor(file, cwd, ctx, content) && isVerifyCheckSelected("repeated_implementation")) {
		repeated = await measureVerifyCheckAsync("repeated_implementation", () => checkRepeatedImplementationAsync(content, file, {
			onUnavailable: reason => recordVerifyInputDeferral("repeated_implementation", { file: relative(cwd, file), reason }),
		}));
	}
	currentProcessSignal()?.throwIfAborted();
	runOneFileChecks(file, cwd, ctx, repeated);
}

/** Pass 3 + post-loop aggregation + suppression filtering. */
function finalizeRun(ctx: CqRunContext, files: string[], cwd: string, partial = false): CodeQualityResults {
	// Pass 2 is the last consumer of the project-wide export census. Release it
	// before parity/suppression aggregation allocates its own cross-file rows.
	ctx.moduleExportsCache.clear();
	// A stopped run has not seen every file: project-wide aggregates would be wrong, so they are not computed.
	if (!partial) {
		applyParityFindings(ctx.r, files.filter((file) => !ctx.setAside.get(file)), cwd);
		const asideRel = new Set([...ctx.setAside.values()].flatMap((row) => (row ? [row.file] : [])));
		sweepProjectChecks(cwd, (rel) => asideRel.has(rel));
		// Emit one issue per undocumented env var instead of one per reference.
		ctx.r.undocumentedEnvVars.push(
			...buildUndocumentedEnvIssues(ctx.allEnvRefs, ctx.documentedEnvVars),
		);
	}
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
	visit: (file: string) => void | Promise<void>,
): Promise<void> {
	progress.start(phase);
	let seen = 0;
	for (const file of files) {
		if (verifyDeadlinePassed()) {
			markVerifyPartial(`inline checks (${phase})`, `soft deadline reached after ${seen} of ${files.length} files`);
			return;
		}
		const startedAt = Date.now();
		await visit(file);
		progress.advance(file, Date.now() - startedAt);
		seen += 1;
		if (seen % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
	}
}

function applyParityFindings(r: CodeQualityResults, files: string[], cwd: string): void {
	const parity = measureVerifyCheck("project_parity", () => runVerifyParityChecks(files));
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
 * Drops findings covered by `verify-suppressions.json`, then appends the
 * suppression-file hygiene findings. `validate` defaults to
 * `staleFileSuppressions` (entries for missing files); a test can supply a
 * fake generator.
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
 * Synchronous compatibility API, also consumed by focused callers and tests.
 *
 * Run all code quality checks using shared functions from generic-checks.ts
 * and quality-checks.ts. These are the SAME functions the harness evaluator
 * uses, ensuring verify and PostToolUse always agree.
 */
export function runCodeQualityChecks(files: string[], cwd: string): CodeQualityResults {
	return withProjectCheckEvidence(cwd, files, () => {
		const ctx = prepareRun(cwd);

	// Pass 1: collect all project exports (used by mock-drift check)
		for (const file of files) collectOneModuleExport(file, cwd, ctx);

	// Pass 2: per-file checks (delegated to file-checks.ts)
		for (const file of files) runOneFileChecks(file, cwd, ctx);

	// Pass 3 + aggregation + suppressions
		return finalizeRun(ctx, files, cwd);
	}, gap => recordVerifyInputDeferral(gap.check, { file: gap.file, reason: gap.reason }));
}

/**
 * Public API — consumed by `verify.ts` (both the streaming and the JSON path).
 *
 * The shared passes preserve detector predicates and suppression handling.
 * Repeated implementation uses its complete, managed foreground parser instead
 * of the synchronous hook budgets. Both per-file passes report progress and
 * yield to the event loop. Human and JSON verify use this entry point.
 */
export async function runCodeQualityChecksProgressive(
	files: string[],
	cwd: string,
	progress: ScanProgress,
): Promise<CodeQualityResults> {
	return withProjectCheckEvidence(cwd, files, async () => {
		const ctx = prepareRun(cwd);

		await forEachFileWithProgress(files, progress, "exports", (file) => {
			collectOneModuleExport(file, cwd, ctx);
		});
		await forEachFileWithProgress(files, progress, "checks", file => runOneFileChecksProgressive(file, cwd, ctx));
		progress.finish();

		return finalizeRun(ctx, files, cwd, currentScanLedger()?.partial != null);
	}, gap => recordVerifyInputDeferral(gap.check, { file: gap.file, reason: gap.reason }));
}

/** Public API — consumed by `verify.ts` and tests. Re-exports helper. */
import { checkProjectSetup as inspectProjectSetup } from "../../harness/checks/project-setup.js";

/** Foreground setup probes retain every eligible source and disclose read gaps. */
export function checkProjectSetup(cwd: string) {
	return inspectProjectSetup(cwd, {
		foreground: true,
		onUnavailable: input => recordVerifyInputDeferral("project_setup", input),
	});
}

/** Public API — consumed by `verify.ts` and tests. Re-export from ./suggestions.js. */
export { runSuggestions } from "./suggestions.js";
