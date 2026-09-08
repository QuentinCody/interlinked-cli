// ===========================================
// Structural Check Helpers
// ===========================================
// Small shared utilities used across multiple check implementations.

import type { ExportedSymbol, HarnessEvent } from "../types.js";

/** Public API — consumed by structural-checks submodules. */
export function extractFilePath(event: Pick<HarnessEvent, "tool_input">): string | null {
	const path = (typeof event.tool_input?.file_path === "string" ? event.tool_input?.file_path : "") || (typeof event.tool_input?.path === "string" ? event.tool_input?.path : "");
	return path || null;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks and
 * shouldSkipTsc. Returns true when the new export set differs from the old
 * by name, kind, or type-only-ness.
 */
export function exportSurfaceChanged(
	oldExports: ExportedSymbol[],
	newExports: ExportedSymbol[],
): boolean {
	if (oldExports.length !== newExports.length) return true;
	const oldNames = new Set(oldExports.map((e) => `${e.name}:${e.kind}:${e.isTypeOnly}`));
	for (const exp of newExports) {
		if (!oldNames.has(`${exp.name}:${exp.kind}:${exp.isTypeOnly}`)) return true;
	}
	return false;
}

/** Public API — consumed by structural-checks PreToolUse context builder. */
export function isWriteOperation(toolName: string): boolean {
	return [
		"Write",
		"Edit",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
		"NotebookEdit",
	].includes(toolName);
}

/** Public API — consumed by structural-checks PreToolUse context builder. */
export function isReadOperation(toolName: string): boolean {
	return ["Read", "ReadFile", "read_file", "Glob", "Grep"].includes(toolName);
}

/** Public API — consumed by dead-imports check. Escape regex meta-characters. */
export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
