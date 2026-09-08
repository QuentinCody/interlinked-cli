// ===========================================
// Undefined Environment Variable Detection
// ===========================================
// Flags process.env.FOO references whose keys are not declared in the
// project's .env.example / .env.sample / .env.template file.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import type { HarnessEvent, StructuralCheckResult } from "../types.js";
import { readEnvExampleFromDir } from "./env-loader.js";

/**
 * Scan `text` for all `process.env.VAR_NAME` references. Shared by the
 * whole-file scan and the diff-aware edit-slice scan below — same pattern,
 * different input string.
 */
function collectEnvVarRefs(text: string): Set<string> {
	const pattern = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g;
	const vars = new Set<string>();
	let match = pattern.exec(text);
	while (match !== null) {
		vars.add(nonNull(match[1]));
		match = pattern.exec(text);
	}
	return vars;
}

/**
 * Diff-aware narrowing: when the event carries edit content (new_string, or
 * content as a fallback), restrict `usedVars` down to only the keys that
 * edit slice itself introduces — mutated in place. Returns `null` to signal
 * "nothing to report" (either the edit introduces no env vars at all, or
 * narrowing empties the set); returns `usedVars` unchanged when there's no
 * edit content to narrow against (whole-file check applies).
 */
function narrowToEditedVars(
	usedVars: Set<string>,
	event: HarnessEvent | undefined,
): Set<string> | null {
	const editContent =
		(typeof event?.tool_input?.new_string === "string" ? event?.tool_input?.new_string : "") || (typeof event?.tool_input?.content === "string" ? event?.tool_input?.content : "") || "";
	if (!editContent) return usedVars;

	const editVars = collectEnvVarRefs(editContent);
	if (editVars.size === 0) return null;

	// Snapshot the keys before deleting so we never mutate the Set mid-iteration.
	for (const v of [...usedVars]) {
		if (!editVars.has(v)) usedVars.delete(v);
	}
	return usedVars.size === 0 ? null : usedVars;
}

/**
 * Find the nearest .env.example (or .env.sample/.env.template) walking up
 * from `startDir`, bounded to 10 hops.
 */
function findEnvExampleVars(startDir: string): Set<string> | null {
	let dir = startDir;
	for (let i = 0; i < 10; i++) {
		const found = readEnvExampleFromDir(dir);
		if (found) return found;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Detect process.env.FOO references whose key isn't in .env.example.
 * Diff-aware: when an event.tool_input.new_string is present, only report
 * keys that appear in the new slice, not keys that already existed.
 */
export function checkUndefinedEnvVars(
	filePath: string,
	relPath: string,
	event?: HarnessEvent,
): StructuralCheckResult[] {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	const usedVars = collectEnvVarRefs(content);
	if (usedVars.size === 0) return [];

	// Diff-aware: only report env vars introduced by this edit
	if (narrowToEditedVars(usedVars, event) === null) return [];

	const envExampleVars = findEnvExampleVars(dirname(filePath));
	if (!envExampleVars) return []; // No .env.example found

	// Common standard env vars to skip
	const standardVars = new Set([
		"NODE_ENV",
		"PATH",
		"HOME",
		"USER",
		"SHELL",
		"TERM",
		"CI",
		"PORT",
		"HOST",
		"HOSTNAME",
		"TZ",
		"LANG",
		"LC_ALL",
		"PWD",
		"DEBUG",
		"VERBOSE",
		"LOG_LEVEL",
	]);

	const declared = envExampleVars;
	const undefinedVars = [...usedVars].filter((v) => !declared.has(v) && !standardVars.has(v));

	if (undefinedVars.length === 0) return [];

	return [
		{
			check: "undefined_env_vars",
			severity: "info",
			message: `${relPath} references ${undefinedVars.length} env var(s) not in .env.example: ${undefinedVars.slice(0, 5).join(", ")}${undefinedVars.length > 5 ? ` +${undefinedVars.length - 5} more` : ""}. Add them to .env.example for documentation.`,
			file: filePath,
		},
	];
}
