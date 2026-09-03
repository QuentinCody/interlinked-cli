// ===========================================
// Adapter-multiplexing installer + installer manifest
// ===========================================
// Writes merge-safe hook fragments to each runner's settings file, records
// exactly what was added in `.interlinked/installer-manifest.json`, and
// uninstalls precisely what it installed. See docs/design/free-cli-architecture.md
// §"Installer architecture".
//
// Idempotency contract: every install first purges any prior Interlinked
// registration — legacy `.mjs` *or* adapter — from the arrays it is about to
// write, then appends exactly one canonical entry. Re-running install (or
// running it after the legacy `interlinked enable` path) therefore converges
// to one hook per event per runner instead of stacking duplicates. The shared
// recogniser lives in `../lib/hook-ownership.ts`; the purge cluster itself
// lives in `./installer-purge.ts`. The install path (adapter selection,
// per-adapter install, managed-file installs, post-install side-effects)
// lives in `./installer-install-result.ts` (2026-09-02, line-cap decompose);
// this module re-exports its public surface so it stays the installer's one
// public entry point.

import { isHookEntryInvokingBinary } from "../lib/hook-ownership.js";
import { getAdapter, type InstallerManifestEntry } from "./adapters/index.js";
import { manifestPath } from "./installer-install-result.js";
import { readManifestState, writeManifest } from "./installer-manifest.js";
import { cleanProjectOwnedHooks, makePurgeVerdict } from "./installer-purge.js";
import { removeManagedProviderFile } from "./managed-provider-file.js";
import type { RunnerId } from "./unified-event.js";

// Moved to installer-merge-engine.ts (2026-08-30) so the manifest validator
// can bind stored paths without an import cycle; re-exported for callers.
export { resolveSettingsPath } from "./installer-merge-engine.js";
// `InstallScope` and `ManifestState` are not re-exported: no external
// importer references either type by name (verified 2026-09-02, split
// unit) — only the `readManifest`/`readManifestState` functions and the
// scope *values* they carry are consumed, so re-exporting the bare types
// would be a re-export shim with no reader.
export { readManifest, readManifestState } from "./installer-manifest.js";
export { type InstallResult, installHooks, manifestPath } from "./installer-install-result.js";

/**
 * The events a successful install ACTUALLY registered — the adapter's
 * `nativeEventNames`, never a legacy per-client list (review 2026-08-28 P1:
 * the legacy lists had drifted, so `enable` reported Gemini 8/installed 4 and
 * Cursor 15/installed 18 — success text describing an install that did not
 * happen, while dry-run already derived from the adapter). Empty array on a
 * resolve miss so a caller can fall back explicitly rather than silently.
 */
export function installedEventsFor(runner: RunnerId): string[] {
	return [...(getAdapter(runner)?.nativeEventNames ?? [])];
}

// -----------------------------------------------------------------------------
// Uninstall
// -----------------------------------------------------------------------------

interface UninstallOptions {
	cwd: string;
	/** Subset of runners to remove; empty = all. */
	runners?: RunnerId[];
	dryRun?: boolean;
}

interface UninstallResult {
	removed: InstallerManifestEntry[];
	remaining: InstallerManifestEntry[];
	manifest_path: string;
}

export function uninstallHooks(opts: UninstallOptions): UninstallResult {
	const mfPath = manifestPath(opts.cwd);
	// A CORRUPT manifest REFUSES the uninstall and writes NOTHING (review
	// 2026-08-30: the permissive reader turned corrupt bytes into an empty
	// manifest, then wrote `{entries: []}` over the evidence).
	const state = readManifestState(mfPath);
	if (state.kind === "corrupt") {
		throw new Error(`installer manifest is corrupt (${state.reason}) — fix or remove ${mfPath} before uninstalling`);
	}
	const manifest = state.kind === "valid" ? state.entries : [];
	const filter = new Set(opts.runners ?? []);
	const removed: InstallerManifestEntry[] = [];
	const remaining: InstallerManifestEntry[] = [];

	for (const entry of manifest) {
		const shouldRemove = filter.size === 0 || filter.has(entry.runner);
		if (!shouldRemove) {
			remaining.push(entry);
			continue;
		}
		if (!opts.dryRun && !removeEntry(entry, opts.cwd)) {
			remaining.push(entry);
			continue;
		}
		removed.push(entry);
	}

	if (!opts.dryRun) writeManifest(mfPath, remaining);

	return { removed, remaining, manifest_path: mfPath };
}

/** Remove this runner's hooks by OWNED-ENTRY RECOGNITION, never by the
 *  stored array indexes (review 2026-08-30, release-blocking: a user hook
 *  prepended after install shifted every index, so positional removal
 *  deleted the USER's hook and left ours behind). The purge machinery is
 *  the ONE recognizer-based cleaner; its scope verdict spares foreign
 *  projects' hooks in shared user-scope files. An entry that INVOKES this
 *  manifest row's recorded binary (executable/script position, via
 *  isHookEntryInvokingBinary — never a substring: a user hook that merely
 *  ECHOED the recorded path was deleted by the old
 *  JSON.stringify(...).includes fallback) is also owned. */
function removeEntry(entry: InstallerManifestEntry, cwd: string): boolean {
	if (entry.artifact_kind === "managed-file") {
		const outcome = removeManagedProviderFile(entry.settings_path, entry.artifact_sha256, false);
		return outcome === "removed" || outcome === "missing";
	}
	const base = makePurgeVerdict(entry.scope, cwd);
	const verdict = (candidate: unknown): ReturnType<typeof base> => {
		const baseVerdict = base(candidate);
		if (baseVerdict !== "keep") return baseVerdict;
		return isHookEntryInvokingBinary(candidate, entry.binary_path) ? "remove" : "keep";
	};
	cleanProjectOwnedHooks(entry.settings_path, verdict, false);
	return true;
}

// cleanPriorArtifact / cleanUserScopeArtifact moved to installer-reconcile.ts
// (2026-09-02, line-cap decompose) alongside their only callers.
// Adapter selection (selectAdapters) moved to installer-install-result.ts
// (2026-09-02, line-cap decompose) alongside its only caller, installHooks.
