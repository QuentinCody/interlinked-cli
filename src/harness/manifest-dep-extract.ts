import { isJsonObject } from "../lib/json-types.js";
// Dependency extractors for the JVM/.NET/PHP manifest formats added to the
// supply-chain guard (composer.json / pom.xml / build.gradle[.kts] /
// packages.config). Each returns a Map<name, value> with the same contract as
// the extractCargoDeps / extractGemfileDeps family in manifest-edit-guard.ts:
// the manifest-edit guard diffs before↔after by value-shape, and `interlinked
// allowlist verify` walks the keys against the per-ecosystem allowlist.
//
// All four are pure, regex/JSON heuristic parsers (no XML/Gradle DSL parser
// dep, mirroring the existing TOML heuristics) — they extract what an attacker
// would have to add to introduce a new dependency, nothing more.

/** composer.json `require` + `require-dev` (keys are "vendor/pkg" strings).
 *  Platform pseudo-packages (`php`, `ext-*`, `lib-*`, `composer-*`) are
 *  dropped — they constrain the runtime, not a registry download. */
import { nonNull } from "../lib/non-null.js";

export function extractComposerDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return deps;
	}
	if (!isJsonObject(parsed)) return deps;
	const root = parsed;
	for (const field of ["require", "require-dev"]) {
		const block = root[field];
		if (!isJsonObject(block)) continue;
		for (const [name, value] of Object.entries(block)) {
			if (isComposerPlatformPackage(name)) continue;
			deps.set(name, String(value));
		}
	}
	return deps;
}

function isComposerPlatformPackage(name: string): boolean {
	return (
		name === "php" ||
		name === "hhvm" ||
		name.startsWith("ext-") ||
		name.startsWith("lib-") ||
		name.startsWith("composer-") ||
		name.startsWith("php-")
	);
}

/** pom.xml `<dependency><groupId>G</groupId><artifactId>A</artifactId>
 *  [<version>V</version>]</dependency>` → key "G:A", value V (or "").
 *  Only coordinates inside a `<dependency>` element are returned; plugin
 *  coordinates (`<plugin>`) are intentionally skipped — they don't enter the
 *  application classpath. */
export function extractPomDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	const depBlock = /<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi;
	for (const m of content.matchAll(depBlock)) {
		const inner = m[1];
		const group = nonNull(inner).match(/<groupId>\s*([^<\s][^<]*?)\s*<\/groupId>/i);
		const artifact = nonNull(inner).match(/<artifactId>\s*([^<\s][^<]*?)\s*<\/artifactId>/i);
		if (!group || !artifact) continue;
		const version = nonNull(inner).match(/<version>\s*([^<]*?)\s*<\/version>/i);
		deps.set(`${nonNull(group[1])}:${nonNull(artifact[1])}`, version ? nonNull(version[1]) : "");
	}
	return deps;
}

/** build.gradle (Groovy) + build.gradle.kts (Kotlin) configuration calls
 *  carrying a `"G:A:V"` / `'G:A:V'` coordinate (and the kts `("G:A:V")`
 *  form) → key "G:A", value V. Only the dependency-declaring configurations
 *  are recognized; `project(...)`, `fileTree(...)`, `classpath`, and other
 *  verbs are ignored. */
export function extractGradleDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	const cfg = GRADLE_CONFIGS.join("|");
	// String-coordinate form: implementation "g:a:v" | api('g:a:v') | impl("g:a:v:classifier").
	// The version group stops at the next ':' so a 4-part coordinate's classifier
	// is not folded into the recorded version.
	const call = new RegExp(`\\b(?:${cfg})\\s*\\(?\\s*['\"]([^'\":]+):([^'\":]+):([^'\":]+)`, "g");
	for (const m of content.matchAll(call)) {
		deps.set(`${nonNull(m[1])}:${nonNull(m[2])}`, nonNull(m[3]));
	}
	// Map-notation form: implementation group: 'g', name: 'a'[, version: 'v'].
	// A standard documented Gradle dependency shape — matching only the string
	// coordinate left it ungated. Value is unused for registry classification,
	// so the name (group:name) is what matters for the allowlist.
	const mapForm = new RegExp(
		`\\b(?:${cfg})\\s*\\(?([^\\n)]*)`,
		"g",
	);
	for (const m of content.matchAll(mapForm)) {
		const dep = gradleMapDependencyName(m[1] ?? "");
		if (dep) deps.set(dep, "");
	}
	return deps;
}

function gradleMapDependencyName(args: string): string | null {
	const group = args.match(/\bgroup\s*:\s*['"]([^'"]+)['"]/);
	const name = args.match(/\bname\s*:\s*['"]([^'"]+)['"]/);
	return group && name ? `${group[1]}:${name[1]}` : null;
}

const GRADLE_CONFIGS = [
	"implementation",
	"api",
	"compileOnly",
	"runtimeOnly",
	"testImplementation",
	"testRuntimeOnly",
	"testCompileOnly",
	"annotationProcessor",
	"kapt",
	"developmentOnly",
] as const;

/** packages.config `<package id="X" version="Y" />` → key X, value Y.
 *  Attribute order is not significant. */
export function extractNugetDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	// XML attribute values may be single- OR double-quoted (both well-formed),
	// so each attribute regex captures the opening quote and backreferences it
	// (`(['"])…\1`). Matching only `id="…"` / `Include="…"` missed valid
	// single-quoted manifests, hiding the package from BOTH the PreToolUse
	// manifest-edit guard and `allowlist verify` (finding 2026-06).
	// Legacy packages.config: <package id="X" version="Y" />. `<package\b` does
	// NOT match `<PackageReference` (no word boundary after "package").
	const pkg = /<package\b([^>]*?)\/?>/gi;
	for (const m of content.matchAll(pkg)) {
		const attrs = m[1];
		const id = nonNull(attrs).match(/\bid\s*=\s*(['"])([^'"]+)\1/i);
		if (!id) continue;
		const version = nonNull(attrs).match(/\bversion\s*=\s*(['"])([^'"]+)\1/i);
		deps.set(nonNull(id[2]), version ? nonNull(version[2]) : "");
	}
	// Modern SDK-style .csproj: <PackageReference Include="X" Version="Y" /> or
	// <PackageReference Include="X"><Version>Y</Version></PackageReference>. This
	// is the dominant .NET dependency form today; gating only <package> left a
	// direct .csproj edit adding an unapproved package entirely unblocked.
	const ref = /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi;
	for (const m of content.matchAll(ref)) {
		const attrs = m[1];
		const inc = nonNull(attrs).match(/\bInclude\s*=\s*(['"])([^'"]+)\1/i);
		if (!inc) continue;
		const vAttr = nonNull(attrs).match(/\bVersion\s*=\s*(['"])([^'"]+)\1/i);
		const vChild = m[2] ? m[2].match(/<Version>\s*([^<]*?)\s*<\/Version>/i) : null;
		deps.set(nonNull(inc[2]), vAttr ? nonNull(vAttr[2]) : vChild ? nonNull(vChild[1]) : "");
	}
	return deps;
}


/** Gradle version-catalog (libs.versions.toml) `[libraries]` entries. Each
 *  declares a coordinate via `module = "g:a"` or `group = "g", name = "a"`. The
 *  build.gradle `libs.foo.bar` reference is only an alias — the real coordinate
 *  an attacker would add lives here, so this is where a version-catalog dep is
 *  gated. Returns key "g:a". */
export function extractGradleVersionCatalogDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	let inLibraries = false;
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inLibraries = /^\[libraries\]/.test(line);
			continue;
		}
		if (!inLibraries || line.startsWith("#") || !line) continue;
		// TOML accepts basic (double-quoted) AND literal (single-quoted) strings,
		// so each value regex captures the opening quote and backreferences it.
		// Matching only double quotes let `module = 'com.evil:payload'` slip past
		// BOTH the manifest-edit guard and `allowlist verify` (finding 2026-06).
		const moduleM = line.match(/\bmodule\s*=\s*(['"])([^'":]+):([^'"]+)\1/);
		if (moduleM) {
			deps.set(`${moduleM[2]}:${moduleM[3]}`, "");
			continue;
		}
		const groupM = line.match(/\bgroup\s*=\s*(['"])([^'"]+)\1/);
		const nameM = line.match(/\bname\s*=\s*(['"])([^'"]+)\1/);
		if (groupM && nameM) deps.set(`${groupM[2]}:${nameM[2]}`, "");
	}
	return deps;
}
