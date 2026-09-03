// ===========================================
// Installer — install path (adapter multiplexing + manifest write)
// ===========================================
// Split out of installer.ts (2026-09-02, line-cap decompose): everything
// `installHooks` needs — adapter selection, per-adapter install, managed-file
// installs, and post-install side-effects. Uninstall stays in installer.ts,
// which re-exports `installHooks` / `manifestPath` / `InstallResult` so it
// remains the installer's one public entry point. See
// docs/design/free-cli-architecture.md §"Installer architecture".

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	buildAllAdapters,
	getAdapter,
	type InstallerManifestEntry,
	type RunnerAdapter,
} from "./adapters/index.js";
import {
	ensureDir,
	mergeSettings,
	readJson,
	restoreTextFile,
	resolveSettingsPath,
	snapshotTextFile,
	writeAtomic,
	writeTextAtomic,
} from "./installer-merge-engine.js";
import {
	type InstallScope,
	makePurgeVerdict,
	type PurgeReport,
	purgePriorEntries,
	SCOPE_USER,
} from "./installer-purge.js";
import { MANIFEST_SCHEMA_VERSION, readManifestState, writeManifest } from "./installer-manifest.js";
import {
	buildManifestUpdate,
	cleanCrossScopeArtifacts,
	cleanStaleInstalls,
	collectPostInstallFailures,
	computeReplacementSets,
} from "./installer-reconcile.js";
import { isManagedProviderFile, managedProviderFileHash, removeManagedProviderFile } from "./managed-provider-file.js";
import type { RunnerId } from "./unified-event.js";

const SCOPE_PROJECT = "project" as const;
const MANIFEST_FILENAME = "installer-manifest.json";

interface InstallOptions {
	/** Repo root (used for project/local scope paths). */
	cwd: string;
	/** Absolute path to the hook binary that runners should invoke. */
	binaryPath: string;
	/** Runners to install. Empty = install to every known runner the
	 *  adapter's `detectFromEnv` recognizes in the current environment. */
	runners: RunnerId[];
	/** Install scope. Defaults to "project". */
	scope?: InstallScope;
	/** When true, do not write files; return what *would* be changed. */
	dryRun?: boolean;
}

/**
 * The events a successful install ACTUALLY registered — the adapter's
 * `nativeEventNames`, never a legacy per-client list (review 2026-08-28 P1:
 * the legacy lists had drifted, so `enable` reported Gemini 8/installed 4 and
 * Cursor 15/installed 18 — success text describing an install that did not
 * happen, while dry-run already derived from the adapter). Empty array on a
 * resolve miss so a caller can fall back explicitly rather than silently.
 */
export interface InstallResult {
	/** Did the whole install complete? False when any adapter's required
	 *  `postInstall` threw — the JSON fragment landed but the runner will not
	 *  honor it, so reporting success would describe an inert installation. */
	ok: boolean;
	/** One row per adapter whose `postInstall` failed, with the reason. Empty
	 *  when `ok` is true. */
	post_install_failures: Array<{ runner: RunnerId; reason: string }>;
	/** Entries produced by this attempt. A failed replacement remains visible
	 * here even when the durable manifest retains the prior working entry. */
	entries: InstallerManifestEntry[];
	skipped: Array<{ runner: RunnerId; reason: string }>;
	manifest_path: string;
	/** Count of prior Interlinked entries removed before insert (idempotency).
	 *  Non-zero means a re-run, a legacy `.mjs` install, or a stacked
	 *  duplicate was cleaned up. */
	purged: number;
	/** Count of Interlinked entries left in place because they belong to
	 *  *another* project — only ever non-zero at user scope. */
	foreign: number;
	/** Settings files (other than the ones this run wrote) that held a stale
	 *  prior install of a reinstalled runner and were cleaned. */
	orphans_cleaned: string[];
}

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

export function manifestPath(cwd: string): string {
	return join(cwd, ".interlinked", MANIFEST_FILENAME);
}

interface SelectedInstallOutcome {
	entry?: InstallerManifestEntry;
	skipped?: InstallResult["skipped"][number];
	purged: number;
	foreign: number;
}

function installSelectedAdapter(
	adapter: RunnerAdapter,
	input: {
		binaryAbs: string;
		scope: InstallScope;
		cwd: string;
		installedAt: string;
		dryRun: boolean;
		priorManifest: InstallerManifestEntry[];
	},
): SelectedInstallOutcome {
	const priorConflict = priorManagedArtifactConflict(input.priorManifest, adapter.id);
	if (priorConflict !== null) {
		return { skipped: { runner: adapter.id, reason: priorConflict }, purged: 0, foreign: 0 };
	}
	const prior = input.priorManifest.find((entry) => entry.runner === adapter.id);
	const target = resolveSettingsPath(
		input.cwd,
		adapter.renderSettingsFragment(input.binaryAbs, input.scope).path,
	);
	const before = prior === undefined || input.dryRun ? null : snapshotTextFile(target);
	const installed = installSingle(
		adapter,
		input.binaryAbs,
		input.scope,
		input.cwd,
		input.installedAt,
		input.dryRun,
	);
	if (!installed.ok) {
		return { skipped: { runner: adapter.id, reason: installed.reason }, purged: 0, foreign: 0 };
	}
	if (installed.entry.post_install !== "failed" || prior === undefined) {
		return { entry: installed.entry, purged: installed.purged, foreign: installed.foreign };
	}
	if (!input.dryRun) {
		if (before === null) throw new Error(`cannot restore prior ${adapter.id} settings at ${target}`);
		restoreTextFile(target, before);
	}
	return { entry: installed.entry, purged: 0, foreign: 0 };
}

// -----------------------------------------------------------------------------
// Install
// -----------------------------------------------------------------------------

export function installHooks(opts: InstallOptions): InstallResult {
	const scope: InstallScope = opts.scope ?? SCOPE_PROJECT;
	const dryRun = opts.dryRun ?? false;
	const adapters = buildAllAdapters();
	const selected = selectAdapters(adapters, opts.runners);
	const entries: InstallerManifestEntry[] = [];
	const skipped: InstallResult["skipped"] = [];
	const binaryAbs = resolve(opts.binaryPath);
	const nowIso = new Date().toISOString();

	const mfPath = manifestPath(opts.cwd);
	// Snapshot the manifest before this run rewrites it. Used to (a) retain
	// entries for runners this run does not touch and (b) clean a prior
	// install of a reinstalled runner that landed in a *different* file.
	// A CORRUPT manifest REFUSES the install outright: proceeding would
	// overwrite the evidence and orphan whatever the damaged rows recorded.
	const priorState = readManifestState(mfPath);
	if (priorState.kind === "corrupt") {
		throw new Error(`installer manifest is corrupt (${priorState.reason}) — fix or remove ${mfPath} before installing`);
	}
	const priorManifest = priorState.kind === "valid" ? priorState.entries : [];

	let purged = 0;
	let foreign = 0;
	for (const adapter of selected) {
		const outcome = installSelectedAdapter(adapter, {
			binaryAbs,
			scope,
			cwd: opts.cwd,
			installedAt: nowIso,
			dryRun,
			priorManifest,
		});
		if (outcome.entry !== undefined) entries.push(outcome.entry);
		if (outcome.skipped !== undefined) skipped.push(outcome.skipped);
		purged += outcome.purged;
		foreign += outcome.foreign;
	}

	// Stale-install cleanup, cross-scope cleanup, manifest reconciliation, and
	// post-install-failure collection are each extracted below (line-cap /
	// cyclomatic-cap decompose) — see their doc comments for the "why".
	const { replacedIds, newFiles } = computeReplacementSets(entries);
	const orphansCleaned = cleanStaleInstalls(priorManifest, replacedIds, newFiles, opts.cwd, dryRun);
	cleanCrossScopeArtifacts(scope, selected, replacedIds, newFiles, binaryAbs, opts.cwd, dryRun, orphansCleaned);

	const { retained, recordableEntries } = buildManifestUpdate(priorManifest, entries, replacedIds);
	if (!dryRun) writeManifest(mfPath, [...retained, ...recordableEntries]);

	const postInstallFailures = collectPostInstallFailures(entries);

	return {
		ok: postInstallFailures.length === 0,
		post_install_failures: postInstallFailures,
		entries,
		skipped,
		manifest_path: mfPath,
		purged,
		foreign,
		orphans_cleaned: orphansCleaned,
	};
}

function priorManagedArtifactConflict(
	manifest: InstallerManifestEntry[],
	runner: RunnerId,
): string | null {
	const prior = manifest.find((entry) => entry.runner === runner);
	if (prior?.artifact_kind !== "managed-file") return null;
	const outcome = removeManagedProviderFile(prior.settings_path, prior.artifact_sha256, true);
	if (outcome === "modified") {
		return `managed provider file changed after installation; preserving ${prior.settings_path}`;
	}
	if (outcome === "foreign") {
		return `managed provider path is now user-owned; preserving ${prior.settings_path}`;
	}
	return null;
}

interface InstallSingleSuccess {
	ok: true;
	entry: InstallerManifestEntry;
	/** Prior Interlinked entries removed from this runner's file before insert. */
	purged: number;
	/** Foreign (other-project) Interlinked entries left in place. */
	foreign: number;
}
interface InstallSingleFailure {
	ok: false;
	reason: string;
}

function installSingle(
	adapter: RunnerAdapter,
	binaryAbs: string,
	scope: InstallScope,
	cwd: string,
	installedAt: string,
	dryRun: boolean,
): InstallSingleSuccess | InstallSingleFailure {
	const fragment = adapter.renderSettingsFragment(binaryAbs, scope);
	const target = resolveSettingsPath(cwd, fragment.path);
	if (fragment.fileContent !== undefined) {
		return installManagedFile(adapter, binaryAbs, scope, cwd, installedAt, dryRun, target, fragment.fileContent);
	}
	const existing = readJson(target);
	if (existing === null && existsSync(target)) {
		return { ok: false, reason: `malformed JSON at ${target}` };
	}
	const base = existing ?? {};

	// Idempotency: drop any prior Interlinked registration (legacy `.mjs` or
	// adapter) from the arrays this fragment writes, *before* the append-merge
	// below — so a re-run converges to exactly one canonical entry per event
	// rather than stacking duplicates. Scope-aware: a shared user-scope file
	// keeps other repos' Interlinked hooks (tallied as `foreign`). Events the
	// fragment no longer declares are swept too, so a de-registered event does
	// not keep its stale entry forever.
	const report: PurgeReport = { removed: 0, foreign: 0 };
	purgePriorEntries(base, fragment.fragment, makePurgeVerdict(scope, cwd), report);

	const addedPaths: string[] = [];
	const merged = mergeSettings(base, fragment.fragment, fragment.mergeStrategy, "", addedPaths);

	if (!dryRun) {
		ensureDir(dirname(target));
		writeAtomic(target, merged);
	}

	// Adapter-specific post-install side-effects — e.g. Codex's
	// `[features] hooks = true` feature flag in `.codex/config.toml`
	// (legacy `codex_hooks` is auto-migrated by the writer). Adapters
	// that don't implement postInstall are no-ops here.
	//
	// A throw here is NOT cosmetic. An adapter declares postInstall precisely
	// because the JSON fragment alone leaves the install inert — Codex ignores
	// its hooks.json until the feature flag is set. This used to write one
	// stderr line and return `ok: true` anyway, so an installation that fires
	// no hooks was recorded as a success. The failure is now carried on the
	// entry and lifts to `InstallResult.ok`. A first-time failure remains in the
	// manifest so uninstall can remove its partial hook. When a prior working
	// install exists, the caller restores this target and retains the prior row.
	const postInstallError = runPostInstall(adapter, scope, cwd, dryRun);

	const entry: InstallerManifestEntry = {
		runner: adapter.id,
		scope,
		settings_path: target,
		added_paths: addedPaths,
		binary_path: binaryAbs,
		installed_at: installedAt,
		post_install: postInstallError === null ? "ok" : "failed",
		schema_version: MANIFEST_SCHEMA_VERSION,
	};
	if (postInstallError !== null) entry.post_install_error = postInstallError;

	return { ok: true, entry, purged: report.removed, foreign: report.foreign };
}

/** Install an auto-loaded provider plugin/extension without ever treating it
 * as JSON or overwriting a user-owned file at the managed path. */
function installManagedFile(
	adapter: RunnerAdapter,
	binaryAbs: string,
	scope: InstallScope,
	cwd: string,
	installedAt: string,
	dryRun: boolean,
	target: string,
	content: string,
): InstallSingleSuccess | InstallSingleFailure {
	let purged = 0;
	if (existsSync(target)) {
		let existing: string;
		try {
			existing = readFileSync(target, "utf-8");
		} catch (readError) {
			return { ok: false, reason: `cannot read managed provider file ${target}: ${String(readError)}` };
		}
		if (existing !== content && !isManagedProviderFile(existing)) {
			return { ok: false, reason: `refusing to overwrite non-Interlinked provider file at ${target}` };
		}
		if (existing !== content) {
			const prior = readManifestState(manifestPath(cwd));
			const owned =
				prior.kind === "valid" &&
				prior.entries.some(
					(entry) =>
						entry.runner === adapter.id &&
						entry.settings_path === target &&
						entry.artifact_kind === "managed-file" &&
						entry.artifact_sha256 === managedProviderFileHash(existing),
				);
			if (!owned) {
				return {
					ok: false,
					reason: `managed provider file differs without matching manifest ownership; preserving ${target}`,
				};
			}
			purged = 1;
		}
	}
	if (!dryRun) writeTextAtomic(target, content);
	const postInstallError = runPostInstall(adapter, scope, cwd, dryRun);
	const entry: InstallerManifestEntry = {
		runner: adapter.id,
		scope,
		settings_path: target,
		added_paths: ["$file"],
		binary_path: binaryAbs,
		installed_at: installedAt,
		post_install: postInstallError === null ? "ok" : "failed",
		schema_version: MANIFEST_SCHEMA_VERSION,
		artifact_kind: "managed-file",
		artifact_sha256: managedProviderFileHash(content),
	};
	if (postInstallError !== null) entry.post_install_error = postInstallError;
	return { ok: true, entry, purged, foreign: 0 };
}

/** Run the adapter's post-install side-effects. Returns null on success (or
 *  when the adapter declares none), else the failure reason. */
function runPostInstall(
	adapter: RunnerAdapter,
	scope: InstallScope,
	cwd: string,
	dryRun: boolean,
): string | null {
	if (!adapter.postInstall) return null;
	const postInstallBase = scope === SCOPE_USER ? resolveSettingsPath(cwd, "~/") : cwd;
	try {
		adapter.postInstall({ cwd: postInstallBase, scope, dryRun });
		return null;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[interlinked] ${adapter.id} postInstall failed: ${reason}\n`);
		return reason;
	}
}

// -----------------------------------------------------------------------------
// Adapter selection
// -----------------------------------------------------------------------------

function selectAdapters(all: RunnerAdapter[], requested: RunnerId[]): RunnerAdapter[] {
	if (requested.length === 0) return all;
	const out: RunnerAdapter[] = [];
	for (const id of new Set(requested)) {
		const a = getAdapter(id, all);
		if (a) out.push(a);
	}
	return out;
}
