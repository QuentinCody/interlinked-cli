// ===========================================
// Check Command — broken-imports scan
// ===========================================
// Judges each import edge of the project graph: a missing target file, a
// relative import that resolves to nothing, or a named import the target does
// not export. Every rule errs toward "no verdict": the scan runs on foreign
// trees where a false finding costs more than a missed one.
//
// KNOWN GAPS: a default import is never checked against the target's default
// export (CommonJS interop and `export =` make that unsafe to judge); a named
// import from a target in a skipped directory (build/, vendor/, ...) gets no
// verdict; the git-ignore test needs `git` on PATH and treats a non-repository
// as "nothing ignored". DELIBERATE BLIND SPOT: an importer that is not product
// source gets no verdict: a fixture or template directory (`fixtures`,
// `__fixtures__`, `testdata`, `templates`, `-fixtures` suffix) or a path that
// `sourceRole` calls fixture (`evals/`, `bench/`, `benchmarks/`, `scratch/`),
// vendor or generated (not a `.d.ts`), because such files are test inputs, are
// broken on purpose, or are copied into a worktree before they run. A file that
// live code imports is still judged. A relative specifier with a `node_modules`
// segment, and a missing target inside a git submodule path, get none either
// (install output; the clone left the submodule empty). A `x.js` target with a
// sibling `x.d.ts` is judged against the declaration file, which gives no
// verdict; so does a `x.jsx` target with a sibling `x.d.ts` (TypeScript picks
// the declaration file for `./x`). The specifier `./$types` in a SvelteKit
// route module (`+page.ts`, `+server.ts`, ...) gets none: `svelte-kit sync`
// generates it outside the source tree. KNOWN GAPS: a tracked file
// under a dot-directory that only an unrelated `.gitignore` names (`.source/`,
// written by a docs tool); a target in a tool `outdir` that no ignore rule names
// (paraglide `src/paraglide`); a target that a build script or a shell script
// copies into place (`dist/web`, a built test tree).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectGraph } from "../harness/project-graph.js";
import type { ImportEdge } from "../harness/types.js";
import {
	augmentedModuleTargets,
	declarationFileOf,
	hasNodeModulesSegment,
	isInsideGitSubmodule,
	isNonProductImporter,
	isSvelteKitGeneratedTypes,
	typeScriptSourceOf,
} from "./import-edge-exemptions.js";

const CJS_OR_EXPORT_EQUALS_RE =
	/\bmodule\.exports\b|\bexports\.[\w$]+\s*=|\bexports\[|^\s*export\s*=|Object\.defineProperty\(\s*exports/m;
const DECLARATION_FILE_RE = /\.d\.[cm]?ts$/;
/**
 * `export const A = 1,\n  B = 2` and `export const A = 1, B = 2` declare several names in one statement. The export
 * parser reads the first name only, so a missing name proves nothing.
 * Matches a top-level export declaration line that ends with a comma, or holds a second declarator after a comma.
 */
const MULTI_DECLARATOR_RE = /^export\s+(?:declare\s+)?(?:const|let|var)\s[^\n;]*(?:,\s*$|,\s*[\w$]+\s*(?::[^=,\n]+)?=)/m;

function isRelativeSpecifier(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..";
}

/** A JS/TS source extension on a specifier or path (`./App.jsx`, `x.mts`). */
const SOURCE_EXTENSION_RE = /\.[cm]?[jt]sx?$/;
/** Extensions a generated or compiled source may carry in an ignore rule (`/src/schema.ts`, `src/protocol.*`). */
const IGNORE_PROBE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** `App.tsx` and `App.d.ts` are sources of the stem `App`; `App.test.ts` is not. */
function isSourceOfStem(name: string, stem: string): boolean {
	if (!name.startsWith(`${stem}.`)) return false;
	const rest = name.slice(stem.length + 1);
	return !rest.includes(".") || rest === "d.ts";
}

/**
 * True when `target` exists on disk as written, any sibling is
 * `<name>.<anything>`, or — for a specifier that carries a source extension
 * (`./App.jsx`) — a sibling is the same stem under another single extension
 * (`App.tsx`): TypeScript resolves a `.js`/`.jsx` specifier to its `.ts`/`.tsx` source.
 */
function existsOnDiskUnderAnyExtension(target: string): boolean {
	if (existsSync(target)) return true;
	try {
		const name = basename(target);
		const stem = name.replace(SOURCE_EXTENSION_RE, "");
		return readdirSync(dirname(target)).some((sibling) => sibling.startsWith(`${name}.`) || isSourceOfStem(sibling, stem));
	} catch {
		return false;
	}
}

/**
 * Absolute path a RELATIVE import points at when the graph could not resolve it
 * and nothing exists there under any extension (so it is a candidate dangling
 * import). `null` for a resolved edge, a bare specifier, or an existing asset.
 */
export function unresolvedRelativeTarget(edge: ImportEdge): string | null {
	if (edge.toFile !== "" || !isRelativeSpecifier(edge.specifier)) return null;
	const withoutQuery = edge.specifier.replace(/[?#].*$/, "");
	const target = resolve(dirname(edge.fromFile), withoutQuery);
	return existsOnDiskUnderAnyExtension(target) ? null : target;
}

/** Nearest ancestor directory (inclusive) that holds a `.git` entry, or null. */
function gitRootFor(path: string): string | null {
	for (let dir = dirname(path); ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return null;
	}
}

/**
 * Every spelling git is asked about for one unresolved target:
 * - the path as written and with a trailing slash (a directory rule such as
 *   `lib/` matches an absent path only when the query ends in `/`);
 * - the stem under each source extension (an ignore rule often names the
 *   generated file itself: `/src/schema.ts`, `src/protocol.*`, while the import
 *   says `./schema` or `./protocol`).
 */
function ignoreQueries(path: string): string[] {
	const stem = path.replace(SOURCE_EXTENSION_RE, "");
	return [path, `${path}/`, ...IGNORE_PROBE_EXTENSIONS.map((ext) => `${stem}${ext}`)];
}

/** Ask git which of `paths` (all inside one repository at `root`) it ignores. */
function ignoredInRepo(root: string, paths: string[]): string[] {
	const owners = new Map<string, string[]>();
	for (const path of paths) {
		for (const query of ignoreQueries(path)) owners.set(query, [...(owners.get(query) ?? []), path]);
	}
	const run = spawnSync("git", ["check-ignore", "--stdin"], {
		cwd: root,
		input: [...owners.keys()].join("\n"),
		encoding: "utf-8",
		timeout: 10_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	// Exit 0 = some ignored, 1 = none ignored, 128 = fatal (not a repository,
	// path outside it). A fatal batch means "not ignored", never a finding.
	if (run.error || (run.status !== 0 && run.status !== 1)) return [];
	// git echoes each ignored query exactly as it was written on stdin.
	return run.stdout.split("\n").flatMap((line) => owners.get(line) ?? []);
}

/**
 * The subset of `paths` that git ignores. One `git check-ignore --stdin` call
 * per repository (the command exits 128 when handed several paths on its
 * command line, and for a path outside the repository).
 */
export function gitIgnoredPaths(paths: string[]): Set<string> {
	const byRoot = new Map<string, string[]>();
	for (const path of paths) {
		const root = gitRootFor(path);
		if (root === null) continue;
		byRoot.set(root, [...(byRoot.get(root) ?? []), path]);
	}
	const ignored = new Set<string>();
	for (const [root, group] of byRoot) {
		for (const path of ignoredInRepo(root, group)) ignored.add(path);
	}
	return ignored;
}

/** True when the target's export list may be incomplete, so a missing name proves nothing. */
function exportsAreOpaque(graph: ProjectGraph, file: string, seen: Set<string> = new Set()): boolean {
	if (seen.has(file)) return false;
	seen.add(file);
	if (DECLARATION_FILE_RE.test(file)) return true;
	try {
		const text = readFileSync(file, "utf-8");
		if (CJS_OR_EXPORT_EQUALS_RE.test(text) || MULTI_DECLARATOR_RE.test(text)) return true;
	} catch {
		return true;
	}
	// A barrel's surface includes what its `export * from` targets declare.
	return graph.getStarReExportTargets(file).some((target) => exportsAreOpaque(graph, target, seen));
}

/** One import edge the scan judges broken (paths relative to the project root). */
export interface BrokenImportEdge {
	file: string;
	specifier: string;
	verdict: "missing-file" | "missing-symbol";
	target: string;
	missingSymbols: string[];
}

/**
 * The NAMED symbols of an edge that its target does not export. Empty when
 * every name is found or the export list proves nothing. A JavaScript specifier
 * is judged against the TypeScript source beside it when one exists.
 */
function missingNamedSymbols(graph: ProjectGraph, edge: ImportEdge, file: string): string[] {
	// "default" is the export-side name of a default import; it is not checked.
	const named = edge.symbols.filter((s) => s !== "default");
	if (named.length === 0) return [];
	if (!graph.hasCompleteExportSurface(file)) return [];
	const exported = new Set(graph.getExports(file).map((e) => e.name));
	const missing = named.filter((s) => !exported.has(s));
	return missing.length > 0 && !exportsAreOpaque(graph, file) ? missing : [];
}

/** True when the scan must stay silent about this edge whatever its target. */
function isExemptEdge(graph: ProjectGraph, file: string, edge: ImportEdge): boolean {
	if (edge.specifier.endsWith(".json")) return true;
	if (hasNodeModulesSegment(edge.specifier)) return true;
	// A fixture nobody imports is read, run or copied at run time: a test input.
	// One that other files import is a shared module and is judged like any other.
	return isNonProductImporter(graph.toRelative(file)) && graph.getDependents(file).length === 0;
}

function judgeImportEdge(
	graph: ProjectGraph,
	file: string,
	edge: ImportEdge,
	ignored: ReadonlySet<string>,
	augmented: () => ReadonlySet<string>,
): Omit<BrokenImportEdge, "file" | "specifier"> | null {
	if (isExemptEdge(graph, file, edge)) return null;
	if (edge.toFile === "") {
		const target = unresolvedRelativeTarget(edge);
		if (target === null || ignored.has(target) || isInsideGitSubmodule(target)) return null;
		if (isSvelteKitGeneratedTypes(file, edge.specifier)) return null;
		return { verdict: "missing-file", target: graph.toRelative(target), missingSymbols: [] };
	}
	if (edge.toFile.includes("/node_modules/")) return null;
	if (!existsSync(edge.toFile)) {
		return { verdict: "missing-file", target: graph.toRelative(edge.toFile), missingSymbols: [] };
	}
	// TypeScript tries `.ts`/`.tsx`, then `x.d.ts`, before the `.js` file itself.
	// A declaration file gives no missing-symbol verdict (its export list is opaque).
	const judged = typeScriptSourceOf(edge.toFile) ?? declarationFileOf(edge.toFile) ?? edge.toFile;
	const missingSymbols = missingNamedSymbols(graph, edge, judged);
	// A `declare module './x'` block elsewhere adds names the export list lacks.
	if (missingSymbols.length === 0 || augmented().has(judged)) return null;
	return { verdict: "missing-symbol", target: graph.toRelative(judged), missingSymbols };
}

function collectUnresolvedTargets(graph: ProjectGraph): string[] {
	const targets = new Set<string>();
	for (const file of graph.allFiles()) {
		for (const edge of graph.getDependencies(file)) {
			const target = unresolvedRelativeTarget(edge);
			if (target !== null) targets.add(target);
		}
	}
	return [...targets];
}

/** Every import edge the scan judges broken, in file then source order. */
export function listBrokenImportEdges(graph: ProjectGraph): BrokenImportEdge[] {
	const ignored = gitIgnoredPaths(collectUnresolvedTargets(graph));
	const found: BrokenImportEdge[] = [];
	let augmented: ReadonlySet<string> | null = null;
	const augmentedTargets = (): ReadonlySet<string> => (augmented ??= augmentedModuleTargets(graph.allFiles()));
	for (const file of graph.allFiles()) {
		for (const edge of graph.getDependencies(file)) {
			const judgement = judgeImportEdge(graph, file, edge, ignored, augmentedTargets);
			if (judgement === null) continue;
			found.push({ file: graph.toRelative(file), specifier: edge.specifier, ...judgement });
		}
	}
	return found;
}

/** Relative paths of the files holding at least one broken import. */
export function scanBrokenImports(graph: ProjectGraph): Set<string> {
	return new Set(listBrokenImportEdges(graph).map((edge) => edge.file));
}
