// ===========================================
// interlinked install-hooks --refresh --preserve-mode
// ===========================================
// The sanctioned repair path for STALE INSTALLED HOOKS. A plain
// `interlinked enable` (or a plain `install-hooks`, whose --mode flag
// defaults to "balanced") also rewrites the enforcement mode and other
// config — which is why stale installs sat unrepaired for weeks. This path
// re-renders ONLY the Interlinked-owned hook entries already recorded in
// installer-manifest.json, at each entry's recorded scope, and never touches
// mode, guard rules, or cloud config.
//
// Contract (reviews 2026-08-29/30):
//  - Targets only runners present in the manifest (an explicit --runner list
//    is intersected; a runner never installed is skipped, not installed).
//  - A CORRUPT manifest refuses with the bytes preserved — it is never
//    flattened into "nothing installed".
//  - A targeted runner that the installer SKIPPED is a refresh FAILURE, not
//    a footnote: refresh must replace every target or roll back.
//  - Rollback ON HANDLED FAILURE (an OS crash mid-write cannot run the
//    in-memory restore): every file the install can touch — recorded and
//    current-scope settings, the user-scope files the installer sweeps,
//    Codex's config.toml, the manifest — is snapshotted first and restored.
//  - Idempotent: a second run leaves every settings file byte-identical
//    (reported as `unchanged`).
//  - Final-state verification is SEMANTIC (installed-hooks-verify.ts): every
//    expected event exactly once, no deregistered events, current binary,
//    Codex feature flag — never a substring search.

import {
	chmodSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { getAdapter } from "../harness/adapters/index.js";
import {
	type HookVerification,
	verifyInstalledRunner,
} from "../harness/installed-hooks-verify.js";
import {
	type InstallResult,
	installHooks,
	manifestPath,
	readManifest,
	readManifestState,
	resolveSettingsPath,
} from "../harness/installer.js";
import type { RunnerId } from "../harness/unified-event.js";

interface RefreshHooksArgs {
	cwd: string;
	binaryPath: string;
	/** Optional narrowing; intersected with the manifest's runners. */
	runners?: RunnerId[];
	dryRun?: boolean;
}

interface RefreshDeps {
	install?: typeof installHooks;
}

type RefreshVerification = HookVerification;

/** Wider than InstallResult's failure rows: a thrown install is reported
 *  under the synthetic "refresh" runner name. */
interface RefreshFailure {
	runner: string;
	reason: string;
}

interface RefreshOutcome {
	ok: boolean;
	dry_run: boolean;
	refreshed: string[];
	skipped: Array<{ runner: string; reason: string }>;
	post_install_failures: RefreshFailure[];
	/** True when a failure occurred and every snapshot was restored. */
	rolled_back: boolean;
	rollback_error?: string;
	/** Settings files byte-identical after the run — the idempotency signal. */
	unchanged: boolean;
	verifications: RefreshVerification[];
}

/** null = file absent (rollback must delete a file the run created).
 *  Bytes AND file mode are preserved; restore is temp-file + rename so a
 *  restore interrupted mid-write never leaves a torn file. This is rollback
 *  on HANDLED failure — an OS crash cannot execute the in-memory restore. */
interface SnapshotEntry {
	content: string;
	mode: number;
}
type Snapshot = Map<string, SnapshotEntry | null>;

function snapshotFiles(paths: Iterable<string>): Snapshot {
	const snap: Snapshot = new Map();
	for (const p of paths) {
		if (!existsSync(p)) {
			snap.set(p, null);
			continue;
		}
		snap.set(p, { content: readFileSync(p, "utf-8"), mode: statSync(p).mode });
	}
	return snap;
}

function restoreOne(path: string, entry: SnapshotEntry | null): void {
	if (entry === null) {
		if (existsSync(path)) unlinkSync(path);
		return;
	}
	const tmp = `${path}.refresh-restore.tmp`;
	writeFileSync(tmp, entry.content);
	chmodSync(tmp, entry.mode);
	renameSync(tmp, path);
}

function restoreSnapshot(snap: Snapshot): string | undefined {
	try {
		for (const [p, entry] of snap) restoreOne(p, entry);
		return undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

type ManifestEntries = ReturnType<typeof readManifest>;

/** The files this refresh may rewrite: each targeted manifest entry's
 *  recorded path, the path the adapter would render TODAY for that entry's
 *  recorded scope (they differ after an adapter path change), the USER-scope
 *  file the installer's cross-scope sweep can clean, and any post-install
 *  side files (Codex's config.toml) — review 2026-08-30: the rollback claim
 *  was false while postInstall/user-scope writes sat outside the snapshot. */
function candidatePaths(cwd: string, binaryAbs: string, targets: ManifestEntries): Set<string> {
	const paths = new Set<string>();
	for (const entry of targets) {
		paths.add(entry.settings_path);
		const adapter = getAdapter(entry.runner);
		if (adapter === null) continue;
		// The installer's OWN resolver (review 2026-08-30: `resolve(cwd, "~/…")`
		// put the user-scope watch under cwd while the installer wrote under
		// $HOME — a failed refresh then "rolled back" the wrong file and the
		// user's real settings stayed damaged).
		paths.add(resolveSettingsPath(cwd, adapter.renderSettingsFragment(binaryAbs, entry.scope).path));
		paths.add(resolveSettingsPath(cwd, adapter.renderSettingsFragment(binaryAbs, "user").path));
		if (entry.runner === "codex") {
			paths.add(resolveSettingsPath(cwd, ".codex/config.toml"));
			paths.add(resolveSettingsPath(cwd, "~/.codex/config.toml"));
		}
	}
	return paths;
}

function settingsUnchanged(before: Snapshot): boolean {
	for (const [p, prior] of before) {
		const now = existsSync(p) ? readFileSync(p, "utf-8") : null;
		if (now !== (prior === null ? null : prior.content)) return false;
	}
	return true;
}

/** Semantic final-state verification, shared with doctor — see
 *  installed-hooks-verify.ts for what "verified" proves. */
function verifyFinalState(
	cwd: string,
	entries: InstallResult["entries"],
	binaryAbs: string,
): RefreshVerification[] {
	return entries.map((e: InstallResult["entries"][number]) =>
		verifyInstalledRunner(cwd, { ...e, binary_path: binaryAbs }, binaryAbs),
	);
}

/** One scope-group install per recorded scope; installHooks takes a single
 *  scope per call. */
function groupByScope(targets: ManifestEntries): Map<string, RunnerId[]> {
	const groups = new Map<string, RunnerId[]>();
	for (const entry of targets) {
		const list = groups.get(entry.scope) ?? [];
		list.push(entry.runner);
		groups.set(entry.scope, list);
	}
	return groups;
}

/** Skip rows for requested runners the manifest has never seen. */
function notInstalledSkips(
	requested: ReadonlySet<RunnerId> | null,
	manifest: ManifestEntries,
): RefreshOutcome["skipped"] {
	if (requested === null) return [];
	const installedIds = new Set(manifest.map((e) => e.runner));
	return [...requested]
		.filter((r) => !installedIds.has(r))
		.map((r) => ({
			runner: r,
			reason: "not in the installer manifest — refresh only re-renders existing installs",
		}));
}

interface InstallRunOutcome {
	entries: InstallResult["entries"];
	failures: RefreshFailure[];
	skipped: RefreshOutcome["skipped"];
	failed: boolean;
}

function runScopedInstalls(
	args: RefreshHooksArgs,
	binaryAbs: string,
	targets: ManifestEntries,
	install: typeof installHooks,
): InstallRunOutcome {
	const out: InstallRunOutcome = { entries: [], failures: [], skipped: [], failed: false };
	try {
		for (const [scope, runners] of groupByScope(targets)) {
			const result = install({
				cwd: args.cwd,
				binaryPath: binaryAbs,
				runners,
				// SAFETY: scopes in the manifest were written by installHooks, whose
				// InstallScope union is the source of these strings.
				scope: scope as never,
				dryRun: args.dryRun ?? false,
			});
			out.entries.push(...result.entries);
			out.failures.push(...result.post_install_failures);
			out.skipped.push(...result.skipped);
			if (!result.ok) out.failed = true;
		}
	} catch (err) {
		out.failed = true;
		out.failures.push({
			runner: "refresh",
			reason: err instanceof Error ? err.message : String(err),
		});
	}
	return out;
}

/** Human/JSON reporter for the refresh outcome; exits non-zero on failure or
 *  a failed final-state verification (a refresh that did not land is a
 *  failure, not a footnote). */
export function reportRefresh(outcome: RefreshOutcome, json: boolean): void {
	const unverified = outcome.verifications.filter((v) => !v.verified);
	if (!outcome.ok || unverified.length > 0) process.exitCode = 1;
	if (json) {
		process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
		return;
	}
	const verb = outcome.dry_run ? "would refresh" : "refreshed";
	process.stdout.write(
		`[interlinked] ${verb} ${outcome.refreshed.length} installed runner(s)` +
			`${outcome.unchanged ? " (already current — no file changed)" : ""}\n`,
	);
	for (const v of outcome.verifications) {
		process.stdout.write(
			`  ${v.runner.padEnd(14)} → ${v.settings_path} ${v.verified ? "verified" : "NOT VERIFIED"}\n`,
		);
	}
	for (const s of outcome.skipped) {
		process.stdout.write(`  ${s.runner.padEnd(14)} skipped: ${s.reason}\n`);
	}
	for (const f of outcome.post_install_failures) {
		process.stdout.write(`  ${f.runner.padEnd(14)} FAILED: ${f.reason}\n`);
	}
	if (outcome.rolled_back) {
		process.stdout.write("  all settings files and the manifest were rolled back\n");
	}
	if (outcome.rollback_error !== undefined) {
		process.stdout.write(`  ROLLBACK INCOMPLETE: ${outcome.rollback_error}\n`);
	}
	process.stdout.write("mode: preserved (refresh never writes enforcement mode)\n");
}

export function refreshInstalledHooks(
	args: RefreshHooksArgs,
	deps: RefreshDeps = {},
): RefreshOutcome {
	const install = deps.install ?? installHooks;
	const dryRun = args.dryRun ?? false;
	const binaryAbs = resolve(args.binaryPath);
	const mfPath = manifestPath(args.cwd);
	const manifestState = readManifestState(mfPath);
	if (manifestState.kind === "corrupt") {
		// Refuse with the bytes preserved: corrupt is NOT "nothing installed".
		return {
			ok: false,
			dry_run: dryRun,
			refreshed: [],
			skipped: [],
			post_install_failures: [
				{
					runner: "refresh",
					reason: `installer manifest is corrupt (${manifestState.reason}) — restore a trusted backup or repair ${mfPath} to the valid schema; deleting it loses the ownership record`,
				},
			],
			rolled_back: false,
			unchanged: true,
			verifications: [],
		};
	}
	if (manifestState.kind === "missing") {
		return {
			ok: false,
			dry_run: dryRun,
			refreshed: [],
			skipped: [],
			post_install_failures: [
				{
					runner: "refresh",
					reason: `installer manifest is missing at ${mfPath} — restore or repair the ownership record; refresh cannot infer which hooks it owns`,
				},
			],
			rolled_back: false,
			unchanged: true,
			verifications: [],
		};
	}
	const manifest = manifestState.entries;

	const requested =
		args.runners !== undefined && args.runners.length > 0 ? new Set(args.runners) : null;
	const targets = manifest.filter((e) => requested === null || requested.has(e.runner));
	const skipped = notInstalledSkips(requested, manifest);
	if (targets.length === 0) {
		return {
			ok: true,
			dry_run: dryRun,
			refreshed: [],
			skipped,
			post_install_failures: [],
			rolled_back: false,
			unchanged: true,
			verifications: [],
		};
	}

	const watched = candidatePaths(args.cwd, binaryAbs, targets);
	watched.add(mfPath);
	const before = snapshotFiles(watched);

	const run = runScopedInstalls(args, binaryAbs, targets, install);
	run.skipped.push(...skipped);

	// Every TARGETED runner must have been replaced; an installer skip
	// (malformed settings, missing file) is a refresh FAILURE that rolls back
	// (review 2026-08-30 — a skip used to erase the manifest entry and report
	// ok:true).
	const replaced = new Set(run.entries.map((entry: InstallResult["entries"][number]) => entry.runner));
	for (const target of targets) {
		if (!replaced.has(target.runner)) {
			run.failed = true;
			run.failures.push({
				runner: target.runner,
				reason: "targeted runner was not replaced — see skipped for the installer's reason",
			});
		}
	}

	if (run.failed && !dryRun) {
		const rollbackError = restoreSnapshot(before);
		return {
			ok: false,
			dry_run: dryRun,
			refreshed: [],
			skipped: run.skipped,
			post_install_failures: run.failures,
			rolled_back: rollbackError === undefined,
			...(rollbackError !== undefined ? { rollback_error: rollbackError } : {}),
			unchanged: settingsUnchanged(before),
			verifications: [],
		};
	}

	// Verification is part of SUCCESS (review 2026-08-30: a run that installed
	// but failed verification returned ok:true and left the damage in place).
	// Any unverified runner restores the whole snapshot and fails.
	const verifications = dryRun ? [] : verifyFinalState(args.cwd, run.entries, binaryAbs);
	const unverified = verifications.filter((v) => !v.verified);
	if (unverified.length > 0) {
		const rollbackError = restoreSnapshot(before);
		return {
			ok: false,
			dry_run: dryRun,
			refreshed: [],
			skipped: run.skipped,
			post_install_failures: [
				...run.failures,
				...unverified.map((v) => ({
					runner: v.runner,
					reason: `final-state verification failed: ${v.problems.slice(0, 2).join("; ")}`,
				})),
			],
			rolled_back: rollbackError === undefined,
			...(rollbackError !== undefined ? { rollback_error: rollbackError } : {}),
			unchanged: settingsUnchanged(before),
			verifications,
		};
	}

	// Idempotency signal excludes the manifest (its installed_at stamp always
	// moves); everything ELSE byte-identical means the installed hooks were
	// already current.
	before.delete(mfPath);
	return {
		ok: !run.failed,
		dry_run: dryRun,
		refreshed: run.entries.map((e) => e.runner),
		skipped: run.skipped,
		post_install_failures: run.failures,
		rolled_back: false,
		unchanged: dryRun ? true : settingsUnchanged(before),
		verifications,
	};
}
