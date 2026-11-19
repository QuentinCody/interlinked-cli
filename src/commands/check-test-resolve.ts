// ===========================================
// Check Command — resolve a test file's imports to product modules
// ===========================================
// Static, name-based resolution against the tracked module list. Nothing is executed and no config file is evaluated.
// Python: a dotted name matches a module whose dotted path ends with it, component by component (`pkg.sub.mod` matches
// `src/pkg/sub/mod.py`); relative imports resolve against the test file's directory. A `from a import b` credits `a.b` when it
// is a module. JS and TS: relative specifiers (extension swap, directory index) and alias-prefixed or root-relative paths
// (`@/`, `~/`, `$lib/`, `src/x`) by path suffix. Not resolved: package names, workspace package imports, tsconfig `paths`,
// re-exports through a barrel or `__init__` (the barrel is credited, not the module behind it).
// A name that matches several modules is ambiguous: the module at the exact root path wins, then the one nearest to the test
// file, and a tie credits all of them (the scan errs toward silence). Each ambiguous name is counted.

import { posix } from "node:path";
import { jsImportRefs, type JsReexport, jsReexports, type PythonImports, pythonImports } from "./check-test-imports.js";

export interface Resolved { modules: Set<string>; unresolved: number; ambiguous: number; }
const emptyResolved = (): Resolved => ({ modules: new Set(), unresolved: 0, ambiguous: 0 });

/** Number of leading directory components that two paths share. */
function commonDirs(a: string, b: string): number {
	const left = posix.dirname(a).split("/"), right = posix.dirname(b).split("/");
	let shared = 0;
	while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
	return shared;
}

/** Pick the matches that win: the nearest to the test file; a tie keeps all. */
function nearest(matches: readonly string[], testPath: string): string[] {
	const best = Math.max(...matches.map((match) => commonDirs(match, testPath)));
	return matches.filter((match) => commonDirs(match, testPath) === best);
}

function suffixes(parts: readonly string[], joiner: string): string[] {
	return parts.map((_, index) => parts.slice(index).join(joiner));
}

function pick(matches: readonly string[], exact: (path: string) => boolean, testPath: string, into: Resolved): void {
	if (matches.length === 0) return;
	if (matches.length > 1) into.ambiguous += 1;
	const exactOnes = matches.filter(exact);
	const chosen = exactOnes.length > 0 ? exactOnes : matches.length > 1 ? nearest(matches, testPath) : matches;
	for (const path of chosen) into.modules.add(path);
}

// ---- Python ----

export interface PythonIndex {
	bySuffix: Map<string, string[]>; paths: Set<string>; components: Set<string>;
	/** Package `__init__.py` files by the dotted suffixes of their directory. */
	packages: Map<string, string[]>;
	initSet: Set<string>;
	readInit: (path: string) => string | null;
	parsedInits: Map<string, PythonImports>;
}

const pythonParts = (path: string): string[] => path.replace(/\.py$/, "").split("/");
const MAX_REEXPORT_HOPS = 3;

/** `modules` are the product modules; `inits` the package `__init__.py` files, read through `readInit` to follow re-exports. */
export function pythonModuleIndex(modules: readonly string[], inits: readonly string[] = [], readInit: (path: string) => string | null = () => null): PythonIndex {
	const index: PythonIndex = { bySuffix: new Map(), paths: new Set(modules), components: new Set(), packages: new Map(), initSet: new Set(inits), readInit, parsedInits: new Map() };
	for (const path of modules) {
		const parts = pythonParts(path);
		for (const part of parts) index.components.add(part);
		for (const suffix of suffixes(parts, ".")) index.bySuffix.set(suffix, [...(index.bySuffix.get(suffix) ?? []), path]);
	}
	for (const path of inits) {
		const parts = path.split("/").slice(0, -1);
		for (const part of parts) index.components.add(part);
		for (const suffix of suffixes(parts, ".")) index.packages.set(suffix, [...(index.packages.get(suffix) ?? []), path]);
	}
	return index;
}

function parsedInit(index: PythonIndex, path: string): PythonImports {
	let parsed = index.parsedInits.get(path);
	if (parsed === undefined) {
		const text = index.readInit(path);
		parsed = text === null ? { absolute: [], relative: [], dotted: [] } : pythonImports(text);
		index.parsedInits.set(path, parsed);
	}
	return parsed;
}

const exportsName = (names: readonly string[], name: string): boolean => names.length === 0 || names.includes(name);

/** The module (or package `__init__`) that a relative import inside `initPath` points to, for `name`. */
function reexportTargets(index: PythonIndex, initPath: string, name: string): { modules: string[]; packages: string[] } {
	const found = { modules: [] as string[], packages: [] as string[] }, dir = initPath.split("/").slice(0, -1);
	const parsed = parsedInit(index, initPath);
	for (const rel of parsed.relative) {
		const path = relativeTarget(dir, rel, name);
		if (path === null) continue;
		if (index.paths.has(`${path}.py`)) found.modules.push(`${path}.py`);
		else if (index.initSet.has(`${path}/__init__.py`)) found.packages.push(`${path}/__init__.py`);
	}
	for (const abs of parsed.absolute.filter((entry) => exportsName(entry.names, name))) {
		found.modules.push(...(index.bySuffix.get(abs.module) ?? []));
		found.packages.push(...(index.packages.get(abs.module) ?? []));
	}
	return found;
}

/** The path (no extension) that `from <dots><module> import ...` inside a package at `dir` names for `name`, or null when it does not export it. */
function relativeTarget(dir: readonly string[], rel: PythonImports["relative"][number], name: string): string | null {
	const base = dir.slice(0, Math.max(0, dir.length - (rel.level - 1)));
	if (rel.module === "") return rel.names.includes(name) ? [...base, name].join("/") : null;
	return exportsName(rel.names, name) ? [...base, ...rel.module.split(".")].join("/") : null;
}

/** Follow `from .x import name` re-exports of a package, up to a few hops. */
function followReexport(index: PythonIndex, initPath: string, name: string, into: Resolved, seen: Set<string>, hops: number): boolean {
	if (hops > MAX_REEXPORT_HOPS || seen.has(initPath)) return false;
	seen.add(initPath);
	const targets = reexportTargets(index, initPath, name);
	for (const module of targets.modules) into.modules.add(module);
	let credited = targets.modules.length > 0;
	for (const next of targets.packages) credited = followReexport(index, next, name, into, seen, hops + 1) || credited;
	return credited;
}

function lookupPython(index: PythonIndex, name: string, testPath: string, into: Resolved): boolean {
	const matches = index.bySuffix.get(name) ?? [];
	pick(matches, (path) => pythonParts(path).join(".") === name, testPath, into);
	return matches.length > 0;
}

function resolveRelative(index: PythonIndex, testPath: string, level: number, module: string, names: readonly string[], into: Resolved): void {
	const testDir = posix.dirname(testPath) === "." ? [] : posix.dirname(testPath).split("/");
	const base = testDir.slice(0, Math.max(0, testDir.length - (level - 1)));
	const modulePath = [...base, ...(module === "" ? [] : module.split("."))].join("/");
	for (const candidate of [modulePath, ...names.map((name) => (modulePath === "" ? name : `${modulePath}/${name}`))]) {
		if (candidate !== "" && index.paths.has(`${candidate}.py`)) into.modules.add(`${candidate}.py`);
	}
}

/** The longest dotted prefix of a `patch("a.b.c.d")` target that is a module. */
function resolveDotted(index: PythonIndex, dotted: string, testPath: string, into: Resolved): void {
	const parts = dotted.split(".");
	for (let length = parts.length; length >= 1; length -= 1) {
		if (lookupPython(index, parts.slice(0, length).join("."), testPath, into)) return;
	}
}

/** `pkg.name` uses of a plain `import pkg` (or `import pkg as p`): the attribute names the test takes from the module. */
function attributeNames(text: string, binding: string): string[] {
	const escaped = binding.replace(/\./g, "\\.");
	return [...new Set([...text.matchAll(new RegExp(`(?<![\\w.])${escaped}\\.([A-Za-z_]\\w*)`, "g"))].map((match) => match[1] ?? ""))];
}

/** The product modules that a Python test file imports. */
export function resolvePythonImports(index: PythonIndex, testPath: string, text: string): Resolved {
	const result = emptyResolved(), imports = pythonImports(text);
	for (const { module, names, alias } of imports.absolute) {
		const taken = names.length > 0 ? names : attributeNames(text, alias ?? module);
		const found = [module, ...taken.map((name) => `${module}.${name}`)].map((name) => lookupPython(index, name, testPath, result));
		const reexported = taken.filter((_name, at) => !found[1 + at]).map((name) => (index.packages.get(module) ?? []).map((init) => followReexport(index, init, name, result, new Set(), 0)).some(Boolean));
		if (!found.some(Boolean) && !reexported.some(Boolean) && index.components.has(module.split(".")[0] ?? "")) result.unresolved += 1;
	}
	for (const { level, module, names } of imports.relative) resolveRelative(index, testPath, level, module, names, result);
	for (const dotted of imports.dotted) resolveDotted(index, dotted, testPath, result);
	return result;
}

// ---- JavaScript and TypeScript ----

export interface JsIndex {
	exact: Map<string, string>; bySuffix: Map<string, string[]>;
	/** Directory index files (`index.ts`): not modules themselves; an import of one credits what it re-exports. */
	barrels: Set<string>;
	read: (path: string) => string | null;
	reexports: Map<string, JsReexport[]>;
}
const MAX_BARREL_HOPS = 2;

const JS_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const NON_CODE_EXT = /\.(?:css|scss|sass|less|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|md|txt|html|wasm)$/i;
const ALIAS_PREFIX = /^(?:@|~|\$lib|#)\//;

/** The path without its extension, and a directory index without `/index`. */
function extensionless(path: string): string {
	const bare = path.replace(JS_EXT, "");
	return bare.endsWith("/index") ? bare.slice(0, -"/index".length) : bare;
}

/** `modules` are the product modules; `barrels` the directory index files, read through `read` to follow their re-exports. */
export function jsModuleIndex(modules: readonly string[], barrels: readonly string[] = [], read: (path: string) => string | null = () => null): JsIndex {
	const index: JsIndex = { exact: new Map(), bySuffix: new Map(), barrels: new Set(barrels), read, reexports: new Map() };
	for (const path of [...modules, ...barrels]) {
		const key = extensionless(path);
		if (!index.exact.has(key) || !path.includes("/index.")) index.exact.set(key, path);
		for (const suffix of suffixes(key.split("/"), "/")) index.bySuffix.set(suffix, [...(index.bySuffix.get(suffix) ?? []), path]);
	}
	return index;
}

function reexportsOf(index: JsIndex, path: string): JsReexport[] {
	let found = index.reexports.get(path);
	if (found === undefined) {
		const text = index.read(path);
		found = text === null ? [] : jsReexports(text);
		index.reexports.set(path, found);
	}
	return found;
}

/** Credit the modules that a barrel re-exports under the imported `names` (null = every name); star re-exports pass the names on. */
function followBarrel(index: JsIndex, barrel: string, names: readonly string[] | null, into: Resolved, seen: Set<string>, hops: number): void {
	if (hops > MAX_BARREL_HOPS || seen.has(barrel)) return;
	seen.add(barrel);
	for (const reexport of reexportsOf(index, barrel).filter((entry) => reexportTakes(entry, names))) {
		const target = emptyResolved();
		resolveSpec(index, reexport.spec, barrel, target);
		for (const path of target.modules) {
			if (index.barrels.has(path)) followBarrel(index, path, reexport.exported === "*" ? names : null, into, seen, hops + 1);
			else into.modules.add(path);
		}
	}
}

/** True when a re-export can supply one of the imported names (any re-export does when the whole module is imported). */
function reexportTakes(reexport: JsReexport, names: readonly string[] | null): boolean {
	return reexport.exported === "*" || names === null || reexport.exported.some((name) => names.includes(name));
}

function resolveSpec(index: JsIndex, spec: string, testPath: string, into: Resolved): void {
	if (spec.startsWith("node:") || (NON_CODE_EXT.test(spec) && !JS_EXT.test(spec))) return;
	if (spec.startsWith(".")) {
		const hit = index.exact.get(extensionless(posix.normalize(posix.join(posix.dirname(testPath), spec))));
		if (hit === undefined) into.unresolved += 1; else into.modules.add(hit);
		return;
	}
	if (spec.startsWith("@") && !ALIAS_PREFIX.test(spec)) { resolveScoped(index, spec, testPath, into); return; }
	if (!ALIAS_PREFIX.test(spec) && !spec.includes("/")) return;
	const key = extensionless(spec.replace(ALIAS_PREFIX, ""));
	pick(index.bySuffix.get(key) ?? [], (path) => extensionless(path) === key, testPath, into);
}

/**
 * `@scope/rest/of/path`: a workspace alias such as `@api/services/x` or `@cio/db/queries/y`. The scope is dropped, then up to two
 * leading components (a package directory), and the rest must keep two components and match a module path by suffix.
 */
function resolveScoped(index: JsIndex, spec: string, testPath: string, into: Resolved): void {
	const parts = extensionless(spec).split("/").slice(1);
	for (let drop = 0; drop <= 2 && parts.length - drop >= 2; drop += 1) {
		const key = parts.slice(drop).join("/"), matches = index.bySuffix.get(key) ?? [];
		if (matches.length === 0) continue;
		pick(matches, (path) => extensionless(path) === key, testPath, into);
		return;
	}
}

/** The product modules that a JS or TS test file imports, requires or mocks. */
export function resolveJsImports(index: JsIndex, testPath: string, text: string): Resolved {
	const result = emptyResolved();
	for (const ref of jsImportRefs(text)) {
		const found = emptyResolved();
		resolveSpec(index, ref.spec, testPath, found);
		result.unresolved += found.unresolved;
		result.ambiguous += found.ambiguous;
		for (const path of found.modules) {
			if (index.barrels.has(path)) followBarrel(index, path, ref.names, result, new Set(), 0);
			else result.modules.add(path);
		}
	}
	return result;
}
