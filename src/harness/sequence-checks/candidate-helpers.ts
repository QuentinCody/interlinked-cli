// Shared helpers for sequence detectors: candidate-event accessors, the
// confidential-sensitivity set, and the declared-plan tool-hint predicate.
//
// These lived as byte-identical copies in `injection.ts`, `security.ts`, and
// `quality.ts`. They carry no family-specific meaning — a Bash candidate is a
// Bash candidate in every family — so they collapse to one definition here.

import type { SensitivityLevel } from "../types.js";

/** Sensitivity levels that count as "sensitive data is in flight". */
export const CONFIDENTIAL_LEVELS: ReadonlySet<SensitivityLevel> = new Set<SensitivityLevel>([
	"Confidential",
	"HighlyConfidential",
]);

/** Extract the Bash command string from a candidate's tool input, or "". */
export function getCommand(toolInput: { command?: unknown } | undefined): string {
	if (!toolInput) return "";
	const cmd = toolInput.command;
	return typeof cmd === "string" ? cmd : "";
}

/** True when the candidate event is a Bash tool call. */
export function isBashCandidate(toolName: string | undefined): boolean {
	return toolName === "Bash";
}

/**
 * True when the candidate tool is consistent with the declared plan's tool
 * hints. Absent plan, absent hints, or an absent candidate tool all read as
 * "no divergence evidence", so the predicate returns true.
 */
export function planHintsContainTool(
	candidateTool: string | undefined,
	plan: { steps?: ReadonlyArray<{ tool_hint?: string }> } | undefined,
): boolean {
	const hints = plan?.steps
		?.map((s) => s.tool_hint)
		.filter((h): h is string => typeof h === "string" && h.length > 0);
	if (!hints || hints.length === 0) return true;
	if (!candidateTool) return true;
	const normalized = candidateTool.toLowerCase();
	return hints.some((h) => h.toLowerCase() === normalized);
}
