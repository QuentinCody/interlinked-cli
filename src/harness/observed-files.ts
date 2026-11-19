// ===========================================
// Observed-only files: provenance for `files_written`
// ===========================================
// `SessionTrajectory.files_written` has two sources. A tool call DECLARES a
// write (Write/Edit target). The Stop residue backstop OBSERVES a change in the
// workspace that no reconciled tool call explains. Several sessions commonly
// work in one checkout, so an observed change is often another actor's write.
//
// Both sources stay in `files_written`, so the Stop rescan still covers a write
// whose PostToolUse was missed. `files_observed_only` records which paths came
// only from observation. A consumer that claims authorship ("you touched",
// "both sessions wrote") must exclude them.

import { resolve } from "node:path";
import type { SessionTrajectory } from "./types.js";

/** Add observed workspace changes to the rescan set. A path this session has
 *  not declared, in raw or absolute form, is marked observed-only. */
export function recordObservedOnly(session: SessionTrajectory, paths: readonly string[], cwd: string): void {
	for (const path of paths) {
		const declared = session.files_written.has(path) || session.files_written.has(resolve(cwd, path));
		if (!declared) (session.files_observed_only ??= new Set()).add(path);
		session.files_written.add(path);
	}
}

/** True when the path is in the rescan set only because a change was observed. */
export function isObservedOnly(session: SessionTrajectory, filePath: string, cwd: string): boolean {
	const observed = session.files_observed_only;
	if (observed === undefined || observed.size === 0) return false;
	if (observed.has(filePath)) return true;
	const absolute = resolve(cwd, filePath);
	for (const path of observed) {
		if (resolve(cwd, path) === absolute) return true;
	}
	return false;
}

/** A declared write by this session ends the observed-only state of its path. */
export function clearObservedOnly(session: SessionTrajectory, paths: readonly string[]): void {
	for (const path of paths) session.files_observed_only?.delete(path);
}

/** Subagent rollup. Call it BEFORE the `files_written` union: a path the parent
 *  already declared stays declared. */
export function mergeObservedOnly(from: SessionTrajectory, to: SessionTrajectory): void {
	for (const path of from.files_observed_only ?? []) {
		if (!to.files_written.has(path)) (to.files_observed_only ??= new Set()).add(path);
	}
}
