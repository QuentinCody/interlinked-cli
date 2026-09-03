// ===========================================
// Runtime control paths observed by workspace effect capture
// ===========================================
//
// Paths inside the noisy `.interlinked/` tree that are runtime policy state
// rather than incidental output, plus the Stop-time residue warning
// formatter. Companion to workspace-effects.ts.

import { WATER_LINE_PATHS } from "./evaluator/water-line-files.js";
import type { WorkspaceChangeSet } from "./workspace-effects.js";

/** Control paths that are NOT ratchet water-lines. The water-line subset is
 *  derived from WATER_LINE_PATHS below, so this snapshot set is a strict
 *  superset of the guard set and the two cannot drift apart. */
const NON_WATER_LINE_CONTROL_PATHS = [
	".interlinked/check-policy.json",
	".interlinked/check-policy.local.json",
	".interlinked/config.json",
	".interlinked/config.local.json",
	".interlinked/distilled-rules.json",
	".interlinked/distilled-rules.overrides.json",
	".interlinked/guard-rules.json",
	".interlinked/guard-rules.local.json",
	".interlinked/package-allowlist.json",
	".interlinked/security-config.json",
	".interlinked/suite-baseline.json",
	".interlinked/verify-suppressions.json",
];
export const EXPLICIT_CONTROL_PATHS = new Set([
	...NON_WATER_LINE_CONTROL_PATHS,
	...WATER_LINE_PATHS,
]);

/** Runtime policy files observed even though the noisy `.interlinked/` tree is collapsed. */
export function isWorkspaceControlPath(path: string): boolean {
	return EXPLICIT_CONTROL_PATHS.has(path.replaceAll("\\", "/"));
}

/** Render a bounded Stop warning for writes whose PostToolUse was missed. */
export function formatWorkspaceResidueWarning(changeSet: WorkspaceChangeSet): string | null {
	if (changeSet.files.length === 0) return null;
	const shown = changeSet.files.slice(0, 8).map((effect) => `${effect.kind}:${effect.path}`);
	const more = changeSet.files.length > shown.length
		? ` (+${changeSet.files.length - shown.length} more)`
		: "";
	const completeness = changeSet.complete ? "complete" : "bounded/incomplete";
	const attributed = changeSet.attributed_to_other_sessions ?? 0;
	const attributedNote = attributed > 0
		? ` ${attributed} further effect(s) matched another actor's reconciled writes and were excluded.`
		: "";
	return (
		`[interlinked:effect-residue] Stop observed ${changeSet.files.length} filesystem effect(s) ` +
		`that were not reconciled by PostToolUse (${completeness} snapshot): ${shown.join(", ")}${more}.` +
		`${attributedNote} ` +
		"The files were added to the touched-file rescan; this is a backstop, not rollback of the originating command."
	);
}
