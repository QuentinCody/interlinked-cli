// Block Write/Edit/MultiEdit to a package manifest that introduces a new,
// unapproved dependency. Covers the vector where an agent skips the install
// command entirely and just adds an entry directly to package.json /
// requirements.txt / pyproject.toml / Cargo.toml — then a later install
// (run by a human, in CI, etc.) pulls the new code in.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import { isLicenseAllowed } from "../license-policy.js";
import {
	extractComposerDeps,
	extractGradleDeps,
	extractGradleVersionCatalogDeps,
	extractNugetDeps,
	extractPomDeps,
} from "../manifest-dep-extract.js";
import {
	type Allowlist,
	effectiveLicenseAllowlist,
	isPackageAllowed,
} from "../package-allowlist.js";
import type { Ecosystem, PackageSpec } from "../package-install-parser.js";
import type { HarnessDecision } from "../types.js";

interface ManifestEditInput {
	filePath: string;
	newContent: string;
	allowlist: Allowlist;
	cwd: string;
	/** Out-param: non-blocking findings (license policy) are pushed here. */
	warnings?: string[] | undefined;
}

interface DepDelta {
	ecosystem: Ecosystem;
	name: string;
	value: string;
}

const MANIFEST_HANDLERS: Record<
	string,
	(before: string, after: string) => DepDelta[]
> = {
	"package.json": diffPackageJson,
	"requirements.txt": (b, a) => diffLineOriented(b, a, "pypi", parsePipRequirementLine),
	"requirements.in": (b, a) => diffLineOriented(b, a, "pypi", parsePipRequirementLine),
	"pyproject.toml": diffPyprojectToml,
	"Cargo.toml": diffCargoToml,
	"go.mod": diffGoMod,
	Gemfile: diffGemfile,
	"composer.json": diffComposer,
	"pom.xml": diffPom,
	"build.gradle": diffGradle,
	"build.gradle.kts": diffGradle,
	"libs.versions.toml": diffGradleCatalog,
	"packages.config": diffNuget,
};

/** libs.versions.toml (Gradle version-catalog): new `[libraries]` coordinates
 *  are deltas, same as the other gradle manifests. */
function diffGradleCatalog(before: string, after: string): DepDelta[] {
	return diffByValueShape(
		extractGradleVersionCatalogDeps(before),
		extractGradleVersionCatalogDeps(after),
		"gradle",
	);
}

export function evaluateManifestEdit(input: ManifestEditInput): HarnessDecision | null {
	const name = basename(input.filePath);
	// `.csproj` filenames vary (not a fixed basename), so match by extension —
	// the nuget extractor reads its <PackageReference> entries. Without this, a
	// direct edit adding an unapproved package to a .csproj is entirely unblocked
	// (the dominant modern .NET form; finding 2026-06).
	const handler = MANIFEST_HANDLERS[name] ?? (name.endsWith(".csproj") ? diffNuget : undefined);
	if (!handler) return null;

	const before = existsSync(input.filePath)
		? safeRead(input.filePath)
		: ""; // brand-new file
	let added: DepDelta[];
	try {
		added = handler(before, input.newContent);
	} catch {
		// Don't fail-closed on parse errors — other guards will surface
		// JSON/TOML/etc. validity. We only block on deltas we can see.
		return null;
	}
	if (added.length === 0) return null;

	for (const delta of added) {
		const decision = decideAddedDep(input, name, delta);
		if (decision) return decision;
	}
	return null;
}

/** One added dependency: block when the allowlist refuses it, otherwise record
 *  any license finding and allow. */
function decideAddedDep(
	input: ManifestEditInput,
	manifestName: string,
	delta: DepDelta,
): HarnessDecision | null {
	const spec = classifyManifestValue(delta.ecosystem, delta.name, delta.value);
	const dec = isPackageAllowed(input.allowlist, delta.ecosystem, spec);
	if (!dec.allowed) {
		return {
			decision: "block",
			reason: `[interlinked:supply-chain] ${manifestName} adds new ${delta.ecosystem} dependency "${delta.name}": ${dec.reason ?? "unapproved"}`,
			rule_id: "supply-chain-manifest-add",
			severity: "high",
			category: "supply-chain",
		};
	}
	warnOnRecordedLicense(input, manifestName, delta, spec);
	return null;
}

/** License policy (warning, never blocks): re-check the license RECORDED at
 *  admission time against the committed SPDX allowlist. Catches entries
 *  admitted via --force and allowlists tightened after the grant. Reads only
 *  the stored field — the hook path never fetches. */
function warnOnRecordedLicense(
	input: ManifestEditInput,
	manifestName: string,
	delta: DepDelta,
	spec: PackageSpec,
): void {
	if (spec.kind !== "registry" || !input.warnings) return;
	const entry = input.allowlist.packages[delta.ecosystem][spec.name];
	if (entry?.license === undefined) return;
	if (isLicenseAllowed(entry.license, effectiveLicenseAllowlist(input.allowlist))) return;
	input.warnings.push(
		`[interlinked:supply-chain] ${manifestName} adds ${delta.ecosystem} dependency "${delta.name}" whose recorded license "${entry.license}" is outside the SPDX license allowlist. Review the grant or extend license_allowlist in .interlinked/package-allowlist.json.`,
	);
}

function safeRead(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

// ============================================================
// package.json
// ============================================================
function diffPackageJson(before: string, after: string): DepDelta[] {
	const FIELDS = [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	];
	const beforeJson = parseJsonSafe(before) ?? {};
	const afterJson = parseJsonSafe(after);
	if (!afterJson) throw new Error("invalid JSON in new content");
	const out: DepDelta[] = [];
	for (const field of FIELDS) {
		const oldDeps = recordOf(beforeJson, field);
		const newDeps = recordOf(afterJson, field);
		for (const [name, value] of Object.entries(newDeps)) {
			if (!(name in oldDeps)) {
				out.push({ ecosystem: "npm", name, value: String(value) });
			} else if (typeof oldDeps[name] === "string" && oldDeps[name] !== value) {
				// Same name, different value. If the new value is a URL-shaped
				// spec, treat as a re-pinning to a non-registry source — that
				// IS a substantive change worth gating.
				if (looksLikeUrlSpec(String(value))) {
					out.push({ ecosystem: "npm", name, value: String(value) });
				}
			}
		}
	}
	return out;
}

function recordOf(obj: unknown, key: string): JsonObject {
	if (!obj || typeof obj !== "object") return {};
	const v = (obj as JsonObject)[key];
	return v && typeof v === "object" ? (v as JsonObject) : {};
}

function parseJsonSafe(s: string): unknown {
	if (!s.trim()) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

function looksLikeUrlSpec(value: string): boolean {
	return (
		/^git\+/.test(value) ||
		/^https?:/.test(value) ||
		/^file:/.test(value) ||
		/^github:/.test(value) ||
		/^gitlab:/.test(value) ||
		/^bitbucket:/.test(value)
	);
}

// ============================================================
// line-oriented manifests (requirements.txt, requirements.in)
// ============================================================
function diffLineOriented(
	before: string,
	after: string,
	ecosystem: Ecosystem,
	parser: (line: string) => { name: string; value: string } | null,
): DepDelta[] {
	const beforeSet = new Set(
		before
			.split(/\r?\n/)
			.map((l) => parser(l)?.name)
			.filter((n): n is string => !!n),
	);
	const added: DepDelta[] = [];
	for (const line of after.split(/\r?\n/)) {
		const parsed = parser(line);
		if (!parsed) continue;
		if (!beforeSet.has(parsed.name)) {
			added.push({ ecosystem, name: parsed.name, value: parsed.value });
		}
	}
	return added;
}

export function parsePipRequirementLine(line: string): { name: string; value: string } | null {
	const trimmed = line.replace(/#.*$/, "").trim();
	if (!trimmed) return null;
	// git+, http(s):, file:, local path
	if (looksLikeUrlSpec(trimmed) || trimmed.startsWith("-e ")) {
		// Use the line itself as both name (for diff-set) and value
		const value = trimmed.replace(/^-e\s+/, "");
		return { name: value, value };
	}
	if (trimmed.startsWith("-")) return null; // pip flags
	const m = trimmed.match(/^([A-Za-z0-9._-]+)/);
	if (!m) return null;
	return { name: nonNull(m[1]), value: trimmed };
}

/** Detect a TOML-inline-table or Ruby-hash dep value that points to a
 *  non-registry source (git, path, file:, registry alias). When an
 *  already-approved package name flips from a plain version string to
 *  this shape, the dep is effectively a different package — the same
 *  treatment npm gets in diffPackageJson. */
function looksLikeNonRegistrySource(value: string): boolean {
	return (
		/\bgit\s*[:=]/.test(value) ||
		/\bpath\s*[:=]/.test(value) ||
		/\brepository\s*[:=]/.test(value) ||
		/\bregistry\s*[:=]/.test(value) ||
		/\burl\s*[:=]/.test(value) ||
		/\bsource\s*[:=]/.test(value) ||
		/^git\+/.test(value) ||
		/^https?:/.test(value) ||
		/^file:/.test(value) ||
		/^github:/.test(value)
	);
}

/** Shared diff: new entries are deltas; same-name-different-value entries
 *  are deltas only when the new value points at a non-registry source.
 *  Plain version bumps stay allowed — they're caught by the install-time
 *  gate + lockfile snapshot, not by the new-dep diff. */
function diffByValueShape(
	beforeDeps: Map<string, string>,
	afterDeps: Map<string, string>,
	ecosystem: Ecosystem,
): DepDelta[] {
	const out: DepDelta[] = [];
	for (const [name, value] of afterDeps) {
		const oldValue = beforeDeps.get(name);
		if (oldValue === undefined) {
			out.push({ ecosystem, name, value });
			continue;
		}
		if (oldValue !== value && looksLikeNonRegistrySource(value)) {
			out.push({ ecosystem, name, value });
		}
	}
	return out;
}

// ============================================================
// pyproject.toml (heuristic — no TOML parser dep)
// ============================================================
function diffPyprojectToml(before: string, after: string): DepDelta[] {
	return diffByValueShape(
		extractPyprojectDeps(before),
		extractPyprojectDeps(after),
		"pypi",
	);
}

export function extractPyprojectDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	let inDepsBlock = false;
	const TARGET_HEADERS = /^\[(?:tool\.poetry\.(?:dev-)?dependencies|tool\.poetry\.group\.[^.\]]+\.dependencies|project\.optional-dependencies\.[^\]]+)\]/;
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inDepsBlock = TARGET_HEADERS.test(line);
			continue;
		}
		if (!inDepsBlock) continue;
		const dep = parsePoetryDepLine(line);
		if (dep) deps.set(dep.name, dep.value);
	}
	for (const [name, value] of extractPep508ArrayDeps(content)) deps.set(name, value);
	return deps;
}

/** One `name = value` line of a Poetry dependencies table. Null for comments,
 *  blank lines, non-assignments, and the `python` version pin. */
function parsePoetryDepLine(line: string): { name: string; value: string } | null {
	if (!line || line.startsWith("#")) return null;
	const m = line.match(/^([A-Za-z0-9._-]+)\s*=\s*(.+?)(?:\s*#.*)?$/);
	if (!m) return null;
	if (m[1] === "python") return null; // not a dep — Python version pin
	return { name: nonNull(m[1]), value: nonNull(m[2]) };
}

/** `project.dependencies = [ "a==1", "b" ]` — a PEP 508 string array, a different shape from the Poetry tables. */
function extractPep508ArrayDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	const arrayMatch = content.match(/(?:^|\n)\s*dependencies\s*=\s*\[([\s\S]*?)\]/);
	if (!arrayMatch) return deps;
	for (const it of nonNull(arrayMatch[1]).match(/"([^"]+)"/g) || []) {
		const inner = it.slice(1, -1);
		const nm = inner.match(/^([A-Za-z0-9._-]+)/);
		if (nm) deps.set(nonNull(nm[1]), inner);
	}
	return deps;
}

// ============================================================
// Cargo.toml
// ============================================================
function diffCargoToml(before: string, after: string): DepDelta[] {
	return diffByValueShape(extractCargoDeps(before), extractCargoDeps(after), "cargo");
}

export function extractCargoDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	const lines = content.split(/\r?\n/);
	let inBlock = false;
	const TARGET = /^\[(?:dependencies|dev-dependencies|build-dependencies|target\.[^.\]]+\.dependencies)\]/;
	for (const raw of lines) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inBlock = TARGET.test(line);
			continue;
		}
		if (!inBlock) continue;
		if (line.startsWith("#") || !line) continue;
		const m = line.match(/^([A-Za-z0-9._-]+)\s*=\s*(.+?)(?:\s*#.*)?$/);
		if (m) deps.set(nonNull(m[1]), nonNull(m[2]));
	}
	return deps;
}

// ============================================================
// go.mod
// ============================================================
function diffGoMod(before: string, after: string): DepDelta[] {
	const beforeDeps = extractGoModDeps(before);
	const afterDeps = extractGoModDeps(after);
	const out: DepDelta[] = [];
	for (const [name, value] of afterDeps) {
		if (!beforeDeps.has(name)) {
			out.push({ ecosystem: "go", name, value });
		}
	}
	return out;
}

export function extractGoModDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	const lines = content.split(/\r?\n/);
	let inBlock = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (line.startsWith("require (")) {
			inBlock = true;
			continue;
		}
		if (line === ")") {
			inBlock = false;
			continue;
		}
		const m = inBlock
			? line.match(/^([^\s]+)\s+([^\s]+)/)
			: line.match(/^require\s+([^\s]+)\s+([^\s]+)/);
		if (m) deps.set(nonNull(m[1]), nonNull(m[2]));
	}
	return deps;
}

// ============================================================
// Gemfile
// ============================================================
function diffGemfile(before: string, after: string): DepDelta[] {
	return diffByValueShape(
		extractGemfileDeps(before),
		extractGemfileDeps(after),
		"rubygems",
	);
}

export function extractGemfileDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	const re = /^\s*gem\s+["']([A-Za-z0-9._-]+)["'](?:\s*,\s*(.+))?$/gm;
	for (const m of content.matchAll(re)) {
		deps.set(nonNull(m[1]), m[2] || "");
	}
	return deps;
}

// ============================================================
// composer.json / pom.xml / build.gradle[.kts] / packages.config
// (extractors live in ../manifest-dep-extract.ts — shared with
//  `interlinked allowlist verify`). All four reuse diffByValueShape:
// new names are deltas, and a composer name flipped to an inline git/path
// source value is a delta too (the version-bump path stays allowed).
// ============================================================
function diffComposer(before: string, after: string): DepDelta[] {
	return diffByValueShape(
		extractComposerDeps(before),
		extractComposerDeps(after),
		"composer",
	);
}

function diffPom(before: string, after: string): DepDelta[] {
	return diffByValueShape(extractPomDeps(before), extractPomDeps(after), "maven");
}

function diffGradle(before: string, after: string): DepDelta[] {
	return diffByValueShape(
		extractGradleDeps(before),
		extractGradleDeps(after),
		"gradle",
	);
}

function diffNuget(before: string, after: string): DepDelta[] {
	return diffByValueShape(extractNugetDeps(before), extractNugetDeps(after), "nuget");
}

// ============================================================
// Spec classification (mirrors package-install-parser's logic for
// manifest-value strings, plus TOML inline-table and Ruby-hash shapes)
// ============================================================
function classifyManifestValue(_eco: Ecosystem, name: string, value: string): PackageSpec {
	if (/^https?:\/\/.+\.(tgz|tar\.gz|whl|zip)(?:[?#].*)?$/i.test(value))
		return { kind: "tarball_url", url: value };
	if (
		/^git\+/.test(value) ||
		/^github:/.test(value) ||
		/^gitlab:/.test(value) ||
		/^bitbucket:/.test(value) ||
		/^https?:\/\/.+\.git(?:#.+)?$/.test(value)
	)
		return { kind: "git_url", url: value };
	if (/^file:/.test(value)) return { kind: "file_url", path: value.replace(/^file:\/*/, "") };
	// TOML inline table or Ruby hash: { git = "..." } / git: "..." / { path = "..." }.
	// `path =` in a manifest is NOT the same as `npm install ./localdir` from
	// the shell — the manifest can point at arbitrary fs paths under the
	// install resolver, including outside the workspace. Treat as file_url
	// (always blocked) so the allowlist gate fires.
	const gitInline = value.match(/\bgit\s*[:=]\s*['"]?([^'"\s,}]+)/);
	if (gitInline) return { kind: "git_url", url: nonNull(gitInline[1]) };
	const pathInline = value.match(/\bpath\s*[:=]\s*['"]?([^'"\s,}]+)/);
	if (pathInline) return { kind: "file_url", path: nonNull(pathInline[1]) };
	const urlInline = value.match(/\burl\s*[:=]\s*['"]?(https?:\/\/[^'"\s,}]+)/);
	if (urlInline) return { kind: "tarball_url", url: nonNull(urlInline[1]) };
	// registry=/repository=/source= inline-table keys (Cargo `{ registry = "…" }`,
	// Ruby `gem "x", source: "…"`, Poetry `{ source = "…" }`): these redirect the
	// resolver to a NON-default source without changing the package name, so an
	// already-approved name (approved against the ecosystem's default registry)
	// would otherwise silently ride through as a plain `registry` spec — the
	// allowlist entry says nothing about the alternate host. Treat the same as
	// git_url (never auto-allowed, regardless of whether the name is approved).
	const repositoryInline = value.match(/\brepository\s*[:=]\s*['"]?([^'"\s,}]+)/);
	if (repositoryInline) return { kind: "git_url", url: nonNull(repositoryInline[1]) };
	const registryInline = value.match(/\bregistry\s*[:=]\s*['"]?([^'"\s,}]+)/);
	if (registryInline) return { kind: "git_url", url: nonNull(registryInline[1]) };
	const sourceInline = value.match(/\bsource\s*[:=]\s*['"]?([^'"\s,}]+)/);
	if (sourceInline) return { kind: "git_url", url: nonNull(sourceInline[1]) };
	return { kind: "registry", name };
}
