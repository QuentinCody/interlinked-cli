// ===========================================
// Idempotent purge — drop prior Interlinked registrations before insert
// ===========================================
// Extracted from `installer.ts`, which sits at the repo's 500-line cap. The
// installer calls this cluster twice: `purgePriorEntries` cleans the settings
// object it is about to merge into, and `cleanProjectOwnedHooks` cleans a file
// a *prior* install wrote that this run does not rewrite.
//
// `InstallScope` and `SCOPE_USER` live here rather than in `installer.ts`
// because the verdict builder needs them and `installer.ts` imports this
// module — leaving them there would make the two files cyclic. `installer.ts`
// imports both back.

import { existsSync } from "node:fs";
import {
	isInterlinkedHookEntry,
	isProjectOwnedHookEntry,
	withoutIncomingDuplicates,
} from "../lib/hook-ownership.js";
import type { JsonObject } from "../lib/json-types.js";
import { readJson, writeAtomic } from "./installer-merge-engine.js";

export type InstallScope = "user" | "project" | "local";

/** Scope identity as a named constant — `as const` keeps its literal type so
 *  equality checks narrow correctly. */
export const SCOPE_USER = "user" as const;

/** Per-entry verdict for the pre-merge purge. */
type PurgeVerdict = "remove" | "foreign" | "keep";
const VERDICT_REMOVE: PurgeVerdict = "remove";
const VERDICT_FOREIGN: PurgeVerdict = "foreign";
const VERDICT_KEEP: PurgeVerdict = "keep";

export interface PurgeReport {
	/** Interlinked entries removed (owned by this project). */
	removed: number;
	/** Interlinked entries left in place (owned by another project). */
	foreign: number;
}

/** A JSON container we can index by key — i.e. not null, not an array. */
function isJsonObject(value: unknown): value is JsonObject {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Build the per-entry verdict for an install at `scope`. At project/local
 *  scope the settings file lives inside the repo, so every Interlinked entry
 *  in it belongs to this project and is replaced. At user scope the file is
 *  shared across repos: only entries this project registered are replaced;
 *  another repo's Interlinked hooks are left in place (reported as foreign)
 *  rather than silently uninstalled. */
export function makePurgeVerdict(
	scope: InstallScope,
	projectRoot: string,
): (entry: unknown) => PurgeVerdict {
	if (scope === SCOPE_USER) {
		return (entry) => {
			if (!isInterlinkedHookEntry(entry)) return VERDICT_KEEP;
			return isProjectOwnedHookEntry(entry, projectRoot) ? VERDICT_REMOVE : VERDICT_FOREIGN;
		};
	}
	return (entry) => (isInterlinkedHookEntry(entry) ? VERDICT_REMOVE : VERDICT_KEEP);
}

/** Walk the fragment's structure and, for every hook array it will write,
 *  drop pre-existing Interlinked-owned entries from the matching array in
 *  `base`. Runs before `mergeSettings`, so the subsequent append converges to
 *  exactly the fragment's entries. Mutates `base` in place. */
export function purgePriorEntries(
	base: JsonObject,
	fragment: unknown,
	verdict: (entry: unknown) => PurgeVerdict,
	report: PurgeReport,
): void {
	if (!isJsonObject(fragment)) return;
	for (const key of Object.keys(fragment)) {
		const fragValue = fragment[key];
		if (Array.isArray(fragValue)) {
			purgeDeclaredArray(base, key, fragValue, verdict, report);
			continue;
		}
		const childBase = base[key];
		if (!isJsonObject(fragValue) || !isJsonObject(childBase)) continue;
		purgePriorEntries(childBase, fragValue, verdict, report);
		// The recursion above only reaches keys the FRAGMENT declares; this
		// reaches the ones it no longer does. See sweepUndeclaredKeys.
		sweepUndeclaredKeys(childBase, fragValue, verdict, report);
	}
}

/** Purge one hook array the fragment is about to write into. The incoming
 *  duplicates go first: sparing one re-adds it on every install. */
function purgeDeclaredArray(
	base: JsonObject,
	key: string,
	fragValue: unknown[],
	verdict: (entry: unknown) => PurgeVerdict,
	report: PurgeReport,
): void {
	const existing = base[key];
	if (!Array.isArray(existing)) return;
	const deduped = withoutIncomingDuplicates(existing, fragValue);
	report.removed += existing.length - deduped.length;
	base[key] = filterEntries(deduped, verdict, report);
}

/** Sweep the keys `base` carries that `frag` no longer declares.
 *
 *  Without this the purge is blind to its own history: it walks the FRAGMENT's
 *  keys, so an event the installer USED to register and no longer does is never
 *  visited, and its stale Interlinked entries survive every later install
 *  forever. Live instance: `PostToolUseFailure` was dropped from the Claude
 *  Code adapter's registered events precisely to stop the runner reporting
 *  "2 PostToolUse hooks ran", yet the old registration stayed in
 *  `.claude/settings.json` and kept the double count alive.
 *
 *  Uses the SAME `verdict` as the declared-key path, so a user-scope install
 *  still spares another repo's hooks (tallied as foreign) — which is the whole
 *  reason the verdict is a parameter rather than a hardcoded predicate. */
function sweepUndeclaredKeys(
	base: JsonObject,
	frag: JsonObject,
	verdict: (entry: unknown) => PurgeVerdict,
	report: PurgeReport,
): void {
	// `Object.keys` snapshots the key list, so deleting inside the loop is safe.
	for (const key of Object.keys(base)) {
		if (key in frag) continue;
		filterEventArrayInPlace(base, key, verdict, report);
	}
}

/** Filter the hook array at `container[key]` in place, tallying into `report`.
 *  A key the filter empties is DELETED rather than left behind, so the file
 *  does not accrue `"PreToolUse": []` litter. Non-array values are ignored. */
function filterEventArrayInPlace(
	container: JsonObject,
	key: string,
	verdict: (entry: unknown) => PurgeVerdict,
	report: PurgeReport,
): void {
	const arr = container[key];
	if (!Array.isArray(arr)) return;
	const kept = filterEntries(arr, verdict, report);
	if (kept.length === arr.length) return;
	if (kept.length === 0) {
		delete container[key];
	} else {
		container[key] = kept;
	}
}

/** Filter one hook array by `verdict`, tallying removals/foreign hits. */
function filterEntries(
	existing: unknown[],
	verdict: (entry: unknown) => PurgeVerdict,
	report: PurgeReport,
): unknown[] {
	const kept: unknown[] = [];
	for (const item of existing) {
		const v = verdict(item);
		if (v === VERDICT_REMOVE) {
			report.removed++;
			continue;
		}
		if (v === VERDICT_FOREIGN) report.foreign++;
		kept.push(item);
	}
	return kept;
}

/** Remove this project's Interlinked hook entries from every hook array in the
 *  settings file at `settingsPath`, using a pre-built `verdict` (carries scope
 *  + project root). Used to clear a prior install that landed in a different
 *  file than the current run writes — the in-place purge can only reach the
 *  file being rewritten. At user scope the verdict spares other repos' hooks.
 *  Returns the number of entries removed. */
export function cleanProjectOwnedHooks(
	settingsPath: string,
	verdict: (entry: unknown) => PurgeVerdict,
	dryRun: boolean,
): number {
	if (!existsSync(settingsPath)) return 0;
	const settings = readJson(settingsPath);
	// `null` = malformed JSON — leave a file we can't safely rewrite alone.
	if (settings === null) return 0;
	const hooksObj = settings.hooks;
	if (!isJsonObject(hooksObj)) return 0;
	const report: PurgeReport = { removed: 0, foreign: 0 };
	for (const event of Object.keys(hooksObj)) {
		filterEventArrayInPlace(hooksObj, event, verdict, report);
	}
	if (report.removed > 0) {
		if (Object.keys(hooksObj).length === 0) delete settings.hooks;
		if (!dryRun) writeAtomic(settingsPath, settings);
	}
	return report.removed;
}
