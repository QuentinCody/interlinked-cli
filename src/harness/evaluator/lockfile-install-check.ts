// ===========================================
// Check: lockfile_transitive_deps (PostToolUse, Bash)
// ===========================================
// The PreToolUse install gate (package-install-guard.ts) screens the specs
// NAMED on the command line. The registry resolves the rest, so a transitive
// native dependency reaches node_modules with no allowlist entry and no block
// — `npm install koffi@3.3.2` pulled `@koromix/koffi-darwin-arm64` (a 1.2 MB
// `.node`) in the Hegel trial of 2026-10-03. The closure is unknowable before
// the install (it needs the registry); the lockfile is the FIRST artifact that
// names it, so this check sits at PostToolUse:
//
//   PreToolUse  — recordLockfileBaseline: snapshot the install dir's lockfile
//                 package set (in-memory, per session + dir; the complexity-
//                 pulse stash pattern).
//   PostToolUse — collectLockfileInstallWarnings: re-read the lockfile, diff,
//                 and WARN for every new package absent from the allowlist,
//                 native ones first and louder. Warn-only and fail-open: the
//                 bytes are already on disk, so a block would be theatre; the
//                 agent (and `interlinked allowlist verify`) get the names.
//
// The diff is an exact set difference over parsed lockfiles — `[proven]`
// (PROVEN_TOOL_CHECKS). An unparseable lockfile or a missing snapshot is
// reported as NOT MEASURED, never as clean.

import { resolve } from "node:path";
import {
	describeLockfilePackage,
	type LockfilePackage,
	type LockfileSnapshot,
	nativeEvidenceOnDisk,
	newLockfilePackages,
	readLockfileSnapshot,
} from "../lockfile-packages.js";
import { isPackageAllowed, loadAllowlist, matchSnapshot } from "../package-allowlist.js";
import { type InstallCommand, parseInstallCommands } from "../package-install-parser.js";
import { classifyDeterminism } from "../quality-checks/warning-formatter.js";
import type { HarnessEvent } from "../types.js";
import { isBash } from "./tool-classifiers.js";
import { readToolString } from "./tool-input-values.js";

export const LOCKFILE_TRANSITIVE_CHECK_ID = "lockfile_transitive_deps";

/** Stash capacity — bounds daemon memory; oldest-first eviction. */
const MAX_STASH_ENTRIES = 64;
/** Most new packages spelled out on one warning line. */
const MAX_LISTED = 12;

/** `null` = the dir had a lockfile that did not parse (NOT MEASURED later). */
const stash = new Map<string, LockfileSnapshot | null>();

function stashKey(sessionId: string, dir: string): string {
	return `${sessionId}\u0000${dir}`;
}

/** Install dirs the npm-ecosystem commands of one shell line run in. */
function installDirs(cwd: string, commands: readonly InstallCommand[]): string[] {
	const dirs = new Set<string>();
	for (const command of commands) {
		if (command.ecosystem !== "npm") continue;
		dirs.add(resolve(cwd, command.effectiveCwd ?? "."));
	}
	return [...dirs];
}

/** PreToolUse side: snapshot each install dir's lockfile package set. Called
 *  from `evaluatePackageInstallGuard` for every parsed install command,
 *  before the allow/block decision (a blocked install leaves the lockfile
 *  untouched, so the snapshot stays true). Honors dry runs by its caller. */
export function recordLockfileBaseline(
	sessionId: string,
	cwd: string,
	commands: readonly InstallCommand[],
): void {
	for (const dir of installDirs(cwd, commands)) {
		const key = stashKey(sessionId, dir);
		stash.delete(key); // re-insert at the tail so eviction stays oldest-first
		stash.set(key, readLockfileSnapshot(dir));
		if (stash.size > MAX_STASH_ENTRIES) {
			const oldest = stash.keys().next().value;
			if (oldest !== undefined) stash.delete(oldest);
		}
	}
}

/** PostToolUse side: consume (delete-on-read) one dir's snapshot. */
export function consumeLockfileBaseline(
	sessionId: string,
	dir: string,
): { found: boolean; snapshot: LockfileSnapshot | null } {
	const key = stashKey(sessionId, dir);
	const found = stash.has(key);
	const snapshot = stash.get(key) ?? null;
	stash.delete(key);
	return { found, snapshot };
}

/** Test-only: clear the stash so suites are order-independent. */
export function __resetLockfileBaselineForTesting(): void {
	stash.clear();
}

function tagPrefix(): string {
	const tag = classifyDeterminism(LOCKFILE_TRANSITIVE_CHECK_ID);
	return tag ? `[${tag}] ` : "";
}

function notMeasured(detail: string): string {
	return (
		`[interlinked:supply-chain] NOT MEASURED (${LOCKFILE_TRANSITIVE_CHECK_ID}): ${detail} ` +
		`Transitive dependencies of this install were not screened; run \`interlinked allowlist verify\` to screen the whole lockfile.`
	);
}

/** One PostToolUse warning per install dir whose lockfile gained unapproved
 *  packages. Empty when the command installed nothing npm-shaped, the
 *  lockfile did not change, or every new package is approved (per-package
 *  grant, or a snapshot grant that already covers the new lockfile). */
export function collectLockfileInstallWarnings(event: HarnessEvent): string[] {
	if (!isBash(event.tool_name || "")) return [];
	const cmd = readToolString(event.tool_input?.command);
	if (!cmd) return [];
	const commands = parseInstallCommands(cmd);
	if (commands.length === 0) return [];
	const cwd = event.cwd || process.cwd();
	const warnings: string[] = [];
	for (const dir of installDirs(cwd, commands)) {
		const warning = diffOneInstallDir(event.session_id, cwd, dir);
		if (warning) warnings.push(warning);
	}
	return warnings;
}

function diffOneInstallDir(sessionId: string, projectRoot: string, dir: string): string | null {
	const after = readLockfileSnapshot(dir);
	if (after === null) return notMeasured(`the lockfile in ${dir} could not be parsed after the install.`);
	if (after.file === null) return null; // no lockfile before or after — nothing to diff
	const { found, snapshot } = consumeLockfileBaseline(sessionId, dir);
	if (!found) {
		return notMeasured(
			`no pre-install snapshot of ${after.file} exists for this command (PreToolUse was not observed by this daemon).`,
		);
	}
	if (snapshot === null) return notMeasured(`${after.file} could not be parsed before the install.`);
	const added = newLockfilePackages(snapshot.packages, after.packages);
	if (added.length === 0) return null;
	const allowlist = loadAllowlist(projectRoot);
	if (matchSnapshot(allowlist, after.file, resolve(dir, after.file))) return null;
	const unapproved = added.filter(
		(pkg) => !isPackageAllowed(allowlist, "npm", { kind: "registry", name: pkg.name }).allowed,
	);
	if (unapproved.length === 0) return null;
	return formatWarning(after.file, dir, unapproved);
}

function formatWarning(file: string, dir: string, unapproved: LockfilePackage[]): string {
	const described = unapproved
		.map((pkg) => ({ pkg, text: describeLockfilePackage(pkg, nativeEvidenceOnDisk(dir, pkg.name)) }))
		.sort((a, b) => Number(b.text.includes("[NATIVE")) - Number(a.text.includes("[NATIVE")));
	const nativeCount = described.filter((d) => d.text.includes("[NATIVE")).length;
	const shown = described.slice(0, MAX_LISTED).map((d) => d.text);
	const more = described.length > shown.length ? `, +${described.length - shown.length} more` : "";
	const nativeNote = nativeCount > 0 ? ` — ${nativeCount} NATIVE (install script / platform binary)` : "";
	return (
		`[interlinked:supply-chain] ${tagPrefix()}this install added ${unapproved.length} package(s) to ${file} ` +
		`that are NOT on the allowlist${nativeNote}. The PreToolUse gate screens only the specs you named; ` +
		`these arrived transitively: ${shown.join(", ")}${more}. Review each one, then approve it ` +
		`(\`interlinked allowlist add npm <name> --by <you> --reason <why>\`) or approve the resolved set ` +
		`(\`interlinked allowlist snapshot --lockfile ${file} --by <you>\`).`
	);
}
