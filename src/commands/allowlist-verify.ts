// ===========================================
// interlinked allowlist verify — manifest-vs-allowlist diff
// ===========================================
// Extracted from allowlist.ts (per-file line cap) and the home for the full
// manifest walk: every committed dependency manifest is parsed and each dep is
// checked against the per-ecosystem allowlist. Exits non-zero on any unapproved
// dep so CI / pre-push can gate. Coverage tracks the manifest-edit guard so a
// repo can't carry an unapproved package the edit-time guard would have blocked
// while verify still reports "all approved": npm + pip (requirements.txt AND
// requirements.in) + pyproject/Cargo/Gemfile/go.mod + composer/maven/gradle +
// nuget, INCLUDING the variably-named *.csproj and the Gradle version catalog
// (libs.versions.toml). EVERY manifest is found RECURSIVELY (shared
// findManifestFiles walker): the manifest-EDIT guard blocks these basenames
// ANYWHERE in the tree, so a nested module/pom.xml, app/build.gradle, or
// packages/*/package.json must be scanned too — a root-only scan reported
// "clean" on a dep the edit-time guard would have blocked (finding 2026-06).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	extractCargoDeps,
	extractGemfileDeps,
	extractGoModDeps,
	extractPyprojectDeps,
	parsePipRequirementLine,
} from "../harness/evaluator/manifest-edit-guard.js";
import {
	extractComposerDeps,
	extractGradleDeps,
	extractGradleVersionCatalogDeps,
	extractNugetDeps,
	extractPomDeps,
} from "../harness/manifest-dep-extract.js";
import {
	describeLockfilePackage,
	JS_LOCKFILE_NAMES,
	nativeEvidenceOnDisk,
	parseLockfilePackages,
} from "../harness/lockfile-packages.js";
import { findManifestFiles } from "../harness/manifest-file-walk.js";
import {
	type Allowlist,
	isPackageAllowed,
	loadAllowlist,
	matchSnapshot,
} from "../harness/package-allowlist.js";
import type { Ecosystem } from "../harness/package-install-parser.js";
import { isJsonObject } from "../lib/json-types.js";

export interface VerifyOpts {
	cwd: string;
}

export function verifyAllowlistCommand(opts: VerifyOpts): void {
	const al = loadAllowlist(opts.cwd);
	const issues: string[] = [];
	checkPackageJson(opts.cwd, al, issues);
	checkRequirementsTxt(opts.cwd, al, issues);
	for (const spec of EXTRACTORS) checkExtracted(opts.cwd, al, issues, spec);
	checkCsprojFiles(opts.cwd, al, issues);
	checkVersionCatalog(opts.cwd, al, issues);
	checkRootLockfile(opts.cwd, al, issues);
	if (issues.length === 0) {
		process.stdout.write("all approved — manifest deps clean\n");
		return;
	}
	process.stdout.write(`${issues.length} unapproved dep(s):\n`);
	for (const issue of issues) process.stdout.write(`${issue}\n`);
	// Non-zero exit so CI / scripts can gate on the result (found 2026-06-11:
	// printing alone made this check un-gateable anywhere automated).
	process.exitCode = 1;
}

function readIfPresent(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function reportUnapproved(
	al: Allowlist,
	ecosystem: Ecosystem,
	name: string,
	issues: string[],
): void {
	const decision = isPackageAllowed(al, ecosystem, { kind: "registry", name });
	if (!decision.allowed) {
		issues.push(`  ${ecosystem}:${name} — ${decision.reason ?? "unapproved"}`);
	}
}

// Read every file in the tree whose basename satisfies `matchName`, via the
// shared bounded walker (skips node_modules/.git/build dirs, depth-capped, no
// symlink escape — the same scan the *.csproj / version-catalog checks use).
// Returns [relPath, content] pairs so a parse error can name the offending file.
// Root-only reads were the parity gap with the manifest-EDIT guard, which blocks
// these basenames ANYWHERE: a nested module/pom.xml or app/build.gradle could be
// blocked at edit time yet pass `verify` clean (finding 2026-06).
function readManifestsByName(
	cwd: string,
	matchName: (name: string) => boolean,
): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const rel of findManifestFiles(cwd, matchName)) {
		const content = readIfPresent(join(cwd, rel));
		if (content !== null) out.push([rel, content]);
	}
	return out;
}

function checkPackageJson(cwd: string, al: Allowlist, issues: string[]): void {
	const names = new Set<string>();
	for (const [rel, content] of readManifestsByName(cwd, (n) => n === "package.json")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			issues.push(`  could not parse ${rel} (JSON error)`);
			continue;
		}
		if (!isJsonObject(parsed)) {
			issues.push(`  ${rel} is not a JSON object`);
			continue;
		}
		for (const field of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			const m = parsed[field];
			if (!isJsonObject(m)) continue;
			for (const name of Object.keys(m)) names.add(name);
		}
	}
	for (const name of names) reportUnapproved(al, "npm", name, issues);
}

// pip deps live in requirements.txt AND requirements.in (the edit-guard gates
// both; verify must walk both or an unapproved dep added to requirements.in is
// blocked at edit time yet reported "all approved" here). Walked recursively —
// nested Python projects carry their own requirements files.
function checkRequirementsTxt(cwd: string, al: Allowlist, issues: string[]): void {
	const names = new Set<string>();
	for (const [, content] of readManifestsByName(
		cwd,
		(n) => n === "requirements.txt" || n === "requirements.in",
	)) {
		for (const line of content.split(/\r?\n/)) {
			const parsed = parsePipRequirementLine(line);
			if (parsed) names.add(parsed.name);
		}
	}
	for (const name of names) reportUnapproved(al, "pypi", name, issues);
}

interface ExtractorSpec {
	file: string;
	ecosystem: Ecosystem;
	extract: (content: string) => Map<string, string>;
}

// Every fixed-name manifest `verify` walks via the shared Map-shaped extractor
// contract. JVM/.NET/PHP extractors live in ../harness/manifest-dep-extract.ts
// (shared with the manifest-edit guard). Gradle has two manifest filenames.
const EXTRACTORS: readonly ExtractorSpec[] = [
	{ file: "pyproject.toml", ecosystem: "pypi", extract: extractPyprojectDeps },
	{ file: "Cargo.toml", ecosystem: "cargo", extract: extractCargoDeps },
	{ file: "Gemfile", ecosystem: "rubygems", extract: extractGemfileDeps },
	{ file: "go.mod", ecosystem: "go", extract: extractGoModDeps },
	{ file: "composer.json", ecosystem: "composer", extract: extractComposerDeps },
	{ file: "pom.xml", ecosystem: "maven", extract: extractPomDeps },
	{ file: "build.gradle", ecosystem: "gradle", extract: extractGradleDeps },
	{ file: "build.gradle.kts", ecosystem: "gradle", extract: extractGradleDeps },
	{ file: "packages.config", ecosystem: "nuget", extract: extractNugetDeps },
];

// Each fixed-name manifest is found RECURSIVELY and its dep names de-duped across
// however many copies the tree carries (root + nested modules), matching the
// *.csproj / version-catalog scans below and the any-path edit-guard.
function checkExtracted(
	cwd: string,
	al: Allowlist,
	issues: string[],
	spec: ExtractorSpec,
): void {
	const names = new Set<string>();
	for (const [, content] of readManifestsByName(cwd, (n) => n === spec.file)) {
		for (const name of spec.extract(content).keys()) names.add(name);
	}
	for (const name of names) reportUnapproved(al, spec.ecosystem, name, issues);
}

// *.csproj is variably named AND usually nested (src/App/App.csproj), so walk
// the tree (shared findManifestFiles) and run the nuget extractor over each.
// Names are de-duped so two projects depending on the same package report once.
function checkCsprojFiles(cwd: string, al: Allowlist, issues: string[]): void {
	const names = new Set<string>();
	for (const rel of findManifestFiles(cwd, (n) => n.endsWith(".csproj"))) {
		const content = readIfPresent(join(cwd, rel));
		if (content === null) continue;
		for (const dep of extractNugetDeps(content).keys()) names.add(dep);
	}
	for (const dep of names) reportUnapproved(al, "nuget", dep, issues);
}

/** Most transitive packages listed per lockfile before one summary row. */
const MAX_LOCKFILE_ROWS = 25;

// The ROOT JS lockfile (package-lock / npm-shrinkwrap / pnpm-lock / yarn.lock /
// bun.lock) names the RESOLVED closure — the transitive native deps the
// manifest never mentions and the install gate never saw (Hegel trial
// 2026-10-03: `koffi` pulled `@koromix/koffi-darwin-arm64`). A matching
// `lockfile_snapshots` grant approves the whole set, as designed; otherwise
// every unapproved package is a row, direct deps already reported above are
// skipped, and native evidence (lockfile fields + the installed tree) is
// called out. Root only, matching what `allowlist snapshot` hashes.
function checkRootLockfile(cwd: string, al: Allowlist, issues: string[]): void {
	const file = JS_LOCKFILE_NAMES.find((name) => existsSync(join(cwd, name)));
	if (!file) return;
	if (matchSnapshot(al, file, join(cwd, file))) return;
	const content = readIfPresent(join(cwd, file));
	const inventory = content === null ? null : parseLockfilePackages(file, content);
	if (!inventory) {
		issues.push(`  could not parse ${file} — its transitive packages are NOT screened`);
		return;
	}
	let hidden = 0;
	for (const pkg of inventory.values()) {
		if (isPackageAllowed(al, "npm", { kind: "registry", name: pkg.name }).allowed) continue;
		if (issues.some((row) => row.startsWith(`  npm:${pkg.name} —`))) continue;
		if (issues.filter((row) => row.includes(`transitive in ${file}`)).length >= MAX_LOCKFILE_ROWS) {
			hidden += 1;
			continue;
		}
		const described = describeLockfilePackage(pkg, nativeEvidenceOnDisk(cwd, pkg.name));
		issues.push(`  npm:${pkg.name} — transitive in ${file}: ${described}; not on the allowlist`);
	}
	if (hidden > 0) {
		issues.push(
			`  … ${hidden} more unapproved transitive package(s) in ${file} — approve the resolved set with \`interlinked allowlist snapshot --lockfile ${file} --by <you>\``,
		);
	}
}

// Gradle version catalog: deps live in libs.versions.toml [libraries]. The
// build.gradle `libs.foo` reference is only an alias — the real coordinate
// lives here (same as the manifest-edit guard's catalog handler). Found
// recursively (conventionally gradle/libs.versions.toml, but multi-project
// builds nest per-module catalogs). De-duped across catalogs.
function checkVersionCatalog(cwd: string, al: Allowlist, issues: string[]): void {
	const names = new Set<string>();
	for (const rel of findManifestFiles(cwd, (n) => n === "libs.versions.toml")) {
		const content = readIfPresent(join(cwd, rel));
		if (content === null) continue;
		for (const dep of extractGradleVersionCatalogDeps(content).keys()) names.add(dep);
	}
	for (const dep of names) reportUnapproved(al, "gradle", dep, issues);
}
