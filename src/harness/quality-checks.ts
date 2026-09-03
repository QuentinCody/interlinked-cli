// ===========================================
// Quality Checks — PostToolUse static analysis
// ===========================================
// Runs configurable checks after file Edit/Write operations.
// Results are returned as warnings (written to stderr by the hook script, visible to agent).
//
// This module is the orchestrator: it snapshots the edited file once, then
// sequences three phases — the config-driven tool-check loop, the inline-check
// block, and the ratchet comparison — each of which lives in a sibling module
// under ./quality-checks/. The warning formatter (formatQualityWarnings /
// classifyDeterminism) lives in ./quality-checks/warning-formatter.ts. Phase
// ordering, the between-phase event-loop yields, and the per-check
// instrumentation hooks are preserved exactly — this is the PostToolUse
// pipeline, so behavior must not drift.

import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import type { FilePriority } from "./file-priority.js";
import { runInlineCheckBlock } from "./quality-checks/inline-block.js";
import { runRatchetComparison } from "./quality-checks/ratchet-comparison.js";
import type { QualityCheckResult, ToolBreakdownEntry } from "./quality-checks/result-types.js";
import { collectSoftwareVersionReferences } from "./quality-checks/software-version-regression.js";
import { runToolCheckLoop, yieldEventLoop } from "./quality-checks/tool-check-loop.js";
import type { DiffAwareConfig, HarnessEvent, PreEditBaseline, QualityCheckConfig } from "./types.js";

export {
	checkLockfileClassificationDrift,
	checkLockfileDrift,
} from "./quality-checks/lockfile-drift.js";
export { checkPackageJsonConsistency } from "./quality-checks/package-json.js";
export { findProjectRoot } from "./quality-checks/project-root.js";
export type { ProjectWideSweepResult } from "./quality-checks/project-wide.js";
// Re-export helpers moved to sibling files so existing importers keep working.
export {
	ProjectWideSweepState,
	runProjectWideChecks,
	runProjectWideChecksAsync,
} from "./quality-checks/project-wide.js";
export {
	type AmbientSeamCounts,
	type AssertionStrengthCounts,
	countAmbientSeams,
	countAsAnyCasts,
	countAssertionStrength,
	countConsoleStatements,
	countNonNullAssertions,
	countPublicApiSurface,
	countSuppressionDirectives,
	countTodoMarkers,
	countTypeDensity,
	countUnjustifiedCasts,
	type TypeDensityCounts,
} from "./quality-checks/ratchet-metrics.js";
export type { ToolBreakdownEntry } from "./quality-checks/result-types.js";
export { containsSecrets } from "./quality-checks/secret-detection.js";
export {
	collectSoftwareVersionReferences,
	detectSoftwareVersionFreshnessConcerns,
	detectSoftwareVersionRegressions,
	formatSoftwareVersionFreshnessDetail,
	formatSoftwareVersionRegressionDetail,
	type SoftwareVersionFreshnessConcern,
	type SoftwareVersionReference,
	type SoftwareVersionRegression,
} from "./quality-checks/software-version-regression.js";
export { findAnyTypes, stripStringLiterals } from "./quality-checks/strong-typing.js";
export { classifyDeterminism, formatQualityWarnings } from "./quality-checks/warning-formatter.js";

// ===========================================
// Check Runner
// ===========================================
// QualityCheckResult / ToolBreakdownEntry now live in
// ./quality-checks/result-types.ts (imported above; ToolBreakdownEntry is
// re-exported for back-compat). The per-check loop, the inline-check block,
// the ratchet comparison, and the warning formatter live in sibling modules.

/** Options for filtering quality check output. */
export interface QualityCheckOptions {
	/** When set, filter tsc output to only errors mentioning this file path */
	tscFilterFile?: string;
	/** Pre-edit baseline for diff-aware filtering (suppresses pre-existing findings) */
	baseline?: PreEditBaseline | undefined;
	/** Diff-aware config from guard rules */
	diffAware?: DiffAwareConfig;
	/** Phase A.7: out-parameter — when present, runQualityChecks pushes one
	 *  entry per subprocess tool invocation so the daemon can write a
	 *  per-tool breakdown into latency.jsonl. The caller owns the array
	 *  (passes it pre-allocated, reads it after the await). */
	outToolMetrics?: ToolBreakdownEntry[];
	/** Out-parameter populated only for configured checks that completed with a
	 *  real verdict. A skipped/deferred/thrown check remains absent. */
	outChecksRan?: string[];
	/** Multi-file PostToolUse runs external command/named-heavy checks through
	 * one request-owned ChangeSet batch. Keep the cheap per-file loop active
	 * while suppressing duplicate subprocess launches here. */
	skipMultiFileExternalChecks?: boolean;
	/** Mythos Phase 4 — per-file priority map populated at
	 *  SessionStart in the daemon. When provided, advisory inline
	 *  detectors skip files whose tier is "cold" (>180 days since
	 *  last git-tracked modification). Untracked / fresh files
	 *  always run the full pipeline (fail-OPEN per
	 *  `shouldRunAdvisoryChecks`). Optional — direct test callers
	 *  that pass nothing run all checks (legacy behavior). */
	filePriority?: Map<string, FilePriority>;
	/** Diagnostic: called after each inline check iteration with the check's
	 *  name. Lets the daemon record per-check elapsed ms into `phase_breakdown`
	 *  so an inline residual spike can be pinned to a specific check name. */
	onCheckBoundary?: (name: string) => void;
	/** False when the edited file is outside the harness's own project
	 *  (`cwd`). Subprocess / tree-walking `command`-based checks (tsc, biome,
	 *  semgrep, gitleaks) are project-rooted: for an out-of-tree file
	 *  `findProjectRoot` returns null and the check engine falls back to
	 *  `cwd`, running the whole project's tooling for a foreign file — wrong
	 *  result and an expensive tree walk. When this is `false`, those checks
	 *  are skipped. Inline content checks (secrets, strong_typing,
	 *  software_version_regression, the inline-checks block) still run.
	 *  Defaults to `true` (legacy behavior for verify / direct test callers). */
	editedFileInRepo?: boolean;
}

interface QualityCheckTarget {
	filePath: string;
	absPath: string;
	testBaseName: string;
}

function resolveQualityCheckTarget(event: HarnessEvent, cwd: string): QualityCheckTarget | null {
	const input = event.tool_input;
	const explicitFile = input?.file_path;
	const fallbackPath = input?.path;
	const filePath =
		typeof explicitFile === "string" && explicitFile.length > 0
			? explicitFile
			: typeof fallbackPath === "string"
				? fallbackPath
				: "";
	if (!filePath) return null;
	const normalized = filePath.replace(/\\/g, "/");
	if (["/node_modules/", "/dist/", "/vendor/", "/.next/", "/build/"].some((part) => normalized.includes(part))) {
		return null;
	}
	const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const extension = extname(absPath);
	return {
		filePath,
		absPath,
		testBaseName: absPath.slice(absPath.lastIndexOf(sep) + 1, -extension.length || undefined),
	};
}

function sharedContentReader(absPath: string): () => string | null {
	let content: string | null = null;
	let attempted = false;
	return () => {
		if (attempted) return content;
		attempted = true;
		if (!existsSync(absPath)) return content;
		try {
			content = readFileSync(absPath, "utf-8");
		} catch {
			content = null;
		}
		return content;
	};
}

function afterReferenceReader(
	filePath: string,
): (content: string) => ReturnType<typeof collectSoftwareVersionReferences> {
	let cached: ReturnType<typeof collectSoftwareVersionReferences> | undefined;
	return (content) => {
		cached ??= collectSoftwareVersionReferences(content, filePath);
		return cached;
	};
}

/**
 * Run quality checks for a PostToolUse event on a file.
 * Returns an array of warnings/errors found.
 *
 * Async since Phase A.2 of the Free CLI Phase-2 roadmap. The async signature
 * is what lets the daemon's PostToolUse path call `engine.runChecksAsync(...)`
 * and benefit from the 14 async runner conversions that landed in Phase A.1.
 * The function still returns *the same shape* — no behavioral change for
 * callers other than the await. `interlinked verify` and `diff-aware-checks`
 * tests cascade through one extra await each.
 */
export async function runQualityChecks(
	event: HarnessEvent,
	checks: Record<string, QualityCheckConfig>,
	cwd: string = process.cwd(),
	options?: QualityCheckOptions,
): Promise<QualityCheckResult[]> {
	const target = resolveQualityCheckTarget(event, cwd);
	if (target === null) return [];
	const { filePath, absPath: absForTestCheck, testBaseName: testCheckBaseName } = target;

	const results: QualityCheckResult[] = [];

	// Snapshot file content once for the whole call: every inline check that
	// inspects on-disk content (strong_typing, software_version_regression,
	// freshness_sensitive_reference, package_json_consistency, the inline-checks
	// section below, and the ratchet block) reads the same file. Hoisting the
	// read eliminates 5+ identical readFileSync calls per PostToolUse Edit.
	const sharedAbsPath = absForTestCheck;
	const getSharedContent = sharedContentReader(sharedAbsPath);

	// Memoize collectSoftwareVersionReferences for the post-edit content:
	// software_version_regression and freshness_sensitive_reference both call
	// it on the same content, so without memoization we run the full regex
	// sweep twice per Edit.
	const getAfterRefs = afterReferenceReader(filePath);

	// ===========================================
	// Phase 1 — config-driven per-check loop (subprocess tools + inline content
	// checks declared in the QualityCheckConfig map). Runs first so tsc / lint /
	// scanner findings precede the generic inline signal below.
	// ===========================================
	const toolCheckResults = await runToolCheckLoop({
		event,
		checks,
		cwd,
		filePath,
		absForTestCheck,
		testCheckBaseName,
		getSharedContent,
		getAfterRefs,
		tscFilterFile: options?.tscFilterFile,
		baseline: options?.baseline,
		outToolMetrics: options?.outToolMetrics,
		outChecksRan: options?.outChecksRan,
		skipMultiFileExternalChecks: options?.skipMultiFileExternalChecks,
		editedFileInRepo: options?.editedFileInRepo,
		onCheckBoundary: options?.onCheckBoundary,
	});
	results.push(...toolCheckResults);

	// Yield between the subprocess-check loop and the inline-check block —
	// each is a distinct synchronous CPU phase, so giving the event loop
	// a turn here lets other connections progress between them.
	await yieldEventLoop();

	// ===========================================
	// Phase 2 — inline checks (generic + agent-safety + library-footgun).
	// These run AFTER subprocess checks (tsc, lint, etc.) for additional signal.
	// Operate on the shared content snapshot — no extra disk read.
	// ===========================================
	const absFilePath = sharedAbsPath;
	const sharedForInline = getSharedContent();
	if (sharedForInline !== null) {
		results.push(
			...runInlineCheckBlock({
				event,
				filePath,
				absFilePath,
				fileContent: sharedForInline,
				cwd,
				diffAware: options?.diffAware,
				baseline: options?.baseline,
				filePriority: options?.filePriority,
			}),
		);
	}

	// Yield once more before the ratchet phase — it runs several full-file
	// count passes (countSuppressionDirectives, countAsAnyCasts, etc.) that
	// are each O(file size) regex sweeps.
	await yieldEventLoop();

	// ===========================================
	// Phase 3 — ratchet comparison. Active when diff-aware is OFF (default):
	// countable quality metrics must not regress in a touched file. The guard
	// lives inside runRatchetComparison, so this call is unconditional.
	// ===========================================
	results.push(
		...runRatchetComparison({
			absPath: sharedAbsPath,
			postContent: getSharedContent() ?? "",
			baseline: options?.baseline,
			cwd,
			diffAwareEnabled: options?.diffAware?.enabled,
		}),
	);

	return results;
}
