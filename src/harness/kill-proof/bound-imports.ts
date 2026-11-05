// ===========================================
// Kill proof — the named tests' local import closure (review K11/K13)
// ===========================================
// A kill is a property of the test file AND every helper it reaches: weaken an
// imported `expectClamped()` helper and the proof no longer describes the test.
// So each named test's STATIC imports are followed transitively within the
// project and every reached file is bound by sha256, with the named tests that
// reach it (`importedBy`), so a changed helper stales exactly the tests that
// import it (per-file certification, K13).
//
// Not followed: bare specifiers (packages, tsconfig aliases), anything under
// `node_modules` or outside the root, type-only imports (erased at runtime, as
// `fail-before-fix subjectChanged` treats them), dynamic `import()` / `require()`,
// and the mutated source itself (bound as `source`; its own imports are not
// walked). A factory-less `vi.mock("./x")` / `vi.doMock("./x")` binds the
// `__mocks__/x` twin vitest substitutes when one exists beside the target (a
// bare specifier's twin lives at `<root>/__mocks__/<name>`); a mock with a
// factory keeps its replacement in the calling file, which is bound anyway
// (round 5, R5-4). The config's `setupFiles` / `globalSetup` are walked as
// GLOBAL roots: every file they reach is bound with `importedBy` = every named
// test, since a setup file runs before all of them (round 5, R5-5). The walk
// stops after MAX_BOUND_IMPORTS files and SAYS so: a cut closure is recorded on
// the receipt and never certifies (round 5, R5-3).

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getExtension, JS_TS_EXTS } from "../checks/shared.js";
import { parseImports } from "../project-graph/parser-imports.js";
import { resolveImportPath } from "../project-graph/resolve.js";
import { hashFile } from "./receipt.js";
import type { BoundImport } from "./types.js";

export const MAX_BOUND_IMPORTS = 200;

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The specifier appears in a static `import … from` / side-effect `import "…"` / `export … from` form, not type-only. */
function isStaticRuntimeSpecifier(content: string, specifier: string): boolean {
	const quoted = `['"]${escapeRe(specifier)}['"]`;
	const fromForm = new RegExp(`(?:^|[\\n;])\\s*(import|export)\\s+(?!type\\s)[^;'"]*?\\bfrom\\s*${quoted}`);
	const sideEffect = new RegExp(`(?:^|[\\n;])\\s*import\\s*${quoted}`);
	return fromForm.test(content) || sideEffect.test(content);
}

/** `export … from "./x"` re-exports (parseImports reads `import` lines only); `export type … from` is erased. */
function reExportSpecifiers(content: string): string[] {
	return [...content.matchAll(/(?:^|[\n;])\s*export\s+(?!type\s)(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)].map(m => m[1] ?? "").filter(Boolean);
}

/** Relative runtime specifiers a file imports statically. */
export function staticLocalSpecifiers(content: string, fromAbs: string): string[] {
	const fromImports = parseImports(content, fromAbs).filter(edge => !edge.isTypeOnly).map(edge => edge.specifier);
	const out: string[] = [];
	for (const specifier of [...fromImports, ...reExportSpecifiers(content)]) {
		if (!specifier.startsWith(".") || out.includes(specifier)) continue;
		if (isStaticRuntimeSpecifier(content, specifier)) out.push(specifier);
	}
	return out;
}

function insideProject(root: string, abs: string): string | null {
	const rel = relative(root, abs).replace(/\\/g, "/");
	if (!rel || rel.startsWith("..") || rel.split("/").includes("node_modules")) return null;
	return rel;
}

function readCode(root: string, rel: string): string | null {
	const abs = join(root, rel);
	if (!JS_TS_EXTS.has(getExtension(rel)) || !existsSync(abs) || !statSync(abs).isFile()) return null;
	try {
		return readFileSync(abs, "utf8");
	} catch {
		return null;
	}
}

/** Specifiers of factory-less `vi.mock(…)` / `vi.doMock(…)` calls: the ones vitest answers from a `__mocks__` twin. */
export function factorylessMockSpecifiers(content: string): string[] {
	return [...content.matchAll(/\bvi\.(?:mock|doMock)\(\s*(['"])([^'"\n]+)\1\s*\)/g)].map(m => m[2] ?? "").filter(Boolean);
}

/**
 * The `__mocks__` twin vitest substitutes for a factory-less mock: beside the resolved target for a relative
 * specifier (`./helpers/check` → `helpers/__mocks__/check.*`), under the project root for a bare one
 * (`<root>/__mocks__/<name>.*`). Null when none exists.
 */
function mockTwinOf(root: string, fromAbs: string, specifier: string): string | null {
	if (specifier.startsWith(".")) {
		const target = resolveImportPath(fromAbs, specifier);
		if (target === null) return null;
		const name = specifier.slice(specifier.lastIndexOf("/") + 1);
		return resolveImportPath(target, `./__mocks__/${name}`);
	}
	if (specifier.startsWith("/")) return null;
	return resolveImportPath(join(root, "package.json"), `./__mocks__/${specifier}`);
}

/** Repo-relative files `file` loads at runtime by a relative specifier (static imports, re-exports and factory-less
 *  mock twins) that resolve inside the project. */
function localImportsOf(root: string, file: string): string[] {
	const content = readCode(root, file);
	if (content === null) return [];
	const fromAbs = join(root, file);
	const out: string[] = [];
	const targets = [
		...staticLocalSpecifiers(content, fromAbs).map(specifier => resolveImportPath(fromAbs, specifier)),
		...factorylessMockSpecifiers(content).map(specifier => mockTwinOf(root, fromAbs, specifier)),
	];
	for (const target of targets) {
		const rel = target === null ? null : insideProject(root, target);
		if (rel !== null && !out.includes(rel)) out.push(rel);
	}
	return out;
}

/**
 * The named tests whose static RELATIVE import closure reaches `file` (round-4 M3). A relative import resolves
 * inside whichever tree runs the test, so such a test loads the COPY's file; an absolute path, an alias, a mock
 * or a dynamic import gives no such guarantee and is not counted. Same walk and cap as the bound closure.
 */
export function testsReachingByRelativeImport(root: string, tests: readonly string[], file: string, cap = MAX_BOUND_IMPORTS): Set<string> {
	const reaching = new Set<string>();
	for (const test of tests) {
		const seen = new Set<string>([test]);
		const queue = [test];
		while (queue.length > 0 && !reaching.has(test)) {
			const current = queue.shift() as string;
			for (const rel of localImportsOf(root, current)) {
				if (rel === file) { reaching.add(test); break; }
				if (seen.has(rel) || seen.size > cap) continue;
				seen.add(rel);
				queue.push(rel);
			}
		}
	}
	return reaching;
}

export interface BoundClosure {
	/** Hashed, sorted by path; the roots and `mutatedFile` are never listed. */
	files: BoundImport[];
	/** True when the walk stopped at `cap` with files still unvisited: the receipt then binds LESS than the tests load (R5-3). */
	truncated: boolean;
}

export interface BoundClosureOptions {
	cap?: number;
	/** Files that run before every named test (`setupFiles` / `globalSetup`): what they reach is bound for every test (R5-5). */
	globalRoots?: readonly string[];
}

/**
 * The local import closure of `tests` (and of `globalRoots`, credited to every test), hashed, sorted by path;
 * the roots and `mutatedFile` are never listed. At most `cap` files are bound, and a cut is reported.
 */
export function boundImportClosureDetailed(root: string, tests: readonly string[], mutatedFile: string, options: BoundClosureOptions = {}): BoundClosure {
	const cap = options.cap ?? MAX_BOUND_IMPORTS, globalRoots = options.globalRoots ?? [];
	const importers = new Map<string, Set<string>>();
	const excluded = new Set([...tests, ...globalRoots, mutatedFile]);
	let truncated = false;
	const walk = (start: string, creditedTo: readonly string[]): void => {
		const seen = new Set<string>([start]);
		const queue = [start];
		while (queue.length > 0) {
			const file = queue.shift() as string;
			for (const rel of localImportsOf(root, file)) {
				if (seen.has(rel) || excluded.has(rel)) continue;
				if (!importers.has(rel) && importers.size >= cap) { truncated = true; continue; }
				seen.add(rel);
				const by = importers.get(rel) ?? new Set<string>();
				for (const test of creditedTo) by.add(test);
				importers.set(rel, by);
				queue.push(rel);
			}
		}
	};
	for (const test of tests) walk(test, [test]);
	for (const setup of globalRoots) walk(setup, tests);
	const files = [...importers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([path, by]) => {
		const hashed = hashFile(root, path);
		return hashed === null ? [] : [{ ...hashed, importedBy: [...by].sort() }];
	});
	return { files, truncated };
}

/** `boundImportClosureDetailed(…).files`: the bound files alone (the cut, when any, is not reported here). */
export function boundImportClosure(root: string, tests: readonly string[], mutatedFile: string, cap = MAX_BOUND_IMPORTS): BoundImport[] {
	return boundImportClosureDetailed(root, tests, mutatedFile, { cap }).files;
}
