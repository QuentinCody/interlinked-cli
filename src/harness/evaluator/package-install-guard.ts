// Daemon-side supply-chain guard for package-install shell commands.
//
// Takes the parsed install commands + the project's allowlist + cwd, and
// returns a HarnessDecision (or null when there's nothing to evaluate).
//
// Block triggers (fail-closed):
//   1. Custom --registry / --index-url / --source — bypasses signing.
//   2. git/tarball/file URL specs — bypass registry audit.
//   3. Registry packages not on the per-ecosystem allowlist.
//   4. Lockfile-locked installs where the lockfile hash doesn't match a
//      stored snapshot.
//   5. Manifest-only syncs (no positional args) where neither the
//      manifest nor any colocated lockfile matches a stored snapshot.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { findTyposquatMatch } from "../checks/supply-chain.js";
import { findManifestFiles } from "../manifest-file-walk.js";
import {
	type Allowlist,
	hashLockfile,
	isPackageAllowed,
	matchSnapshot,
} from "../package-allowlist.js";
import type { Ecosystem, InstallCommand, PackageSpec } from "../package-install-parser.js";
import { pinnedVersionViolation } from "../package-install-parser.js";
import type { HarnessDecision } from "../types.js";

// Curated dev tooling the harness's OWN quality gates shell out to / require.
//
// The catch-22: the coverage and complexity gates mandate these providers
// (`@vitest/coverage-v8` for JS coverage, `pytest-cov`/`coverage` for Python,
// `radon` for Python cyclomatic), but the supply-chain gate would block their
// install because they aren't yet on the project allowlist. Enforcing coverage
// would then require fighting the very gate meant to protect you. To break the
// loop, an EXACT name match here is treated as allowlisted for the
// allowlist-membership check ONLY.
//
// This carve-out is deliberately narrow:
//   - EXACT (ecosystem, name) match only — no prefix, no fuzzy, no scope-wide
//     pass. A near-miss (`@vitest/coverage-v9000`) is NOT here, so it falls
//     through to the normal allowlist + typosquat path and is blocked.
//   - The exact-version PIN gate still applies (`@vitest/coverage-v8` unpinned
//     is still blocked; only `@vitest/coverage-v8@4.0.18` is allowed).
//   - `findTyposquatMatch` still runs — a lookalike of a provider name (in the
//     bare-name space the heuristic covers) is still refused.
// It NEVER relaxes the gate for anything outside this set.
const HARNESS_REQUIRED_DEV_TOOLING: Partial<Record<Ecosystem, ReadonlySet<string>>> = {
	npm: new Set(["@vitest/coverage-v8", "@vitest/coverage-istanbul", "vitest"]),
	pypi: new Set(["pytest-cov", "coverage", "pytest", "radon"]),
};

/**
 * True when `spec` is an EXACT-name match for harness-required dev tooling in
 * `ecosystem` AND is not a typosquat of a known popular package. Exact-only:
 * a registry spec whose name differs by even one char is not a member, so it
 * stays on the normal allowlist path. Non-registry specs are never members.
 */
function isHarnessRequiredTooling(ecosystem: Ecosystem, spec: PackageSpec): boolean {
	if (spec.kind !== "registry") return false;
	if (!HARNESS_REQUIRED_DEV_TOOLING[ecosystem]?.has(spec.name)) return false;
	// Defense in depth: a curated name that somehow also reads as a typosquat
	// of a popular package is refused rather than waved through.
	return findTyposquatMatch(spec.name) === null;
}


interface ManifestSearchEntry {
	manifest: string;
	lockfiles: string[];
}

const MANIFEST_BY_ECOSYSTEM: Record<Ecosystem, ManifestSearchEntry[]> = {
	npm: [
		{
			manifest: "package.json",
			lockfiles: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"],
		},
	],
	pypi: [
		{ manifest: "pyproject.toml", lockfiles: ["poetry.lock", "uv.lock", "pdm.lock"] },
		{ manifest: "requirements.txt", lockfiles: ["requirements.lock"] },
		{ manifest: "Pipfile", lockfiles: ["Pipfile.lock"] },
	],
	cargo: [{ manifest: "Cargo.toml", lockfiles: ["Cargo.lock"] }],
	rubygems: [{ manifest: "Gemfile", lockfiles: ["Gemfile.lock"] }],
	go: [{ manifest: "go.mod", lockfiles: ["go.sum"] }],
	composer: [{ manifest: "composer.json", lockfiles: ["composer.lock"] }],
	// Maven/Gradle have no universally-named lockfile; the manifest snapshot is
	// the anchor. Gradle's `.lockfile` is opt-in and project-placed.
	maven: [{ manifest: "pom.xml", lockfiles: [] }],
	gradle: [
		{ manifest: "build.gradle", lockfiles: ["gradle.lockfile"] },
		{ manifest: "build.gradle.kts", lockfiles: ["gradle.lockfile"] },
	],
	// NuGet: packages.config is exact-named; modern .csproj names vary, so the
	// lockfile (packages.lock.json) carries the snapshot when present.
	nuget: [{ manifest: "packages.config", lockfiles: ["packages.lock.json"] }],
};

// Ecosystems whose manifest filename is NOT a fixed basename — matched by
// extension in the install cwd. NuGet SDK-style projects keep deps in a
// variably-named *.csproj that `dotnet restore` reads with no packages.config
// present, so without scanning here the snapshot gate has nothing to match and
// an approved `allowlist snapshot --lockfile App.csproj` is never consulted
// (the restore stays blocked forever). Found 2026-06.
const GLOB_MANIFEST_EXTENSIONS: Partial<Record<Ecosystem, string[]>> = {
	nuget: [".csproj"],
};

export function evaluatePackageInstall(
	commands: InstallCommand[],
	cwd: string,
	allowlist: Allowlist,
): HarnessDecision | null {
	if (commands.length === 0) return null;

	for (const cmd of commands) {
		const verdict = evaluateOne(cmd, cwd, allowlist);
		if (verdict) return verdict;
	}
	return { decision: "allow" };
}

function evaluateOne(
	cmd: InstallCommand,
	cwd: string,
	allowlist: Allowlist,
): HarnessDecision | null {
	// Uninstall / no-op: nothing new can enter the supply chain, allow.
	if (cmd.action === "remove" || cmd.action === "noop") return null;
	// Resolve the cwd to use for manifest/lockfile lookups. A preceding
	// `cd <path>` in the same compound shell line shifts this away from
	// the event's cwd — without honoring it, a root-package snapshot can
	// allow an unsnapshotted subpackage install (and vice-versa).
	const effectiveCwd = cmd.effectiveCwd
		? isAbsolute(cmd.effectiveCwd)
			? cmd.effectiveCwd
			: resolve(cwd, cmd.effectiveCwd)
		: cwd;

	// Custom registry — always suspect. An attacker who can flip --registry
	// can serve any package payload, bypassing the upstream signing model.
	if (cmd.customRegistry) {
		return block(
			`Custom registry "${cmd.customRegistry}" on ${cmd.manager} install is never auto-allowed. Use the default ecosystem registry, or remove the override.`,
			"supply-chain-custom-registry",
		);
	}

	// Positional packages — each must be exactly version-pinned AND allowlisted.
	if (cmd.packages.length > 0) return positionalPackagesBlock(cmd, allowlist);

	// Sync from manifest/lockfile without positional args. Require a stored
	// snapshot match — either the manifest or any of its colocated lockfiles.
	if (cmd.fromLockfile || cmd.fromManifest) {
		return snapshotMismatchBlock(cmd, effectiveCwd, allowlist);
	}

	// Catch-all: install_global with no positional packages (e.g. malformed
	// `cargo install` with no crate name) — fail closed.
	if (cmd.action === "install_global") {
		return block(
			`${cmd.manager} ${cmd.action} requires explicit package arg; refusing implicit install.`,
			"supply-chain-bare-install-global",
		);
	}

	return null;
}

// Per-spec gate for an install carrying explicit positional packages. Each
// spec must be (a) exactly version-pinned AND (b) on the per-ecosystem
// allowlist. These are independent gates: an allowlisted name installed at a
// floating version (`npm install lodash`, `lodash@^4`, `lodash@latest`) can
// still resolve to a newer, compromised release, so the pin requirement holds
// even for approved names. Returns the first block, or null when all pass.
function positionalPackagesBlock(
	cmd: InstallCommand,
	allowlist: Allowlist,
): HarnessDecision | null {
	for (const spec of cmd.packages) {
		const pinBlock = pinViolationBlock(cmd, spec);
		if (pinBlock) return pinBlock;
		// Harness-required dev tooling (coverage/test/complexity providers) is
		// treated as allowlisted for the membership check ONLY — see
		// HARNESS_REQUIRED_DEV_TOOLING for why (the coverage catch-22). The pin
		// gate above and the typosquat guard inside isHarnessRequiredTooling
		// have already applied, so this is exact-name + pinned + non-typosquat.
		if (isHarnessRequiredTooling(cmd.ecosystem, spec)) continue;
		const dec = isPackageAllowed(allowlist, cmd.ecosystem, spec);
		if (!dec.allowed) {
			return block(
				`${cmd.manager} ${cmd.action}: ${dec.reason ?? "unapproved package"}`,
				"supply-chain-unapproved-package",
			);
		}
	}
	return null;
}

// Step 1 of snapshotMismatchBlock: does any entry's lockfile have a matching
// snapshot on disk? Extracted so the depth-2 loop doesn't nest inside the
// caller's own branching.
function anyLockfileSnapshotMatches(
	entries: ManifestSearchEntry[],
	effectiveCwd: string,
	allowlist: Allowlist,
	fixedSnapshotCanAllow: boolean,
): boolean {
	for (const entry of entries) {
		for (const lf of entry.lockfiles) {
			const p = join(effectiveCwd, lf);
			if (isExistingFile(p) && matchSnapshot(allowlist, lf, p) && fixedSnapshotCanAllow) {
				return true;
			}
		}
	}
	return false;
}

// Manifest/lockfile snapshot gate for a no-positional sync (`npm ci`, bare
// `npm install`, `pip install -r`, …). Returns null when a stored snapshot
// matches a present lockfile (preferred) or the manifest; otherwise a block.
// All path resolutions use effectiveCwd so `cd subdir && npm ci` checks the
// subdirectory's lockfile, not the root's.
function snapshotMismatchBlock(
	cmd: InstallCommand,
	effectiveCwd: string,
	allowlist: Allowlist,
): HarnessDecision | null {
	const entries = MANIFEST_BY_ECOSYSTEM[cmd.ecosystem];
	const globManifests = scanGlobManifests(effectiveCwd, cmd.ecosystem);
	const globManifestsMatch =
		globManifests.length > 0 &&
		globManifests.every((name) => matchSnapshot(allowlist, name, join(effectiveCwd, name)));
	const fixedSnapshotCanAllow = globManifests.length === 0 || globManifestsMatch;
	// 1. Prefer lockfiles when one exists (stronger guarantee than manifest).
	if (anyLockfileSnapshotMatches(entries, effectiveCwd, allowlist, fixedSnapshotCanAllow)) {
		return null;
	}
	// 2. Fall back to manifest snapshot when no lockfile snapshot matched.
	for (const entry of entries) {
		const p = join(effectiveCwd, entry.manifest);
		if (isExistingFile(p) && matchSnapshot(allowlist, entry.manifest, p) && fixedSnapshotCanAllow) {
			return null;
		}
	}
	// 3. Glob-named manifests (e.g. *.csproj): each project file is independent
	//    and `dotnet restore` resolves ALL of them (RECURSIVELY, across nested
	//    projects via .sln / <ProjectReference>), so allow only when EVERY present
	//    one matches a snapshot — a single snapshotted project must not vouch for
	//    an unsnapshotted sibling (root OR nested) with an unapproved package.
	if (globManifestsMatch) {
		return null;
	}
	// Nothing matched.
	const presentFiles = [
		...entries.flatMap((e) => [e.manifest, ...e.lockfiles]),
		...globManifests,
	].filter((f) => isExistingFile(join(effectiveCwd, f)));
	const hint = presentFiles.length
		? ` Run \`interlinked allowlist snapshot\` to approve the current state of: ${presentFiles.join(", ")}.`
		: ` Initial bootstrap: \`interlinked allowlist add ${cmd.ecosystem} <package>\` per package, or \`interlinked allowlist snapshot\` once the manifest is in place.`;
	const presentHashes = presentFiles
		.map((f) => `${f}=${(hashLockfile(join(effectiveCwd, f)) ?? "?").slice(0, 12)}`)
		.join(" ");
	const cwdNote = cmd.effectiveCwd ? ` [in ${cmd.effectiveCwd}]` : "";
	return block(
		`${cmd.manager} ${cmd.action}${cwdNote}: no allowlist snapshot matches the current ${cmd.ecosystem} manifest/lockfile state.${hint}${presentHashes ? ` (current hashes: ${presentHashes})` : ""}`,
		"supply-chain-snapshot-mismatch",
	);
}

// Exact-pin gate for a single spec. Returns a block decision when a registry
// spec is not exactly version-pinned, else null. Honors the documented
// INTERLINKED_DISABLE_PACKAGE_GUARD=1 single-command bypass (the same escape
// hatch the cold-fallback paths use) — no new config flag. Non-registry specs
// (git/tarball/file/local) carry no version and are left to the allowlist's
// own kind-based decision.
function pinViolationBlock(cmd: InstallCommand, spec: PackageSpec): HarnessDecision | null {
	if (process.env.INTERLINKED_DISABLE_PACKAGE_GUARD === "1") return null;
	const reason = pinnedVersionViolation(spec, cmd.ecosystem);
	if (!reason) return null;
	const name = spec.kind === "registry" ? spec.name : "package";
	return block(
		`${cmd.manager} ${cmd.action}: ${reason}. Pin it: install \`${name}@<exact-version>\` (e.g. ${name}@1.2.3); floating versions can resolve to a newer, compromised release.`,
		"supply-chain-unpinned-version",
	);
}

function block(reason: string, ruleId: string): HarnessDecision {
	return {
		decision: "block",
		reason: `[interlinked:supply-chain] ${reason}`,
		rule_id: ruleId,
		severity: "high",
		category: "supply-chain",
	};
}

function isExistingFile(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// Files matching a glob-named ecosystem manifest extension (e.g. `*.csproj` for
// nuget), found RECURSIVELY under `dir` and returned as paths relative to it.
// `dotnet restore` resolves projects transitively (.sln / <ProjectReference>,
// the common src/App/App.csproj layout), so a root-only scan would let an
// unapproved nested project slip past the snapshot gate. Relative paths are the
// snapshot keys — bare basenames would alias two App.csproj in different dirs.
function scanGlobManifests(dir: string, ecosystem: Ecosystem): string[] {
	const exts = GLOB_MANIFEST_EXTENSIONS[ecosystem];
	if (!exts) return [];
	return findManifestFiles(dir, (name) => exts.some((ext) => name.endsWith(ext)));
}
