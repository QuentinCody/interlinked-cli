// ===========================================
// Installer reconciliation — post-per-adapter cleanup + manifest merge
// ===========================================
// Extracted from `installHooks()` in `installer.ts` (2026-09-02,
// cyclomatic-cap decompose: `installHooks` was CC 19, over the 16 cap).
// `installer.ts` sits at the 500-line cap and may not grow, so these steps
// live here instead of as sibling private functions in that file. Pure
// mechanism — the "why" for each step is documented at `installHooks`' call
// site and repeated tersely below.

import type { InstallerManifestEntry, RunnerAdapter } from "./adapters/index.js";
import { resolveSettingsPath } from "./installer-merge-engine.js";
import { cleanProjectOwnedHooks, type InstallScope, makePurgeVerdict, SCOPE_USER } from "./installer-purge.js";
import { managedProviderFileHash, removeManagedProviderFile } from "./managed-provider-file.js";

/** Runner ids + settings paths this run actually REPLACED — i.e. installed
 *  with a successful (non-failed) `postInstall`. Everything downstream keys
 *  off "successful replacement", not mere selection: a selected-but-SKIPPED
 *  runner (malformed settings, missing target) produced no replacement, so
 *  its prior install must survive untouched. */
export function computeReplacementSets(entries: InstallerManifestEntry[]): {
	replacedIds: Set<InstallerManifestEntry["runner"]>;
	newFiles: Set<string>;
} {
	const successfulEntries = entries.filter((entry) => entry.post_install === "ok");
	return {
		replacedIds: new Set(successfulEntries.map((entry) => entry.runner)),
		newFiles: new Set(successfulEntries.map((entry) => entry.settings_path)),
	};
}

/** Remove one prior manifest row's artifact — either a managed-file bridge or
 *  a hook array purge, depending on `artifact_kind`. Returns the count of
 *  hook entries removed (a managed-file removal counts as 1 or 0). */
export function cleanPriorArtifact(entry: InstallerManifestEntry, cwd: string, dryRun: boolean): number {
	if (entry.artifact_kind === "managed-file") {
		return removeManagedProviderFile(entry.settings_path, entry.artifact_sha256, dryRun) === "removed" ? 1 : 0;
	}
	const verdict = makePurgeVerdict(entry.scope, cwd);
	return cleanProjectOwnedHooks(entry.settings_path, verdict, dryRun);
}

/** Stale-install cleanup: a prior install of a runner we just REPLACED may
 *  have written a *different* settings file — e.g. a user→project scope
 *  switch. The in-place purge inside `installSingle` only reached the file
 *  this run rewrote, so clear the old one here. Keyed on SUCCESSFUL
 *  replacements: a selected runner that was SKIPPED produced no replacement,
 *  so its prior install must survive untouched. Returns the settings paths
 *  that had at least one entry removed. */
export function cleanStaleInstalls(
	priorManifest: InstallerManifestEntry[],
	replacedIds: Set<InstallerManifestEntry["runner"]>,
	newFiles: Set<string>,
	cwd: string,
	dryRun: boolean,
): string[] {
	const orphansCleaned: string[] = [];
	for (const prior of priorManifest) {
		if (!replacedIds.has(prior.runner)) continue;
		if (newFiles.has(prior.settings_path)) continue;
		const removed = cleanPriorArtifact(prior, cwd, dryRun);
		if (removed > 0) orphansCleaned.push(prior.settings_path);
	}
	return orphansCleaned;
}

/** Remove a user-scope artifact with no manifest row to anchor ownership. A
 *  managed-file adapter (`fileContent` present) is removed only on an exact
 *  content match — a marker alone does not prove the user hasn't customized
 *  it since. A JSON-fragment adapter falls back to the hook-array purge. */
export function cleanUserScopeArtifact(
	fileContent: string | undefined,
	target: string,
	verdict: ReturnType<typeof makePurgeVerdict>,
	dryRun: boolean,
): number {
	if (fileContent === undefined) return cleanProjectOwnedHooks(target, verdict, dryRun);
	return removeManagedProviderFile(target, managedProviderFileHash(fileContent), dryRun) === "removed" ? 1 : 0;
}

/** Cross-scope stale cleanup: a historical user-scope install may predate the
 *  manifest, or may have been created by a different installer path. If the
 *  current run installs project/local hooks, a matching user-scope hook for
 *  the same project would fire in addition to the project hook — remove it,
 *  sparing other projects' hooks. A skipped or semantically failed
 *  replacement never earns this destructive cleanup step (only runners in
 *  `replacedIds` are touched). Mutates `orphansCleaned` in place so a target
 *  already recorded by `cleanStaleInstalls` is never duplicated. A no-op at
 *  user scope. */
export function cleanCrossScopeArtifacts(
	scope: InstallScope,
	selected: RunnerAdapter[],
	replacedIds: Set<InstallerManifestEntry["runner"]>,
	newFiles: Set<string>,
	binaryAbs: string,
	cwd: string,
	dryRun: boolean,
	orphansCleaned: string[],
): void {
	if (scope === SCOPE_USER) return;
	const verdict = makePurgeVerdict(SCOPE_USER, cwd);
	for (const adapter of selected) {
		if (!replacedIds.has(adapter.id)) continue;
		const userFragment = adapter.renderSettingsFragment(binaryAbs, SCOPE_USER);
		const userTarget = resolveSettingsPath(cwd, userFragment.path);
		if (newFiles.has(userTarget)) continue;
		const removed = cleanUserScopeArtifact(userFragment.fileContent, userTarget, verdict, dryRun);
		if (removed > 0 && !orphansCleaned.includes(userTarget)) {
			orphansCleaned.push(userTarget);
		}
	}
}

/** Non-clobbering manifest split: keep prior entries for every runner this
 *  run did not successfully REPLACE, then add this run's entries. A
 *  first-time postInstall failure (no prior row) keeps its row because its
 *  partial hook needs to remain uninstallable; a FAILED REPLACEMENT of an
 *  existing row is dropped because its target was already restored and the
 *  prior row stays canonical. */
export function buildManifestUpdate(
	priorManifest: InstallerManifestEntry[],
	entries: InstallerManifestEntry[],
	replacedIds: Set<InstallerManifestEntry["runner"]>,
): { retained: InstallerManifestEntry[]; recordableEntries: InstallerManifestEntry[] } {
	const retained = priorManifest.filter((entry) => !replacedIds.has(entry.runner));
	const priorIds = new Set(priorManifest.map((entry) => entry.runner));
	const recordableEntries = entries.filter(
		(entry) => entry.post_install === "ok" || !priorIds.has(entry.runner),
	);
	return { retained, recordableEntries };
}

/** Lift each entry's recorded postInstall failure to the caller-visible list.
 *  `installSingle` records the failure ON the entry; before this existed the
 *  throw was caught, logged to stderr, and dropped — an install whose hooks
 *  never fire was reported to the caller as a success. */
export function collectPostInstallFailures(
	entries: InstallerManifestEntry[],
): Array<{ runner: InstallerManifestEntry["runner"]; reason: string }> {
	return entries
		.filter((e) => e.post_install === "failed")
		.map((e) => ({ runner: e.runner, reason: e.post_install_error ?? "postInstall failed" }));
}
