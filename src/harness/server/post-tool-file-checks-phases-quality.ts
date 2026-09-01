// interlinked-tdd: exempt
// ===========================================
// PostToolUse — quality + scored-suggestion phase helpers
// ===========================================
// Leaf helpers extracted verbatim from `post-tool-file-checks-phases.ts` to
// keep the orchestrator file under the per-file line cap. These are the
// quality-phase support functions (smart-tsc opts, checks-ran tracking,
// sibling fan-out, result collection, blocking decision) plus the
// self-contained scored-suggestions phase. Logic is byte-identical to the
// inline versions; only their host file changed.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GENERIC_CHECK_META, QUALITY_CHECK_META } from "../check-metadata.js";
import { isOperationalCheckDeferral } from "../operational-check-deferrals.js";
import type { QualityCheckResult } from "../quality-checks/result-types.js";
import {
	classifyDeterminism,
	findProjectRoot,
	formatQualityWarnings,
	type QualityCheckOptions,
} from "../quality-checks.js";
import { isAcknowledged } from "../session-state.js";
import { DEFAULT_TRIGGERS, expandSiblings } from "../sibling-expansion.js";
import {
	type Finding,
	formatScoredFindings,
	scoreFindings,
	writeTelemetry,
} from "../suggestion-scorer.js";
import { loadFileSuppressions, scanInlineSuppressions } from "../suppressions.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { collectDeletionHygieneDiffFindings } from "./deletion-hygiene-diff.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";
import { collectSuggestionFindings } from "./suggestion-checks.js";

/** Whether a quality result records missing evidence rather than a verdict. */
export function isQualityDeferralName(name: string): boolean {
	return isOperationalCheckDeferral(name);
}

function deferredCheckLabel(result: QualityCheckResult): string {
	const match = result.message.match(/\(([^()]+)\)\s*$/);
	if (result.name === "external_check_deferred") {
		return match?.[1] ?? "external checks";
	}
	if (result.name === "affected_tests_deferred") return "affected tests";
	return result.name.replace(/_/g, " ");
}

function deferredReason(result: QualityCheckResult): string {
	const detail = result.detail
		?.replace(/^No (?:check|project-wide|test) verdict was produced[:.]?\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
	if (detail) return detail;
	const messageReason = result.message.match(/\(([^()]+)\)\s*$/)?.[1];
	return messageReason ?? "checker unavailable";
}

function groupQualityDeferrals(
	qualityResults: readonly QualityCheckResult[],
): Map<string, QualityCheckResult[]> {
	const groups = new Map<string, QualityCheckResult[]>();
	for (const result of qualityResults) {
		if (!isQualityDeferralName(result.name)) continue;
		const key = result.file ?? "";
		const group = groups.get(key) ?? [];
		group.push(result);
		groups.set(key, group);
	}
	return groups;
}

/**
 * Keep deferral evidence individually structured while presenting one compact,
 * actionable warning per file. Even a lone deferral uses this formatter: the
 * generic quality formatter appends the full per-check repair playbook, which
 * turned ordinary capacity backpressure into a 10+ line PostToolUse panel.
 */
/** Public formatting seam shared by the per-file and project-wide PostToolUse
 * phases so every no-verdict result follows the same compact output contract. */
export function formatQualityDecisionWarnings(
	qualityResults: QualityCheckResult[],
): string[] {
	const deferredByFile = groupQualityDeferrals(qualityResults);
	const warnings: string[] = [];
	const emittedDeferredFiles = new Set<string>();
	for (const result of qualityResults) {
		if (!isQualityDeferralName(result.name)) {
			warnings.push(...formatQualityWarnings([result]));
			continue;
		}

		const key = result.file ?? "";
		if (emittedDeferredFiles.has(key)) continue;
		emittedDeferredFiles.add(key);
		const group = deferredByFile.get(key) ?? [result];
		const target = result.file ? ` for ${result.file}` : "";
		const labels = [...new Set(group.map(deferredCheckLabel))];
		const reasons = [...new Set(group.map(deferredReason))];
		const checkWord = group.length === 1 ? "check" : "checks";
		warnings.push(
			`[interlinked:checks-deferred] [proven] NOT CHECKED: ${labels.join(", ")}${target} (${reasons.join("; ")}). Retry each deferred check after active project work finishes; no clean verdict exists for ${checkWord}.`,
		);
	}
	return warnings;
}

/**
 * Smart-tsc filtering: when only internal logic changed (no export-surface
 * change) and tsc is enabled, still run tsc but filter output to the edited
 * file only. Returns `{ tscFilterFile }` when the gate applies, else undefined
 * (callers spread the result, so an absent key leaves opts untouched under
 * exactOptionalPropertyTypes).
 */
export function buildSmartTscOpts(
	ctx: ServerRuntime,
	structuralConfig: GuardRulesConfig["structural_checks"],
	editedFilePath: string,
	exportSurfaceChanged: boolean,
): QualityCheckOptions | undefined {
	if (
		!structuralConfig.smart_tsc ||
		exportSurfaceChanged ||
		!editedFilePath ||
		!ctx.rules.quality_checks.typescript?.enabled
	) {
		return undefined;
	}
	const filterFile = relative(
		findProjectRoot(editedFilePath, ctx.cwd) || ctx.cwd,
		editedFilePath,
	);
	ctx.log(`Smart tsc: filtering to ${filterFile} (internal-only edit)`);
	return { tscFilterFile: filterFile };
}

/**
 * Sibling expansion (PostToolUse fan-out): when a finding hits a known
 * type-erasure / boundary trigger, query the trigram index for every other
 * instance and append one quality row per sibling. Mutates `qualityResults`
 * in place. Advisory — never throws (failures are logged only).
 */
export function expandQualitySiblings(
	ctx: ServerRuntime,
	editedFilePath: string,
	qualityResults: QualityCheckResult[],
): void {
	const triggerNames = new Set(DEFAULT_TRIGGERS.map((t) => t.triggerName));
	const triggers = qualityResults
		.filter((r) => triggerNames.has(r.name))
		.map((r) => ({ name: r.name, file: r.file ?? editedFilePath }));
	if (!ctx.trigramIndex || triggers.length === 0) return;
	const CWD = ctx.cwd;
	try {
		const siblings = expandSiblings({
			triggers,
			index: ctx.trigramIndex,
			reader: {
				read: (relPath: string): string | undefined => {
					try {
						return readFileSync(`${CWD}/${relPath}`, "utf-8");
					} catch (e) {
						void e;
						return undefined;
					}
				},
			},
			cwd: CWD,
		});
		for (const s of siblings) {
			qualityResults.push({
				name: s.siblingRuleId,
				severity: "warning",
				message: s.message,
				file: s.file,
			});
		}
		if (siblings.length > 0) {
			ctx.log(
				`Sibling expansion: ${siblings.length} row(s) across ${triggers.length} trigger(s)`,
			);
		}
	} catch (e) {
		// Sibling fan-out is advisory — never fail the post-edit pipeline on it.
		ctx.log(`Sibling expansion failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Append each quality finding into `allCheckResults` with its resolved
 *  determinism (quality meta → generic meta → fully_deterministic default). */
export function collectQualityResultEntries(
	qualityResults: QualityCheckResult[],
	allCheckResults: PerFileCheckCtx["allCheckResults"],
): void {
	for (const r of qualityResults) {
		allCheckResults.push({
			source: "quality",
			name: r.name,
			severity: r.severity,
			message: r.message,
			file: r.file,
			detail: r.detail,
			determinism:
				QUALITY_CHECK_META[r.name]?.determinism ??
				GENERIC_CHECK_META[r.name]?.determinism ??
				// Align the fallback with the agent-facing tag (classifyDeterminism):
				// footgun / known-heuristic checks resolve to "heuristic" here too, so
				// the check-results sink and the [proven]/[heuristic] tag stop
				// disagreeing. Genuinely-unknown ids keep the conservative
				// fully_deterministic default (no emitted check is truly unregistered).
				(classifyDeterminism(r.name) === "heuristic" ? "heuristic" : "fully_deterministic"),
		});
	}
}

/**
 * Surface quality findings: append formatted warnings to `decision.warnings`
 * and flip `decision.decision` to "block" for fully-deterministic errors or
 * the software_version_regression post-tool attention channel.
 */
export function applyQualityDecision(
	ctx: ServerRuntime,
	qualityResults: QualityCheckResult[],
	decision: HarnessDecision,
): void {
	if (qualityResults.length === 0) return;
	decision.warnings = [
		...(decision.warnings || []),
		...formatQualityDecisionWarnings(qualityResults),
	];

	// Block only on fully_deterministic quality checks with error severity, plus
	// the software_version_regression attention channel (PostToolUse returns
	// `block` for compatibility even though the mutation already landed). Every
	// heuristic check (strong_typing, magic numbers, taste smells) is advisory.
	const isBlockingResult = (r: QualityCheckResult): boolean =>
		(r.severity === "error" &&
			QUALITY_CHECK_META[r.name]?.determinism === "fully_deterministic") ||
		r.name === "software_version_regression";

	const blocking = qualityResults.filter(isBlockingResult);
	const advisory = qualityResults.filter((r) => !isBlockingResult(r));

	if (blocking.length > 0) {
		decision.decision = "block";
		// Rule id = the lead blocking check's name (e.g. "typescript"), so
		// activity/recurrence aggregation can see repeat-block thrash — 216 of
		// the last 735 guard_block rows had NO id, all from paths like this one
		// (2026-07 telemetry), making retry loops invisible to `query blocks --by
		// guard_rule_id`.
		decision.rule_id ??= blocking[0]?.name;
		// Compose the block reason so the actionable (blocking) findings lead and
		// the advisory pile is demoted into a clearly-labelled tail. Without the
		// split, one deterministic error drags the whole heuristic list into the
		// human-visible block reason and buries the thing that must be fixed.
		// Bug B1: a PostToolUse block MUST carry a reason, else the hook renders
		// the "no reason was attached" fallback.
		const blockingText =
			formatQualityDecisionWarnings(blocking).join("\n\n") ||
			"[interlinked] PostToolUse quality checks flagged a deterministic error.";
		const advisoryText = formatQualityDecisionWarnings(advisory).join("\n\n");
		decision.reason ??= advisoryText
			? `${blockingText}\n\n— Advisory findings (not blocking; address when convenient) —\n\n${advisoryText}`
			: blockingText;
	}

	// Outcome label for the daemon log: a deterministic error is a hard block;
	// software_version_regression alone is the softer "attention" channel.
	const hasDeterministicError = qualityResults.some(
		(r) =>
			r.severity === "error" &&
			QUALITY_CHECK_META[r.name]?.determinism === "fully_deterministic",
	);
	const outcome = hasDeterministicError
		? "blocking"
		: blocking.length > 0
			? "post-tool attention required"
			: "advisory";
	ctx.log(
		`Quality issues found: ${qualityResults.map((r) => r.name).join(", ")} (${outcome})`,
	);
}

/**
 * Compute the edited region's line span (for proximity scoring) from the
 * position of `oldStr` within `suggContent`. `editStartLine`/`editEndLine`
 * are always produced together — undefined means "no proximity hint",
 * either because there is no `old_string` or it isn't found in the current
 * content.
 */
function computeEditRegion(
	suggContent: string,
	oldStr: string | undefined,
): { editStartLine: number; editEndLine: number } | undefined {
	if (!oldStr || !suggContent) return undefined;
	const idx = suggContent.indexOf(oldStr);
	if (idx < 0) return undefined;
	const editStartLine = suggContent.slice(0, idx).split("\n").length;
	const editEndLine = editStartLine + oldStr.split("\n").length;
	return { editStartLine, editEndLine };
}

/**
 * Scored-suggestions phase: regex heuristics + deletion-hygiene diff
 * detectors, scored/limited, with telemetry. Non-deterministic, top 1-3.
 */
export function runScoredSuggestionsPhase(
	ctx: ServerRuntime,
	checkEvent: HarnessEvent,
	editedFilePath: string,
	// `session` is typed required, but the PostToolUse caller looks it up by
	// id and can genuinely come up empty at runtime (see the sibling
	// `session` comment in post-tool-file-checks.ts) — honest about that here.
	session: SessionTrajectory | undefined,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const CWD = ctx.cwd;
	const log = ctx.log;
	const rules = ctx.rules;
	const { allCheckResults } = acc;

	// ── Scored suggestions (non-deterministic heuristics, top 1-3) ──
	if (!editedFilePath || !existsSync(editedFilePath)) return;
	try {
		const suggContent = readFileSync(editedFilePath, "utf-8");
		const inlineSup = scanInlineSuppressions(suggContent);
		const relPath = relative(CWD, editedFilePath);
		const fileSup = loadFileSuppressions(join(CWD, ".interlinked"), relPath);

		// Collect findings from regex heuristics (30+ checks).
		// Registry lives in ./server/suggestion-checks.ts for auditing.
		const allFindings: Finding[] = collectSuggestionFindings(
			suggContent,
			editedFilePath,
		);

		// --- Deletion hygiene (Layer 2): diff-aware zombie detectors ---
		// These compare old_string vs new_string to catch the agent hedging.
		allFindings.push(
			...collectDeletionHygieneDiffFindings({
				oldString: checkEvent.tool_input?.old_string as string | undefined,
				newString: checkEvent.tool_input?.new_string as string | undefined,
				filePath: editedFilePath,
			}),
		);

		if (allFindings.length === 0) return;

		// Compute edit region for proximity scoring
		const oldStr = checkEvent.tool_input?.old_string as string | undefined;
		const editRegion = computeEditRegion(suggContent, oldStr);

		const rawScored = scoreFindings(allFindings, {
			filePath: editedFilePath,
			...(session ? { session } : {}),
			...(editRegion
				? { editStartLine: editRegion.editStartLine, editEndLine: editRegion.editEndLine }
				: {}),
			inlineSuppressions: inlineSup,
			fileSuppressions: fileSup,
			limit: rules.suggestion_limit ?? 3,
			threshold: rules.suggestion_threshold ?? 0.5,
		});

		// Session-ack suppression for suggestions (always warning severity).
		// No session to check acknowledgement against means nothing is
		// acknowledged yet — keep every finding rather than dereferencing.
		const scored = session
			? rawScored.filter((s) => !isAcknowledged(session, editedFilePath, s.check))
			: rawScored;

		if (scored.length > 0) {
			for (const s of scored) {
				allCheckResults.push({
					source: "suggestion",
					name: s.check,
					severity: "warning",
					message: s.message,
					file: editedFilePath || undefined,
					score: s.score,
					line: s.line,
					determinism: "heuristic",
				});
			}
			const suggWarnings = formatScoredFindings(scored);
			decision.warnings = [
				...(decision.warnings || []),
				...suggWarnings,
			];
			log(
				`Suggestions: ${scored.map((s) => `${s.check}(${s.score.toFixed(2)})`).join(", ")}`,
			);
		}

		// Telemetry (non-blocking)
		writeTelemetry(allFindings, scored, {
			interlinkedDir: join(CWD, ".interlinked"),
			sessionId: checkEvent.session_id,
			agentName: session?.agent_name || "unknown",
			filePath: relPath,
			threshold: rules.suggestion_threshold ?? 0.5,
		});
	} catch (e) {
		void e;
	}
}
