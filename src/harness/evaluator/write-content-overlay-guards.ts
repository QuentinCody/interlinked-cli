import { nonNull } from "../../lib/non-null.js";
import { buildAgentSafetyChecks, buildCheckInstructions } from "../check-registry/index.js";
import {
	evaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay,
	isTscFindingBlocking,
	tscUnavailableWarning,
} from "../diff-overlay.js";
import {
	type PreBlockCheckOutcome,
	preBlockIntroducedBlock,
	preexistingPreBlockWarnings,
	resolveDiskBaseline,
	runPreBlockRegistryGate,
} from "../pre-block-gate.js";
import { findProjectRoot } from "../quality-checks.js";
import type { HarnessDecision } from "../types.js";
import { applyTransientDebt, deferrableFromTsc } from "./transient-debt-guard.js";
import { evaluateTypeErasureOverlay, STRICT_TYPING_RULE_ID } from "./type-erasure-overlay.js";
import type { WriteContentGuardState } from "./write-content-basic-guards.js";
import { buildTscDiffOverlayBlockReason } from "./write-content-tsc-guidance.js";

function projectRootFor(state: WriteContentGuardState): string {
	const fallback = state.event.cwd || process.cwd();
	return findProjectRoot(state.filePath, fallback) || fallback;
}

export function preBlockRegistryGuard(state: WriteContentGuardState): HarnessDecision | null {
	const { content, filePath, warnings } = state;
	void state.postEditContent;
	const outcomes = runPreBlockRegistryGate({
		content,
		filePath,
		baselineContent: resolveDiskBaseline(filePath),
		projectRoot: projectRootFor(state),
	});
	const blocking = outcomes.find((outcome) => outcome.introduced.length > 0 && !outcome.deferrable);
	if (blocking) return preBlockIntroducedBlock(blocking, filePath, warnings);
	const deferrable = outcomes.filter((outcome) => outcome.deferrable);
	if (deferrable.length > 0) {
		const decision = deferrableTransientGuard(state, deferrable);
		if (decision) return decision;
	}
	warnings.push(...preexistingPreBlockWarnings(outcomes, filePath));
	return null;
}

function deferrableTransientGuard(
	state: WriteContentGuardState,
	outcomes: PreBlockCheckOutcome[],
): HarnessDecision | null {
	const { content, event, filePath, rules, warnings } = state;
	const debt = applyTransientDebt({
		filePath,
		projectRoot: projectRootFor(state),
		sessionId: event.session_id,
		dryRun: !!event.dry_run,
		findings: outcomes.flatMap((outcome) =>
			[...outcome.introduced, ...outcome.preexisting].map((match) => ({
				detector: outcome.checkId,
				line: match.line,
				message: match.text,
			})),
		),
		content,
		config: rules.quality_checks.transient_debt,
	});
	warnings.push(...debt.warnings);
	return debt.decision ? { ...debt.decision, warnings } : null;
}

export function biomeDiffOverlayGuard(state: WriteContentGuardState): HarnessDecision | null {
	const { content, externalOverlays, filePath, rules, warnings } = state;
	if (rules.quality_checks.biome_lint?.enabled === false) return null;
	if (!externalOverlays) {
		warnings.push(
			`[interlinked:biome-overlay] NOT CHECKED — external PreTool checks are deferred for ${filePath}; PostToolUse runs the on-disk check without blocking the daemon event loop.`,
		);
		return null;
	}
	const overlay = evaluateBiomeDiffOverlay(filePath, content, projectRootFor(state));
	if (overlay.newFindings.length === 0) return null;
	const first = nonNull(overlay.newFindings[0]);
	if (overlay.exceededBudget) {
		warnings.push(
			`[interlinked:biome-overlay] ${overlay.newFindings.length} new biome finding(s) in ${filePath} from this edit (first: ${first.message} at L${first.line}). Overlay ${overlay.elapsedMs}ms exceeded 500ms budget — demoted to warning.`,
		);
		return null;
	}
	const rest = overlay.newFindings.length - 1;
	const restSummary = rest > 0 ? ` (+ ${rest} more)` : "";
	return {
		decision: "block",
		reason:
			`BLOCKED by biome diff-overlay: this edit introduces ${overlay.newFindings.length} new biome finding(s) in ${filePath}. ` +
			`First: [${first.ruleId ?? "biome"}] L${first.line} — ${first.message}${restSummary}. ` +
			"Fix the new issue(s) in your edit, or retry without introducing them.",
		warnings,
		rule_id: "biome-diff-overlay",
		severity: "high",
		category: "pre-block",
	};
}

export function tscDiffOverlayGuard(state: WriteContentGuardState): HarnessDecision | null {
	const { content, event, externalOverlays, filePath, rules, toolName, warnings } = state;
	if (rules.quality_checks.typescript?.enabled === false) return null;
	if (!externalOverlays) {
		warnings.push(
			tscUnavailableWarning(
				filePath,
				"external PreTool checks are deferred to the admitted PostToolUse path",
			),
		);
		return null;
	}
	const projectRoot = projectRootFor(state);
	const overlay = evaluateTscDiffOverlay(filePath, content, projectRoot);
	if (overlay.checkerUnavailable) {
		warnings.push(tscUnavailableWarning(filePath, overlay.checkerUnavailable));
	}
	const blocking = overlay.newFindings.filter(isTscFindingBlocking);
	for (const finding of overlay.newFindings.filter((item) => !isTscFindingBlocking(item))) {
		warnings.push(
			`[interlinked:tsc-overlay] ${filePath}:${finding.line} — ${finding.ruleId} ${finding.message}. New in this edit (deferred, not dismissed).`,
		);
	}
	const debt = applyTransientDebt({
		filePath,
		projectRoot,
		sessionId: event.session_id,
		dryRun: !!event.dry_run,
		findings: deferrableFromTsc(overlay.proposedFindings),
		content,
		config: rules.quality_checks.transient_debt,
	});
	warnings.push(...debt.warnings);
	if (blocking.length === 0) return debt.decision ? { ...debt.decision, warnings } : null;
	return {
		decision: "block",
		reason: buildTscDiffOverlayBlockReason(toolName, blocking, filePath),
		warnings,
		rule_id: "tsc-diff-overlay",
		severity: "high",
		category: "pre-block",
	};
}

export function strictTypingOverlayGuard(state: WriteContentGuardState): HarnessDecision | null {
	const { content, filePath, rules, warnings } = state;
	if (rules.quality_checks.strict_typing_block?.enabled !== true) return null;
	const overlay = evaluateTypeErasureOverlay(filePath, content);
	if (overlay.newFindings.length === 0) return null;
	const first = nonNull(overlay.newFindings[0]);
	const rest = overlay.newFindings.length - 1;
	const restSummary = rest > 0 ? ` (+ ${rest} more)` : "";
	const lineList = overlay.newFindings
		.slice(0, 5)
		.map((finding) => `L${finding.line}`)
		.join(", ");
	return {
		decision: "block",
		reason:
			`BLOCKED by strict-typing pre-overlay: this edit introduces ${overlay.newFindings.length} new type-erasure pattern(s) in ${filePath} (${lineList}). ` +
			`First: [${first.ruleId}] L${first.line} — ${first.message}${restSummary}. ` +
			"Fix the pattern(s) in your edit, or retry without introducing them. " +
			"Justification escapes are accepted: `// @ts-expect-error: <reason>` for suppression directives.",
		warnings,
		rule_id: STRICT_TYPING_RULE_ID,
		severity: "high",
		category: "pre-block",
	};
}

export function runPreWarnRegistry(state: WriteContentGuardState): void {
	const { content, filePath, preEditContent, warnings } = state;
	const instructions = buildCheckInstructions();
	for (const check of buildAgentSafetyChecks(content, filePath, "pre_warn", preEditContent)) {
		const matches = check.fn();
		if (matches.length === 0) continue;
		const lineList = matches.map((match) => `L${match.line}`).join(", ");
		warnings.push(
			`[interlinked:${check.name}] ${filePath} has ${matches.length} violation(s) at ${lineList} — ${instructions[check.name] || ""}`,
		);
	}
}
