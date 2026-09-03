// ===========================================
// PreToolUse pipeline — extracted stages
// ===========================================
// Self-contained pipeline phases lifted verbatim out of `runPreToolPipeline`
// in `pre-tool-pipeline.ts` so the orchestrator stays under the per-file line
// cap. Each helper mutates the in-flight `preDecision` (and/or `ctx` state) in
// place — none short-circuits the pipeline with an early `return` — so the
// orchestrator calls them at the exact same points, in the same order, with
// identical side effects. Behavior-preserving move only; no logic changes.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
	checkProdDeltaWithoutTestDelta,
	checkProdTestLocRatio,
	checkTddCommitGate,
	checkTppLeapfrog,
} from "../behavioral-checks.js";
import {
	checkAssertionCountRegression,
	checkAssertionStrengthWeakening,
	checkAssertionValueSwap,
	checkClockMockAdded,
	checkConventionalCommitCoherence,
	checkDisabledTestDelta,
	checkDoneWithoutVerify,
	checkReintroducesRemovedCode,
	checkTestBlockCountRegression,
	checkTestTimeoutInflation,
	parseCommitMessageFromBash,
} from "../behavioral-diff-checks.js";
import { snapshotCrap } from "../checks/crap-baseline.js";
import { snapshotDryShingles } from "../checks/dry-baseline.js";
import { collectSiblingFunctions } from "../checks/dry-check.js";
import { coverageForFile, loadCoverageFinal } from "../coverage-final-reader.js";
import { capturePrimitiveViolations as captureDiscoveredPrimitiveViolations } from "../discovered-primitives.js";
import { checkFunctionComplexity, checkMissingReturnTypes } from "../generic-checks.js";
import {
	collectSoftwareVersionReferences,
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
	findProjectRoot,
} from "../quality-checks.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import { loadStructureConfig } from "../structure/structure-loader.js";
import type { HarnessDecision, HarnessEvent, PreEditBaseline, SessionTrajectory } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

export {
	runProjectWideGitGate,
	runProjectWideGitGateAsync,
} from "./pre-tool-project-git-gate.js";

/**
 * TDD commit gate: check for unresolved test failures before git commit.
 * Mutates `preDecision` in place (warnings + possible block). Verbatim move.
 */
export function runTddCommitGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): void {
	const { rules } = ctx;
	if (
		preDecision.decision === "allow" &&
		event.tool_name === "Bash" &&
		/\bgit\s+commit\b/.test((event.tool_input?.command as string) || "")
	) {
		// `GuardRulesConfig.structural_checks` is declared required, but a
		// hot-reload / partial-merge window (and the test fixtures that model
		// it — see "uses the warn default when structural_checks is absent")
		// can genuinely hand this function an incompletely-populated rules
		// object. Widening the local binding to `| undefined` keeps that
		// honest instead of asserting a guarantee the runtime doesn't have.
		// SAFETY: `as` (not a plain annotation) is required here — a plain
		// `: T | undefined` binding still narrows via the initializer's real
		// (non-optional) type, defeating the point of this cast.
		const structuralChecks = rules.structural_checks as
			| { test_first_mode?: "nudge" | "warn" | "enforce" }
			| undefined;
		const testFirstMode = structuralChecks?.test_first_mode || "warn";
		const commitMessage = parseCommitMessageFromBash(
			(event.tool_input?.command as string) || "",
		);
		const gateResults = [
			...(session.tdd_cycles.size > 0 ? checkTddCommitGate(session, testFirstMode) : []),
			...checkProdDeltaWithoutTestDelta(session),
			...checkProdTestLocRatio(session),
			...checkTppLeapfrog(session),
			// Batch 3: diff-aware commit gates.
			...checkDisabledTestDelta(session),
			...checkTestBlockCountRegression(session, undefined, commitMessage?.type ?? null),
			...checkAssertionStrengthWeakening(session),
			// Test-oracle integrity (docs/design/test-oracle-integrity.md §4.3).
			...checkAssertionCountRegression(session),
			...checkAssertionValueSwap(session),
			...checkTestTimeoutInflation(session),
			...checkClockMockAdded(session),
			...checkConventionalCommitCoherence(session, commitMessage),
			// Batch 4: trajectory commit gates.
			...checkReintroducesRemovedCode(session),
			...checkDoneWithoutVerify(session),
		];
		if (gateResults.length > 0) {
			const warnings = preDecision.warnings || [];
			for (const r of gateResults) {
				warnings.push(`[interlinked:${r.name}] ${r.message}`);
			}
			preDecision.warnings = warnings;

			if (
				testFirstMode === "enforce" &&
				gateResults.some((r) => r.severity === "error")
			) {
				preDecision.decision = "block";
				preDecision.rule_id ??= "commit-test-first-gate";
				preDecision.reason =
					"BLOCKED: Tests must pass before committing. " +
					gateResults
						.filter((r) => r.severity === "error")
						.map((r) => r.message)
						.join(" ");
			}
		}
	}
}

/**
 * Diff-aware pre-edit baseline capture for file write tools. Snapshots
 * pre-edit metrics into `ctx.preEditBaselines` so PostToolUse checks can
 * diff against them. Verbatim move; pure side effect on `ctx`.
 */
export function captureDiffAwareBaseline(
	ctx: ServerRuntime,
	event: HarnessEvent,
	filePath: string,
): void {
	const { rules } = ctx;
	if (rules.diff_aware?.enabled === false) return;
	const toolName = event.tool_name || "";
	const isFileWrite = [
		"Write",
		"Edit",
		"Update",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
		"apply_patch",
	].includes(toolName);
	if (!isFileWrite) return;

	// apply_patch carries no top-level file_path — resolve every target file
	// from the patch body so each gets a pre-edit baseline. Codex multi-file
	// edits were previously skipped entirely (no CRAP/complexity baseline).
	const targetPaths = filePath ? [filePath] : extractAllEditedFilePaths(event);
	for (const target of targetPaths) {
		captureBaselineForTarget(ctx, target);
	}
}

/**
 * Snapshots the pre-edit metrics for a single edit target into
 * `ctx.preEditBaselines`. Extracted loop body of `captureDiffAwareBaseline`;
 * same side effects, same fail-open error handling.
 */
function captureBaselineForTarget(ctx: ServerRuntime, target: string): void {
	const CWD = ctx.cwd;
	const baselineFilePath = isAbsolute(target) ? target : resolve(CWD, target);
	if (!existsSync(baselineFilePath)) return;
	try {
		const preContent = readFileSync(baselineFilePath, "utf-8");
		const missingRT = checkMissingReturnTypes(preContent, baselineFilePath);
		const complexFns = checkFunctionComplexity(preContent, baselineFilePath);
		// CRAP baseline — fail-open when coverage data is absent.
		const crapScores = snapshotCrapBaseline(CWD, baselineFilePath, preContent);
		let dryCloneBaseline: PreEditBaseline["dryCloneBaseline"] | undefined;
		try {
			dryCloneBaseline = snapshotDryShingles({
				preContent,
				filePath: baselineFilePath,
				candidates: collectSiblingFunctions(baselineFilePath),
			});
		} catch (dryErr) {
			void dryErr; /* clone snapshot must never break the baseline capture */
		}
		ctx.preEditBaselines.set(baselineFilePath, {
			missingReturnTypes: new Set(missingRT.map((m) => m.text)),
			complexFunctions: new Set(complexFns.map((m) => m.text)),
			crapScores,
			dryCloneBaseline,
			capturedAt: Date.now(),
			suppressionCount: countSuppressionDirectives(preContent),
			asAnyCastCount: countAsAnyCasts(preContent),
			nonNullAssertionCount: countNonNullAssertions(preContent),
			unjustifiedCastCount: countUnjustifiedCasts(preContent),
			todoMarkerCount: countTodoMarkers(preContent),
			consoleStatementCount: countConsoleStatements(preContent),
			publicApiSurfaceCount: countPublicApiSurface(preContent),
			typeDensity: countTypeDensity(preContent),
			softwareVersions: collectSoftwareVersionReferences(
				preContent,
				baselineFilePath,
			),
			discoveredPrimitiveViolations: captureDiscoveredPrimitiveViolations(
				CWD,
				preContent,
			),
			ambientSeams: countAmbientSeams(preContent, baselineFilePath),
			assertionStrength: countAssertionStrength(preContent, baselineFilePath),
		});
	} catch (e) {
		void e;
	}
}

/**
 * CRAP pre-edit snapshot for one file. Fail-open: any error (or absent
 * coverage data) yields `undefined` rather than breaking baseline capture.
 */
function snapshotCrapBaseline(
	CWD: string,
	baselineFilePath: string,
	preContent: string,
): Map<string, Map<string, number>> | undefined {
	try {
		const coveragePath = resolve(CWD, "coverage", "coverage-final.json");
		const covCache = loadCoverageFinal(coveragePath, CWD);
		if (!covCache) return undefined;
		const relPath = relative(CWD, baselineFilePath).replace(/\\/g, "/");
		const perFile = coverageForFile(covCache, relPath);
		const mtimeMs = statSync(baselineFilePath).mtimeMs;
		return snapshotCrap({
			preContent,
			filePath: relPath,
			coverage: perFile,
			fileMtime: mtimeMs,
			threshold: 30,
		});
	} catch (crapErr) {
		void crapErr; /* CRAP snapshot must never break the baseline capture */
		return undefined;
	}
}

/**
 * Structure context injection (non-blocking). Surfaces unresolved companion
 * follow-ups from previous edits as a warning. Verbatim move.
 */
export function injectStructureContext(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
	filePath: string,
): void {
	const CWD = ctx.cwd;
	const isFileWriteTool = [
		"Write",
		"Edit",
		"Update",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
	].includes(event.tool_name || "");
	if (!filePath || !isFileWriteTool) return;
	try {
		const structRepoRoot = findProjectRoot(filePath, CWD) || CWD;
		const { config } = loadStructureConfig(structRepoRoot);
		if (config) {
			// Check for unresolved structure follow-ups in session
			const unresolvedStructure = collectUnresolvedStructureFollowUps(session);
			if (unresolvedStructure.length > 0) {
				const warnings = preDecision.warnings || [];
				warnings.push(
					`[interlinked:structure] Unresolved companion follow-ups from previous edits:\n${unresolvedStructure.map((u) => `  - ${u}`).join("\n")}`,
				);
				preDecision.warnings = warnings;
			}
		}
	} catch (e) {
		void e;
	}
}

/**
 * Describes every `struct:` pending completion in the session that still has
 * unresolved affected files. Extracted from `injectStructureContext`.
 */
function collectUnresolvedStructureFollowUps(session: SessionTrajectory): string[] {
	const unresolvedStructure: string[] = [];
	for (const [key, completion] of session.pending_completions) {
		if (!key.startsWith("struct:")) continue;
		const remaining = completion.affected_files.filter(
			(f) => !completion.resolved_files.has(f),
		);
		if (remaining.length > 0) {
			unresolvedStructure.push(`${completion.description}: ${remaining.join(", ")}`);
		}
	}
	return unresolvedStructure;
}
