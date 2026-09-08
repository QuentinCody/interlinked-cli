// interlinked-tdd: exempt
// ===========================================
// CoverageRunner — coverage.py JSON parsing
// ===========================================
// Pure parsing helpers extracted from coverage-runner.ts (leaf cluster): turn
// coverage.py's native `coverage.json` (PER-LINE: `executed_lines` /
// `missing_lines`) into `Map<repoRelPath, PerFileCoverage>`. No AST function
// ranges, no LCOV detour — the per-edit gate reads the per-line fields directly.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { PerFileCoverage } from "./coverage-final-reader.js";

/** Coerce a coverage.py line array (`number[]`) into a Set, dropping non-ints. */
function toLineSet(raw: unknown): Set<number> {
	const set = new Set<number>();
	if (!Array.isArray(raw)) return set;
	for (const v of raw) {
		if (typeof v === "number" && Number.isInteger(v) && v > 0) set.add(v);
	}
	return set;
}

/**
 * Resolve a coverage.py file key to a repo-relative POSIX path, or null when it
 * resolves outside `projectRoot`. coverage.py keys are usually project-relative
 * but may be absolute; both resolve correctly against the root.
 */
function relForKey(key: string, projectRoot: string): string | null {
	if (!key) return null;
	const abs = isAbsolute(key) ? key : resolve(projectRoot, key);
	const rel = relative(projectRoot, abs).replace(/\\/g, "/");
	if (!rel || rel.startsWith("..")) return null;
	return rel;
}

/**
 * Parse coverage.py's `coverage.json` into `Map<repoRelPath, PerFileCoverage>`.
 * Each entry carries per-line `coveredLines` / `uncoveredLines` (from
 * `executed_lines` / `missing_lines`) and an empty `functions` list — coverage.py
 * has no function ranges, and the per-edit gate reads the per-line fields for
 * these. Returns null when the JSON is absent, unparseable, or has no `files`
 * map — the runner turns that into `ok:false`.
 */
export function parseCoveragePyJson(
	reportPath: string,
	projectRoot: string,
): Map<string, PerFileCoverage> | null {
	if (!existsSync(reportPath)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(reportPath, "utf-8"));
	} catch {
		return null;
	}
	if (!isJsonObject(raw) || !isJsonObject(raw.files)) return null;
	const files = raw.files;

	const result = new Map<string, PerFileCoverage>();
	for (const [key, rawEntry] of Object.entries(files)) {
		if (!isJsonObject(rawEntry)) continue;
		const entry = rawEntry;
		const rel = relForKey(key, projectRoot);
		if (!rel) continue;
		result.set(rel, {
			filePath: rel,
			mtime: 0,
			functions: [],
			coveredLines: toLineSet(entry.executed_lines),
			uncoveredLines: toLineSet(entry.missing_lines),
		});
	}
	return result;
}
