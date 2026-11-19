// ===========================================
// Check Command — broken-imports exemptions
// ===========================================
// Pure path rules that give an import edge "no verdict" in the broken-imports
// scan (check-import-edges.ts). Each rule names a place where an unresolved or
// unmatched import is expected: an install output, an empty submodule
// directory, a test fixture or template, a compiled twin of a TypeScript source.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { resolveImportPath } from "../harness/project-graph/resolve.js";
import { sourceRole } from "../lib/metrics/inventory-roles.js";

/** `node_modules` as a whole path segment of an import specifier. */
export function hasNodeModulesSegment(specifier: string): boolean {
	return specifier.split("/").includes("node_modules");
}

/**
 * A directory segment that marks test input or a template: `fixtures`,
 * `__fixtures__`, `fixture`, `testdata`, `test-data`, `template`, `templates`,
 * or one of them after a `-`, `_` or `.` (`check-parser-fixtures`).
 */
const FIXTURE_SEGMENT_RE = /^(?:__fixtures__|(?:.*[-_.])?(?:fixtures?|testdata|test-data|templates?))$/i;

/** True when a DIRECTORY segment of `path` (never the file name) marks a fixture or template. */
export function isFixtureOrTemplatePath(path: string): boolean {
	const segments = path.split(/[\\/]/);
	return segments.slice(0, -1).some((segment) => FIXTURE_SEGMENT_RE.test(segment));
}

const DECLARATION_FILE_RE = /\.d\.[cm]?ts$/;

const SVELTEKIT_ROUTE_MODULE_RE = /^\+[\w.[\]()-]+\.[cm]?[jt]s$/;
const SVELTEKIT_TYPES_SPECIFIER_RE = /^\.\/\$types(?:\.js|\.ts|\.d\.ts)?$/;

/**
 * True for the specifier `./$types` (also `./$types.js`, `./$types.ts`,
 * `./$types.d.ts`) written in a SvelteKit route module (a `+page.ts`,
 * `+layout.server.ts`, `+server.ts` and the like). `svelte-kit sync` generates
 * that file into `.svelte-kit/types/` and `.svelte-kit/tsconfig.json` reaches it
 * through `rootDirs`, so it is never on disk beside the route. A `$types`
 * specifier from any other file, or any other `$` specifier, is still judged.
 */
export function isSvelteKitGeneratedTypes(importerPath: string, specifier: string): boolean {
	if (!SVELTEKIT_TYPES_SPECIFIER_RE.test(specifier)) return false;
	return SVELTEKIT_ROUTE_MODULE_RE.test(importerPath.split(/[\\/]/).pop() ?? "");
}

/**
 * True when the importer is not product source: a fixture or template
 * directory, or a role the metrics inventory (`sourceRole`) already calls
 * fixture (`evals/`, `bench/`, `benchmarks/`, `scratch/`, ...), vendor or
 * generated. Benchmark tasks and templates are copied into a worktree before
 * they run, so their relative imports cannot resolve in place. A declaration
 * file stays product source: its imports are real even when it is generated.
 */
export function isNonProductImporter(path: string): boolean {
	if (isFixtureOrTemplatePath(path)) return true;
	const role = sourceRole(path);
	return role === "fixture" || role === "vendor" || (role === "generated" && !DECLARATION_FILE_RE.test(path));
}

/** The `path = ...` entries of a `.gitmodules` file, or none when unreadable. */
function submodulePaths(gitmodules: string): string[] {
	try {
		const paths: string[] = [];
		for (const line of readFileSync(gitmodules, "utf-8").split("\n")) {
			const match = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
			if (match?.[1] !== undefined) paths.push(match[1].replace(/\/+$/, ""));
		}
		return paths;
	} catch {
		return [];
	}
}

/**
 * True when `target` lies inside a submodule path listed by a `.gitmodules`
 * file of an ancestor directory. A clone without `--recurse-submodules` leaves
 * that directory empty, so a missing file there proves nothing.
 */
export function isInsideGitSubmodule(target: string): boolean {
	for (let dir = dirname(target); ; dir = dirname(dir)) {
		const gitmodules = join(dir, ".gitmodules");
		if (existsSync(gitmodules)) {
			const inside = submodulePaths(gitmodules).some((path) => {
				const base = resolve(dir, path);
				return target === base || target.startsWith(base + sep);
			});
			if (inside) return true;
		}
		if (dirname(dir) === dir) return false;
	}
}

const RELATIVE_AUGMENTATION_RE = /\bdeclare\s+module\s+['"](\.{1,2}\/[^'"]*)['"]/g;

/**
 * The files that a `declare module '<relative specifier>'` block in any of
 * `files` augments (the specifier is read from the declaring file; a `.js`
 * specifier maps to its `.ts` source). TypeScript merges the block's names into
 * the target, so the target's own export list is incomplete. This chooses the
 * cheap rule: such a target gets no missing-symbol verdict, and the names inside
 * the block are not read.
 */
export function augmentedModuleTargets(files: readonly string[]): Set<string> {
	const targets = new Set<string>();
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		if (!text.includes("declare")) continue;
		for (const match of text.matchAll(RELATIVE_AUGMENTATION_RE)) {
			const resolved = resolveImportPath(file, match[1] as string);
			if (resolved !== null) targets.add(typeScriptSourceOf(resolved) ?? resolved);
		}
	}
	return targets;
}

const TYPESCRIPT_TWIN: Record<string, string> = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts", ".jsx": ".tsx" };

/**
 * The TypeScript source that sits beside a compiled `.js`/`.mjs`/`.cjs`/`.jsx`
 * file, or null. TypeScript resolves a JavaScript specifier to that source
 * first, so the compiled twin (often an empty `export {}` for a types-only
 * module) says nothing about the module's exports.
 */
export function typeScriptSourceOf(file: string): string | null {
	const dot = file.lastIndexOf(".");
	const twinExtension = dot === -1 ? undefined : TYPESCRIPT_TWIN[file.slice(dot)];
	if (twinExtension === undefined) return null;
	const twin = file.slice(0, dot) + twinExtension;
	if (existsSync(twin)) return twin;
	return file.endsWith(".js") && existsSync(`${file.slice(0, dot)}.tsx`) ? `${file.slice(0, dot)}.tsx` : null;
}

const DECLARATION_TWIN: Record<string, string> = { ".js": ".d.ts", ".jsx": ".d.ts", ".mjs": ".d.mts", ".cjs": ".d.cts" };

/**
 * The declaration file (`x.d.ts`, `x.d.mts`, `x.d.cts`) that sits beside a
 * `x.js`/`x.jsx`/`x.mjs`/`x.cjs` file, or null. TypeScript takes the types of a
 * JavaScript module from that declaration file, so the JavaScript body says
 * nothing about the names a TypeScript importer may use. This holds for the
 * extensionless specifier too (`./Button`): TypeScript tries `Button.ts`,
 * `Button.tsx` and `Button.d.ts` before it looks at `Button.jsx`.
 */
export function declarationFileOf(file: string): string | null {
	const dot = file.lastIndexOf(".");
	const twinExtension = dot === -1 ? undefined : DECLARATION_TWIN[file.slice(dot)];
	if (twinExtension === undefined) return null;
	const twin = file.slice(0, dot) + twinExtension;
	return existsSync(twin) ? twin : null;
}
