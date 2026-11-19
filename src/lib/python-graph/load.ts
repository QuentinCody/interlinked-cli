// Build the Python import graph of a tree: one `python3 -I` process (the embedded `ast` analyzer),
// then entry roots from the files themselves, packaging metadata, commands and framework strings.
// The target repository's code is parsed, never imported or run.

import { closeSync, openSync, readSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listProjectFiles } from "../../commands/check-python-files.js";
import { runPythonAnalysis, type PythonSpawn, type RawGraph, type RawPythonResult } from "../../commands/check-python-run.js";
import { discoverEntryRoots, MAX_TEXT_BYTES } from "./entry-roots.js";
import type { PyEdge, PyModule, PythonGraph, PythonGraphResult, PyUnresolved } from "./types.js";

export interface LoadOptions {
	/** Repository-relative path prefixes the owner sets aside (a generated client, for instance). */
	exclude?: readonly string[];
	spawn?: PythonSpawn;
}

const HEAD_BYTES = 120;

function readText(root: string, path: string): string | null {
	try {
		const full = join(root, path);
		if (statSync(full).size > MAX_TEXT_BYTES) return null;
		return readFileSync(full, "utf-8");
	} catch {
		return null;
	}
}

function readHead(root: string, path: string): string | null {
	try {
		const fd = openSync(join(root, path), "r");
		try {
			const buffer = Buffer.alloc(HEAD_BYTES);
			return buffer.toString("utf-8", 0, readSync(fd, buffer, 0, HEAD_BYTES, 0));
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

function modulesOf(raw: RawGraph): Map<string, PyModule> {
	return new Map(raw.modules.map((item) => [item.path, {
		path: item.path,
		role: item.role,
		mainGuard: item.main_guard,
		all: item.all,
		star: item.star,
		getattr: item.getattr,
		dynamic: item.dynamic,
		defs: item.defs.map(([name, line, kind, decorated, ownUse]) => ({ name, line, kind, decorated, ownUse })),
		dynamicComputed: item.dynamic_computed,
		loaderGlobs: item.loader_globs,
	}]));
}

function edgesOf(raw: RawGraph): PyEdge[] {
	const imports: PyEdge[] = raw.edges.map((edge) => ({ from: edge.from, to: edge.to, line: edge.line, names: edge.names, star: edge.star, inFunction: edge.in_function, typeOnly: edge.type_only, guarded: edge.guarded, kind: "import" }));
	const extra = (items: RawGraph["dynamic_edges"], kind: "dynamic" | "string"): PyEdge[] =>
		items.map((edge) => ({ from: edge.from, to: edge.to, line: edge.line, names: [], star: false, inFunction: false, typeOnly: false, guarded: false, kind }));
	return [...imports, ...extra(raw.dynamic_edges, "dynamic"), ...extra(raw.string_edges, "string")];
}

function unresolvedOf(data: RawPythonResult): PyUnresolved[] {
	return data.candidates.map((item) => ({ file: item.importer, line: item.line, module: item.module, name: item.name, kind: item.kind }));
}

function assemble(root: string, data: RawPythonResult, raw: RawGraph, projectFiles: readonly string[]): PythonGraph {
	const modules = modulesOf(raw);
	const roots = discoverEntryRoots({
		modules, importRoots: data.import_roots, stringTargets: raw.string_targets, projectFiles,
		read: (path) => readText(root, path), head: (path) => readHead(root, path),
	});
	return {
		modules, edges: edgesOf(raw), unresolved: unresolvedOf(data), roots, importRoots: data.import_roots,
		consumed: raw.consumed, valueUsed: raw.value_used, getattrOn: raw.getattr_on,
		filesPy: data.files_py, unparsed: data.unparsed_total, skips: data.skips,
		deadImports: data.dead_imports.flatMap((entry) => entry.imports.map((item) => ({ file: entry.path, binding: item.name }))),
	};
}

/** The import graph of the Python files under `root`, or the named reason it could not be built. */
export function loadPythonGraph(root: string, options: LoadOptions = {}): PythonGraphResult {
	const listing = listProjectFiles(root).files;
	if (!listing.some((path) => path.endsWith(".py"))) return { status: "empty", note: "no Python files in the tree" };
	const run = runPythonAnalysis(root, options.spawn, { graph: true, exclude: options.exclude ?? [] });
	if (run.status !== "ok") return { status: run.status, note: run.note };
	const raw = run.data.graph;
	if (!raw) return { status: "failed", note: "the Python analysis answered without a graph" };
	const exclude = options.exclude ?? [];
	const files = exclude.length > 0 ? listing.filter((path) => !exclude.some((prefix) => path.startsWith(prefix))) : listing;
	return { status: "ok", graph: assemble(root, run.data, raw, files) };
}
