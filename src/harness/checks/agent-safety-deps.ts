// Agent Safety Checks — Import hygiene / dependency safety.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from agent-safety.ts to stay under the per-file line ceiling.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

// --- 2. Import Hygiene ---

/**
 * Detect self-imports: a module importing from itself (causes infinite loops or empty values).
 */
export function checkSelfImport(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Get the base filename without extension for matching
	const base = basename(filePath).replace(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/, "");

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 5) break;
		const trimmed = nonNull(strippedLines[i]).trim();
		if (!/^import\s/.test(trimmed)) continue;
		// Match the specifier against the ORIGINAL line, not the stripped one.
		// `stripCommentsAndStrings` blanks string CONTENTS (`"./foo.js"` -> `""`),
		// and this regex requires >=1 char between the quotes — so reading it from
		// `trimmed` made `fromMatch` always null and every line hit `continue`.
		// This detector could never fire (measured 2026-08-06; the same defect
		// killed `checkExtraneousDependencies` below). The stripped line is still
		// what decides whether this LOOKS like an import statement, so a `from
		// "..."` inside a comment or string literal is still ignored.
		const fromMatch = nonNull(originalLines[i]).match(/from\s+['"]([^'"]+)['"]/);
		if (!fromMatch) continue;
		const specifier = fromMatch[1];
		if (!nonNull(specifier).startsWith(".")) continue;
		const importBase = nonNull(specifier)
			.split("/")
			.pop()
			?.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
		if (importBase === base) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect extraneous dependencies: bare-specifier imports not found in package.json.
 * Requires reading package.json once (cached per filePath directory).
 */
const _pkgDepsCache = new Map<string, Set<string>>();

/** Node.js built-in module names — always "declared" regardless of package.json. */
const NODE_BUILTIN_MODULES = [
	"fs",
	"path",
	"os",
	"url",
	"http",
	"https",
	"crypto",
	"util",
	"stream",
	"events",
	"child_process",
	"net",
	"tls",
	"dns",
	"assert",
	"buffer",
	"querystring",
	"zlib",
	"readline",
	"cluster",
	"worker_threads",
	"perf_hooks",
	"async_hooks",
	"v8",
	"vm",
	"tty",
	"dgram",
	"inspector",
	"trace_events",
	"string_decoder",
	"module",
	"process",
	"timers",
	"console",
];

/** Dependency-field key names, or [] when the field is missing/malformed
 *  (not present, not an object, or an array — `Object.keys` on an array
 *  yields numeric-index strings like "0"/"1", which would otherwise be
 *  treated as declared dependency names). */
function _depFieldNames(value: unknown): string[] {
	return isJsonObject(value) ? Object.keys(value) : [];
}

/**
 * Parse a package.json into its full declared-dependency-name set — deps,
 * devDeps, peerDeps, optionalDeps — plus Node.js built-ins (bare and
 * `node:`-prefixed). Returns undefined if the file can't be read/parsed, or
 * parses to something other than a JSON object.
 */
function _loadPackageDeps(pkgPath: string): Set<string> | undefined {
	try {
		const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
		if (!isJsonObject(pkg)) return undefined;
		const deps = new Set<string>([
			..._depFieldNames(pkg.dependencies),
			..._depFieldNames(pkg.devDependencies),
			..._depFieldNames(pkg.peerDependencies),
			..._depFieldNames(pkg.optionalDependencies),
		]);
		for (const mod of NODE_BUILTIN_MODULES) {
			deps.add(mod);
			deps.add(`node:${mod}`);
		}
		return deps;
	} catch {
		return undefined;
	}
}

/**
 * Walk upward from `startDir` (max 5 levels) for the nearest package.json,
 * returning its resolved dependency set. Cached per directory since this
 * runs once per checked file. A package.json that exists but fails to parse
 * stops the walk immediately (matches the pre-decomposition behavior: it
 * does not keep searching parent directories past a broken package.json).
 */
function _resolvePackageDeps(startDir: string): Set<string> | undefined {
	let pkgDir = startDir;
	for (let i = 0; i < 5; i++) {
		const cached = _pkgDepsCache.get(pkgDir);
		if (cached) return cached;

		const pkgPath = join(pkgDir, "package.json");
		if (existsSync(pkgPath)) {
			const deps = _loadPackageDeps(pkgPath);
			if (deps) _pkgDepsCache.set(pkgDir, deps);
			return deps;
		}

		const parent = dirname(pkgDir);
		if (parent === pkgDir) return undefined;
		pkgDir = parent;
	}
	return undefined;
}

/**
 * Decide whether a bare import specifier names a package missing from the
 * resolved dependency set. Relative imports, path aliases (`@/`), fragment
 * imports (`#`), and runtime built-in protocols (node:/cloudflare:/bun:/deno:)
 * are never "extraneous" and are excluded up front.
 */
function _isExtraneousBareImport(specifier: string, pkgDeps: Set<string>): boolean {
	if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("#"))
		return false;
	// node:, cloudflare:, bun:, deno: are runtime built-in protocols — never in package.json
	if (/^(node|cloudflare|bun|deno):/.test(specifier)) return false;

	// Extract package name (handle scoped packages @org/pkg)
	const pkgName = specifier.startsWith("@")
		? specifier.split("/").slice(0, 2).join("/")
		: nonNull(specifier.split("/")[0]);
	return !pkgDeps.has(pkgName);
}

export function checkExtraneousDependencies(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const pkgDeps = _resolvePackageDeps(dirname(filePath));
	if (!pkgDeps) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(strippedLines[i]).trim();
		if (!/^import\s/.test(trimmed) && !/\brequire\s*\(/.test(trimmed)) continue;

		// Specifier comes from the ORIGINAL line — see the note in
		// `checkSelfImport`. Reading it from the stripped line made `fromMatch`
		// permanently null, so this detector never fired either.
		const fromMatch = nonNull(originalLines[i]).match(
			/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/,
		);
		if (!fromMatch) continue;
		const specifier = nonNull(fromMatch[1]);

		if (!_isExtraneousBareImport(specifier, pkgDeps)) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

// --- 2b. Phantom Dependency Detection (Supply Chain) ---

/**
 * Detect phantom dependencies: packages listed in `dependencies` but never
 * imported/required by any source file in the project. A key indicator of
 * supply chain attacks — e.g., the axios@1.14.1 compromise added
 * 'plain-crypto-js' as a phantom dependency whose sole purpose was running
 * a malicious postinstall script.
 *
 * Only checks `dependencies` (not devDependencies, which are often CLI tools).
 * Skips @types/* packages and known non-imported patterns.
 */
export function checkPhantomDependencies(pkgJsonPath: string): InlineMatch[] {
	if (!existsSync(pkgJsonPath)) return [];

	let content: string;
	let parsed: unknown;
	try {
		content = readFileSync(pkgJsonPath, "utf-8");
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	// A syntactically valid but non-object top-level value (e.g. `null`) used
	// to reach `pkg.dependencies` UNCAUGHT below — that property read sits
	// after the try/catch closes, so a `null` package.json crashed this
	// function outright instead of returning [].
	if (!isJsonObject(parsed)) return [];

	const deps = isJsonObject(parsed.dependencies) ? parsed.dependencies : undefined;
	if (!deps) return [];

	const depNames = Object.keys(deps);
	if (depNames.length === 0) return [];

	// Workspace-aware search root: in a monorepo, deps declared in
	// `packages/foo/package.json` may be imported from `packages/bar/`.
	// Scoping the grep to the immediate package dir produces false-positive
	// "phantom dep" warnings on every monorepo, training agents to ignore
	// the warning by the time a real supply-chain phantom shows up.
	const searchRoot = findWorkspaceRootFor(pkgJsonPath);
	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (const dep of depNames) {
		if (matches.length >= 10) break;
		const finding = _phantomDependencyFinding(dep, searchRoot, lines);
		if (finding) matches.push(finding);
	}

	return matches;
}

/**
 * Decide whether a single dependency is a phantom dependency and, if so,
 * build its finding. Returns null for `@types/*` packages (type-only, never
 * imported at runtime) and for any dependency that IS referenced in project
 * source.
 */
function _phantomDependencyFinding(
	dep: string,
	searchRoot: string,
	lines: string[],
): InlineMatch | null {
	// Skip @types/* (type-only, never imported at runtime)
	if (dep.startsWith("@types/")) return null;
	if (_isDepReferencedInProject(dep, searchRoot)) return null;

	const lineIdx = lines.findIndex((l) => l.includes(`"${dep}"`));
	return {
		line: lineIdx >= 0 ? lineIdx + 1 : 1,
		text: `Phantom dependency: "${dep}" is in dependencies but never referenced in project source. Supply chain risk — dependencies should be imported somewhere.`,
	};
}

/**
 * Walk upward from a `package.json` looking for a workspace marker:
 * `pnpm-workspace.yaml`, or a parent `package.json` with a `workspaces`
 * field. Returns the workspace root if found, otherwise the immediate
 * package directory. Capped at 8 levels so we don't escape into the user's
 * home directory on a stray invocation.
 *
 * Matters for phantom-dep / cross-package import checks: in a monorepo,
 * scoping the source-search to a single package is the failure mode.
 */
export function findWorkspaceRootFor(pkgJsonPath: string): string {
	const startDir = dirname(pkgJsonPath);
	let dir = startDir;
	for (let i = 0; i < 8; i++) {
		const parent = dirname(dir);
		if (parent === dir) break;
		if (existsSync(join(parent, "pnpm-workspace.yaml"))) {
			return parent;
		}
		const parentPkg = join(parent, "package.json");
		if (existsSync(parentPkg)) {
			try {
				const raw = readFileSync(parentPkg, "utf-8");
				const json: unknown = JSON.parse(raw);
				if (isJsonObject(json) && json.workspaces !== undefined) return parent;
			} catch {
				// Best-effort — unreadable parent package.json doesn't decide the question.
			}
		}
		dir = parent;
	}
	return startDir;
}

/**
 * Check if a dependency name appears anywhere in the project's source files
 * (excluding node_modules, lock files, and package.json itself).
 * Uses grep -rqI for fast short-circuit search.
 */
function _isDepReferencedInProject(depName: string, projectDir: string): boolean {
	try {
		execFileSync(
			"grep",
			[
				"-rqI",
				"--exclude-dir=node_modules",
				"--exclude-dir=.git",
				"--exclude-dir=dist",
				"--exclude-dir=build",
				"--exclude-dir=.next",
				"--exclude-dir=coverage",
				"--exclude=package.json",
				"--exclude=package-lock.json",
				"--exclude=yarn.lock",
				"--exclude=pnpm-lock.yaml",
				"--exclude=bun.lockb",
				depName,
				projectDir,
			],
			{ timeout: 5000, stdio: "pipe" },
		);
		return true; // exit 0 = found
	} catch {
		return false; // exit 1 = not found, or timeout
	}
}
