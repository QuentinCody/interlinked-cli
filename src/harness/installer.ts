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
// lives in `./installer-purge.ts`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isHookEntryInvokingBinary } from "../lib/hook-ownership.js";
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
	cleanProjectOwnedHooks,
	type InstallScope,
	makePurgeVerdict,
	type PurgeReport,
	purgePriorEntries,
	SCOPE_USER,
} from "./installer-purge.js";
import { MANIFEST_SCHEMA_VERSION, readManifestState, writeManifest } from "./installer-manifest.js";
import {
	isManagedProviderFile,
	managedProviderFileHash,
	removeManagedProviderFile,
} from "./managed-provider-file.js";
import type { RunnerId } from "./unified-event.js";

export { mergeSettings, removeJsonPath } from "./installer-merge-engine.js";
// Re-exported so this module stays the one public entry point for the
// installer, even though the scope identity is declared alongside the
// scope-aware purge verdict.
export type { InstallScope };

// Scope identities as named constants — `as const` keeps their literal types
// so equality checks narrow correctly (e.g. in `coerceManifestEntry`).
// `SCOPE_USER` is imported from `./installer-purge.ts` rather than declared
// here: the purge verdict keys off it, and re-importing it from this module
// would make the two files cyclic.
const SCOPE_PROJECT = "project" as const;

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
export function installedEventsFor(runner: RunnerId): string[] {
	return [...(getAdapter(runner)?.nativeEventNames ?? [])];
}

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

const MANIFEST_FILENAME = "installer-manifest.json";

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

// Moved to installer-merge-engine.ts (2026-08-30) so the manifest validator
// can bind stored paths without an import cycle; re-exported for callers.
export { resolveSettingsPath } from "./installer-merge-engine.js";

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

	// Stale-install cleanup: a prior install of a runner we just REPLACED may
	// have written a *different* settings file — e.g. a user→project scope
	// switch. The in-place purge in `installSingle` only reached the file this
	// run rewrote, so clear the old one here. Keyed on SUCCESSFUL replacements, not
	// merely selected ones (review 2026-08-30): a selected runner that was
	// SKIPPED (malformed settings, missing target) produced no replacement, so
	// its prior install must survive untouched — cleaning it while dropping its
	// manifest entry silently destroyed working installs.
	const successfulEntries = entries.filter((entry) => entry.post_install === "ok");
	const replacedIds = new Set(successfulEntries.map((entry) => entry.runner));
	const newFiles = new Set(successfulEntries.map((entry) => entry.settings_path));
	const orphansCleaned: string[] = [];
	for (const prior of priorManifest) {
		if (!replacedIds.has(prior.runner)) continue;
		if (newFiles.has(prior.settings_path)) continue;
		const removed = cleanPriorArtifact(prior, opts.cwd, dryRun);
		if (removed > 0) orphansCleaned.push(prior.settings_path);
	}

	// Cross-scope stale cleanup: a historical user-scope install may predate
	// the manifest, or may have been created by a different installer path. If
	// the current run installs project/local hooks, a matching user-scope hook
	// for the same project will be merged by runners like Claude Code and fire
	// in addition to the project hook. Remove this project's user-scope entries
	// from the same runner settings file, sparing other projects' hooks. A
	// skipped or semantically failed replacement never earns this destructive
	// cleanup step.
	if (scope !== SCOPE_USER) {
		const verdict = makePurgeVerdict(SCOPE_USER, opts.cwd);
		for (const adapter of selected) {
			if (!replacedIds.has(adapter.id)) continue;
			const userFragment = adapter.renderSettingsFragment(binaryAbs, SCOPE_USER);
			const userTarget = resolveSettingsPath(opts.cwd, userFragment.path);
			if (newFiles.has(userTarget)) continue;
			const removed = cleanUserScopeArtifact(userFragment.fileContent, userTarget, verdict, dryRun);
			if (removed > 0 && !orphansCleaned.includes(userTarget)) {
				orphansCleaned.push(userTarget);
			}
		}
	}

	// Non-clobbering manifest: keep prior entries for every runner this run
	// did not successfully REPLACE, then add this run's entries. Filtering on
	// selection instead of replacement (pre-2026-08-30) meant a selected-but-
	// SKIPPED runner lost its manifest entry while its hooks stayed installed —
	// unfindable by uninstall and invisible to refresh.
	const retained = priorManifest.filter((entry) => !replacedIds.has(entry.runner));
	const priorIds = new Set(priorManifest.map((entry) => entry.runner));
	// A first-time postInstall failure keeps its row because its partial hook
	// needs to remain uninstallable. A failed replacement has already restored
	// its attempted target, so the prior one-row ownership record stays canonical.
	const recordableEntries = entries.filter(
		(entry) => entry.post_install === "ok" || !priorIds.has(entry.runner),
	);
	if (!dryRun) writeManifest(mfPath, [...retained, ...recordableEntries]);

	// A postInstall failure is recorded on the attempt entry by `installSingle`; lift
	// it here so the CALLER cannot miss it. Before this, the throw was caught,
	// logged to stderr and dropped — an install whose hooks never fire was
	// reported as a success and written to the manifest as one.
	const postInstallFailures = entries
		.filter((e) => e.post_install === "failed")
		.map((e) => ({ runner: e.runner, reason: e.post_install_error ?? "postInstall failed" }));

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

function cleanPriorArtifact(entry: InstallerManifestEntry, cwd: string, dryRun: boolean): number {
	if (entry.artifact_kind === "managed-file") {
		return removeManagedProviderFile(entry.settings_path, entry.artifact_sha256, dryRun) === "removed" ? 1 : 0;
	}
	const verdict = makePurgeVerdict(entry.scope, cwd);
	return cleanProjectOwnedHooks(entry.settings_path, verdict, dryRun);
}

function cleanUserScopeArtifact(
	fileContent: string | undefined,
	target: string,
	verdict: ReturnType<typeof makePurgeVerdict>,
	dryRun: boolean,
): number {
	if (fileContent === undefined) return cleanProjectOwnedHooks(target, verdict, dryRun);
	// A marker proves that Interlinked created the file at some point, but it
	// does not prove that the user has not customized it since. Historical
	// user-scope bridges may have no manifest row, so require an exact match to
	// the source this adapter would render before cross-scope cleanup removes
	// them. A differing managed file is deliberately preserved.
	return removeManagedProviderFile(
		target,
		managedProviderFileHash(fileContent),
		dryRun,
	) === "removed"
		? 1
		: 0;
}

// -----------------------------------------------------------------------------
// Manifest IO — extracted to installer-manifest.ts (2026-08-30, line cap);
// re-exported so this module stays the installer's one public entry point.
// -----------------------------------------------------------------------------

export { type ManifestState, readManifest, readManifestState } from "./installer-manifest.js";

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
