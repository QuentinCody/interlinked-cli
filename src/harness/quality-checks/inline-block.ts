// ===========================================
// Inline Checks — generic + language-specific (no subprocess, <10ms total)
// ===========================================
// Runs AFTER the subprocess checks (tsc, lint, etc.) for additional signal.
// Operates on the file content already snapshotted by the orchestrator, so
// there is no extra disk read here. Extracted from runQualityChecks to keep
// the orchestrator a thin sequencer; ordering of the pushed findings is
// identical to the original inline section.

import { nonNull } from "../../lib/non-null.js";
import { buildAgentSafetyChecks } from "../check-registry/index.js";
import { computeCrapRisers } from "../checks/crap-baseline.js";
import { filterToRisers as filterDryToRisers } from "../checks/dry-baseline.js";
import { checkCodeCloneFindings, formatCodeCloneFinding } from "../checks/dry-check.js";
import { locateBinaryContent } from "../checks/language-agnostic.js";
import { type FilePriority, shouldRunAdvisoryChecks } from "../file-priority.js";
import { listWithOverflow, MAX_LISTED_FINDINGS } from "../finding-overflow.js";
import {
	checkEmptyFile,
	checkFunctionComplexity,
	checkMissingReturnTypes,
	checkTestFileExists,
} from "../generic-checks.js";
import { loadDisabledLibraries, runFootgunChecks } from "../library-footguns/registry.js";
import type { DiffAwareConfig, HarnessEvent, PreEditBaseline } from "../types.js";
import type { QualityCheckResult } from "./result-types.js";

/** Read-only context the inline-check block needs from the orchestrator. */
export interface InlineBlockContext {
	event: HarnessEvent;
	/** Display path used in finding messages. */
	filePath: string;
	/** Absolute path (passed to per-file check helpers). */
	absFilePath: string;
	/** Post-edit file content (non-null — caller guards on readability). */
	fileContent: string;
	cwd: string;
	diffAware: DiffAwareConfig | undefined;
	baseline: PreEditBaseline | undefined;
	filePriority: Map<string, FilePriority> | undefined;
}

/**
 * Run the generic + agent-safety + library-footgun inline checks against the
 * snapshotted file content. Returns findings in push order; the caller appends
 * them after the subprocess-check results.
 */
export function runInlineCheckBlock(ctx: InlineBlockContext): QualityCheckResult[] {
	const results: QualityCheckResult[] = [];
	const { filePath, fileContent } = ctx;

	try {
		// 1. Binary content — error, skip all other inline checks. The position
		// makes the invisible byte actionable; without it agents ignored the
		// error 24 edits in a row while it silently blacked out every other
		// inline check on the file (observed 2026-07, large-file-policy.ts).
		const binaryLocation = locateBinaryContent(fileContent);
		if (binaryLocation !== null) {
			results.push({
				name: "binary_content",
				severity: "error",
				message:
					`Binary content detected in ${filePath} — ${binaryLocation.count} raw NUL byte(s), ` +
					`first at line ${binaryLocation.line}:${binaryLocation.column}. Text editing tools ` +
					`should not write binary files; a deliberate NUL sentinel/separator belongs in ` +
					`source as the U+0000 string escape, not a raw byte. Until fixed, this error ` +
					`suppresses every other inline check on the file.`,
				file: filePath,
			});
		} else {
			// 2. Empty file — warning
			if (checkEmptyFile(fileContent)) {
				results.push({
					name: "empty_file",
					severity: "warning",
					message: `File is empty: ${filePath} — was content intended?`,
					file: filePath,
				});
			}

			// 4. Missing return type annotations (TS/TSX only), diff-aware.
			results.push(...checkMissingReturnTypesBlock(ctx));

			// 5. Test file existence (fires on edits, not new-file Writes).
			results.push(...checkTestFileBlock(ctx));

			// 6. Function complexity, diff-aware.
			results.push(...checkComplexityBlock(ctx));

			// 6b. CRAP risers — coverage-hole alarm (present-not-prescribe).
			// Diff-aware via the pre-edit CRAP snapshot. Complexity rises are
			// blocked at PreToolUse (#15), so a function whose CRAP ROSE here is
			// almost always a coverage DROP on complex code.
			results.push(...checkCrapRisersBlock(ctx));

			// 7. Export ripple — now handled by impact-analysis.ts PostToolUse hook.

			// 8. Agent safety checks (async, imports, types, security, correctness)
			// Derived from the declarative CHECK_REGISTRY — see check-registry/.
			// Only run phase="post" here; pre_block/pre_warn entries fire in
			// evaluator.ts at PreToolUse and are authoritative for their phase.
			results.push(...checkAgentSafetyBlock(ctx));

			// 8b. Library-footgun registry (Mythos Phase 5). Deterministic
			// per-library checks that detect known API anti-patterns
			// (e.g. fetch() without timeout). Findings group by check id
			// — the fix instruction comes from the registry entry so
			// the agent sees both WHAT fired and HOW to fix it. Per-
			// library opt-out via `.interlinked/disabled-libraries.json`.
			results.push(...checkFootgunBlock(ctx));

			// Non-deterministic regex heuristics (generic_inline, silent_catch, sync_io_in_async,
			// perf_*, language-specific) have been moved to the scored suggestion pipeline
			// in server.ts. They're now scored, ranked, and only the top 1-3 above a
			// threshold are shown. See suggestion-scorer.ts.
		}
	} catch {
		/* intentional: file unreadable — skip inline checks silently */
	}

	return results;
}

// ---------------------------------------------------------------------------
// Internal per-check helpers. Each owns one numbered inline check, takes the
// read-only context, and returns the finding(s) it produces (in push order).
// Extracted from runInlineCheckBlock to keep that function a thin sequencer;
// behavior and ordering are identical to the original inline section.
// ---------------------------------------------------------------------------

/** Section 4: missing return type annotations (TS/TSX), diff-aware. */
function checkMissingReturnTypesBlock(
	ctx: InlineBlockContext,
): QualityCheckResult[] {
	const { filePath, absFilePath, fileContent } = ctx;
	let missingReturnTypes = checkMissingReturnTypes(fileContent, absFilePath);
	if (
		ctx.diffAware?.enabled !== false &&
		ctx.diffAware?.missing_return_types !== "off" &&
		ctx.baseline?.missingReturnTypes
	) {
		const baseline = ctx.baseline.missingReturnTypes;
		missingReturnTypes = missingReturnTypes.filter((m) => !baseline.has(m.text));
	}
	if (missingReturnTypes.length === 0) return [];
	return [
		{
			name: "missing_return_types",
			severity: "warning",
			message: `${missingReturnTypes.length} exported function(s) without return type annotations in ${filePath}`,
			file: filePath,
			detail: listWithOverflow(missingReturnTypes, (m) => `  L${m.line}: ${m.text}`),
		},
	];
}

/** Section 5: test-file existence (fires on edits, not new-file Writes). */
function checkTestFileBlock(ctx: InlineBlockContext): QualityCheckResult[] {
	const { event, filePath, absFilePath, fileContent } = ctx;
	const isNewFile =
		ctx.diffAware?.enabled !== false &&
		ctx.diffAware?.no_test_file !== "off" &&
		event.tool_name != null &&
		!["Write", "WriteFile", "write_file"].includes(event.tool_name);
	if (isNewFile) return [];
	// Pass file content so the check can short-circuit on generator-emitted
	// files (OpenAPI, protoc, @generated) that never have test siblings.
	const noTestFile = checkTestFileExists(absFilePath, fileContent);
	if (noTestFile.length === 0) return [];
	return [
		{
			name: "no_test_file",
			severity: "warning",
			message: `No test file found for ${filePath}`,
			file: filePath,
			detail: nonNull(noTestFile[0]).text,
		},
	];
}

/** Section 6: function complexity, diff-aware (edit-region or baseline). */
function checkComplexityBlock(ctx: InlineBlockContext): QualityCheckResult[] {
	const { event, filePath, absFilePath, fileContent } = ctx;
	let complexFns = checkFunctionComplexity(fileContent, absFilePath);
	if (ctx.diffAware?.enabled !== false && ctx.diffAware?.complexity !== "off") {
		complexFns = filterComplexFnsToEdit(complexFns, event, fileContent, ctx);
	}
	if (complexFns.length === 0) return [];
	return [
		{
			name: "complexity",
			severity: "warning",
			message: `${complexFns.length} complex function(s) in ${filePath}`,
			file: filePath,
			detail: listWithOverflow(complexFns, (m) => `  L${m.line}: ${m.text}`),
		},
	];
}

/**
 * Diff-aware narrowing for section 6: keep only complex functions introduced
 * by this edit. Strategy 1 (Edit tool with old_string/new_string) intersects
 * the edit region; Strategy 2 subtracts the pre-edit baseline.
 */
function filterComplexFnsToEdit(
	complexFns: ReturnType<typeof checkFunctionComplexity>,
	event: HarnessEvent,
	fileContent: string,
	ctx: InlineBlockContext,
): ReturnType<typeof checkFunctionComplexity> {
	let filtered = false;
	let result = complexFns;
	// Strategy 1: Edit-region intersection (Edit tool with old_string/new_string)
	if (event.tool_input?.old_string) {
		const newStr = (event.tool_input.new_string as string) || "";
		const oldStr = event.tool_input.old_string as string;
		// Post-edit file has new_string, not old_string — use new_string for lookup
		const lookupStr = newStr || oldStr;
		const idx = fileContent.indexOf(lookupStr);
		if (idx >= 0) {
			const editStartLine = fileContent.slice(0, idx).split("\n").length;
			const oldLines = oldStr.split("\n").length;
			const newLines = newStr.split("\n").length;
			const editEndLine = editStartLine + Math.max(oldLines, newLines);
			result = result.filter(
				(m) => m.line >= editStartLine - 5 && m.line <= editEndLine + 50,
			);
			filtered = true;
		}
	}

	// Strategy 2: Baseline subtraction (fallback, or Bash edits without old_string)
	const complexBaseline = ctx.baseline?.complexFunctions;
	if (!filtered && complexBaseline) {
		result = result.filter((m) => !complexBaseline.has(m.text));
	}
	return result;
}

/** Section 6b: CRAP risers — coverage-hole alarm, diff-aware. */
function checkCrapRisersBlock(ctx: InlineBlockContext): QualityCheckResult[] {
	const { filePath, absFilePath, fileContent, cwd } = ctx;
	if (!ctx.baseline?.crapScores || ctx.diffAware?.enabled === false) return [];
	const risers = computeCrapRisers({
		content: fileContent,
		absFilePath,
		cwd,
		baseline: ctx.baseline.crapScores,
	});
	if (risers.length === 0) return [];
	const detail = listWithOverflow(
		risers,
		(f) =>
			`  ${f.function}: CRAP ${f.crap_score.toFixed(0)} (cyc ${f.complexity}, cov ${f.coverage_pct.toFixed(0)}%)`,
	);
	return [
		{
			name: "crap",
			severity: "warning",
			message: `${risers.length} function(s) with risen CRAP in ${filePath} — complex code that lost coverage`,
			file: filePath,
			detail: `${detail}\n→ restore a test exercising these branches, or simplify the function.`,
		},
	];
}

/** Section 8: agent-safety checks (post phase), with cold-file gate. */
function checkAgentSafetyBlock(ctx: InlineBlockContext): QualityCheckResult[] {
	const { filePath, absFilePath, fileContent } = ctx;
	// Mythos Phase 4 recency gate: when filePriority is provided AND this file
	// is "cold" (>180 days unchanged in git), drop the heuristic detectors and
	// keep only fully-deterministic ones. New/untracked files always pass the
	// gate (fail-OPEN).
	const coldFileMode =
		ctx.filePriority !== undefined &&
		!shouldRunAdvisoryChecks(filePath, ctx.filePriority);
	const agentSafetyChecks = buildAgentSafetyChecks(
		fileContent,
		absFilePath,
		"post",
		undefined,
		coldFileMode,
	);

	const out: QualityCheckResult[] = [];
	for (const check of agentSafetyChecks) {
		const matches =
			check.name === "code_clones" &&
			ctx.diffAware?.enabled !== false &&
			ctx.baseline?.dryCloneBaseline
				? filterDryToRisers(
						checkCodeCloneFindings(fileContent, absFilePath),
						ctx.baseline.dryCloneBaseline,
					).map(formatCodeCloneFinding(absFilePath))
				: check.fn();
		if (matches.length > 0) {
			out.push({
				name: check.name,
				severity: check.severity,
				message: `${matches.length} ${check.name.replace(/_/g, " ")} issue(s) in ${filePath}`,
				file: filePath,
				detail: listWithOverflow(matches, (m) => `  L${m.line}: ${m.text}`),
			});
		}
	}
	return out;
}

/** Section 8b: library-footgun registry, grouped by check id. */
function checkFootgunBlock(ctx: InlineBlockContext): QualityCheckResult[] {
	const { filePath, fileContent, cwd } = ctx;
	const disabledLibs = loadDisabledLibraries(cwd);
	const footgunFindings = runFootgunChecks(fileContent, filePath, disabledLibs);
	if (footgunFindings.length === 0) return [];
	const byId = new Map<string, typeof footgunFindings>();
	for (const f of footgunFindings) {
		const bucket = byId.get(f.id) || [];
		bucket.push(f);
		byId.set(f.id, bucket);
	}
	const out: QualityCheckResult[] = [];
	for (const [id, bucket] of byId) {
		const first = bucket[0];
		// NOT migrated to listWithOverflow: this is the one site where the
		// overflow line trails the fix-instruction rather than the list, so the
		// helper would reorder operator-facing output. Left explicit.
		const shown = bucket.slice(0, MAX_LISTED_FINDINGS);
		const detail = `${shown
			.map((f) => `  L${f.match.line}: ${f.match.text}`)
			.join("\n")}\n→ ${nonNull(first).fixInstruction}`;
		const overflow =
			bucket.length > MAX_LISTED_FINDINGS
				? `\n  ... and ${bucket.length - MAX_LISTED_FINDINGS} more`
				: "";
		out.push({
			name: id,
			severity: "warning",
			message: `${bucket.length} ${nonNull(first).name} issue(s) in ${filePath} [${nonNull(first).library}]`,
			file: filePath,
			detail: detail + overflow,
		});
	}
	return out;
}
