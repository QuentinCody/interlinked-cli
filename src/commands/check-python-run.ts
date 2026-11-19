// ===========================================
// Check Command — one batch Python child process
// ===========================================
// Runs the embedded analyzer once for a whole project: `python3 -I -S -B -c <script>`
// with the project root on stdin. The analyzer reads source as bytes and parses it
// with the standard library `ast`; it never imports, executes or installs anything
// from the project. A missing interpreter, a timeout, an output over the bound or a
// malformed answer is a named status, never an exception: the caller keeps working
// for TypeScript and JavaScript and says that Python was not analysed.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { gitFileList, listProjectFiles } from "./check-python-files.js";
import { PYTHON_CHECK_SCRIPT } from "./check-python-script.js";

export type PythonSpawn = typeof spawnSync;

const TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const STDERR_TAIL_CHARS = 200;

/** A file with at least this many importing files is listed by `blast-radius` (TypeScript and Python alike). */
export const BLAST_RADIUS_MIN_DEPENDENTS = 5;

/** One import statement the analyzer could not resolve (JSON field names as the analyzer writes them). */
export interface RawPythonCandidate {
	kind: "missing_module" | "missing_name";
	importer: string;
	line: number;
	end_line: number;
	level: number;
	module: string;
	name: string | null;
	statement: string;
	tags: Record<string, boolean | string>;
	tried: string[];
	ignore_paths: string[];
	listing_dir: string;
	listing: string[];
	target_file: string | null;
	target_names: string[] | null;
}

/** One strongly connected group of modules that import each other at load time. */
export interface RawCycleGroup {
	files: string[];
	files_total: number;
	/** True when a package `__init__.py` is a member: the usual shape of a cycle that Python tolerates. */
	through_package_init: boolean;
	edges: { from: string; to: string; line: number }[];
}

/** One non-test module with explicit `typing.Any` annotations. */
export interface RawAnyEntry {
	path: string;
	count: number;
	lines: number[];
}

/** Functions that share one parameter list and one body (identical syntax tree, names and comments aside). */
export interface RawDuplicateGroup {
	size: number;
	members_total: number;
	members: { path: string; line: number; name: string; size: number }[];
}

/** One unused import binding of a module. */
export interface RawDeadImport {
	name: string;
	line: number;
	end_line: number;
	/** The module the name comes from, as written (`.` prefixes kept); empty for `import x`. */
	module: string;
	statement: string;
	type_only: boolean;
	in_function: boolean;
	/** `import x` (a module bound for its own sake, possibly for a side effect) rather than `from m import x`. */
	bare_import: boolean;
}

export interface RawDeadImportEntry {
	path: string;
	count: number;
	imports: RawDeadImport[];
}

/** A module that many files import. */
export interface RawBlastEntry {
	path: string;
	dependents: number;
	importers: string[];
}

/** One parsed module of the import graph, with the facts the dead-code, architecture and coupling reads need. */
export interface RawGraphModule {
	path: string;
	role: "test" | "example" | "docs" | "script" | "other";
	main_guard: boolean;
	/** Names listed in `__all__` (empty when the module has none). */
	all: string[];
	star: boolean;
	/** The module defines `__getattr__`: its name surface is computed. */
	getattr: boolean;
	/** Dynamic-surface tokens found in the text (`globals()`, `setattr(` and so on). */
	dynamic: string[];
	/** Public module-level definitions: `[name, line, kind, decorated, usedInOwnFile]`. */
	defs: [string, number, "function" | "class" | "variable", boolean, boolean][];
	/** Lines of `import_module(<computed>)` and plugin discovery calls. */
	dynamic_computed: number[];
	/** Glob patterns for `.py` files in string literals of a module that imports by a computed name. */
	loader_globs: string[];
}

export interface RawGraphEdge {
	from: string;
	to: string;
	line: number;
	names: string[];
	star: boolean;
	in_function: boolean;
	type_only: boolean;
	guarded: boolean;
}

/** `name -> importers` per target module; importer lists are capped. */
export type RawGraphHolders = Record<string, Record<string, string[]>>;

export interface RawGraph {
	modules: RawGraphModule[];
	edges: RawGraphEdge[];
	dynamic_edges: { from: string; to: string; line: number; literal: string }[];
	string_targets: { from: string; line: number; setting: string; value: string; to: string | null }[];
	/** A string literal that names a first-party module by dotted path (`include("app.urls")`, a handler class path). */
	string_edges: { from: string; to: string; line: number; literal: string }[];
	consumed: RawGraphHolders;
	value_used: RawGraphHolders;
	getattr_on: RawGraphHolders;
	files: string[];
}

export interface RawPythonResult {
	/** Present only when the request asked for the graph. */
	graph?: RawGraph | null;
	dead_imports: RawDeadImportEntry[];
	dead_imports_total: number;
	/** Unused import bindings that were not reported, by reason. */
	dead_skips: Record<string, number>;
	blast_radius: RawBlastEntry[];
	blast_min: number;
	/** How Python files were found: the git file list (tracked plus non-ignored) or a walk that skips dot-directories. */
	discovery: "git" | "walk";
	duplicate_groups_total: number;
	duplicate_groups: RawDuplicateGroup[];
	any_types: RawAnyEntry[];
	cycle_groups_total: number;
	cycle_groups: RawCycleGroup[];
	python: string;
	import_roots: string[];
	files_py: number;
	files_parsed: number;
	files_truncated: boolean;
	unparsed_total: number;
	unparsed: { path: string; reason: string }[];
	native_build_signal: boolean;
	pyproject_unread: number;
	stats: Record<string, number>;
	skips: Record<string, number>;
	candidates_total: number;
	candidates: RawPythonCandidate[];
}

export type PythonRun =
	| { status: "ok"; note?: undefined; data: RawPythonResult }
	| { status: "unavailable" | "failed"; note: string };

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
}

function failureOf(error: unknown): PythonRun {
	const code = errorCode(error);
	if (code === "ENOENT") return { status: "unavailable", note: "python3 was not found on PATH; Python files were not analysed" };
	if (code === "ETIMEDOUT") return { status: "failed", note: `the Python analysis exceeded its ${TIMEOUT_MS / 1000}s time limit, usually a large working tree with many Python files outside git (ignore them in .gitignore); Python files were not analysed` };
	if (code === "ENOBUFS") return { status: "failed", note: "the Python analysis output exceeded its size bound; Python files were not analysed" };
	return { status: "failed", note: `python3 could not run (${code || "unknown error"}); Python files were not analysed` };
}

function parseAnswer(stdout: string): PythonRun {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return { status: "failed", note: "the Python analysis answered with text that is not JSON; Python files were not analysed" };
	}
	if (typeof value !== "object" || value === null) return { status: "failed", note: "the Python analysis answer has the wrong shape" };
	const record = value as Record<string, unknown>;
	if (typeof record.unsupported === "string") {
		return { status: "unavailable", note: `python3 ${record.unsupported} is older than the analysis needs (3.8 or newer); Python files were not analysed` };
	}
	if (!Array.isArray(record.candidates)) return { status: "failed", note: "the Python analysis answer has no candidate list" };
	return { status: "ok", data: value as RawPythonResult };
}

export interface PythonRunOptions {
	/** Ask for the import graph (`graph` in the answer). */
	graph?: boolean;
	/** Repository-relative path prefixes left out of the file list (a tree the owner sets aside). */
	exclude?: readonly string[];
}

/**
 * Run the analyzer once on `root`. Ignored trees (node_modules, worktrees, build output) never
 * reach the analyzer: it gets the git file list, so a large working tree costs nothing.
 * `spawn` is injectable for tests.
 */
export function runPythonAnalysis(root: string, spawn: PythonSpawn = spawnSync, options: PythonRunOptions = {}): PythonRun {
	const exclude = options.exclude ?? [];
	const listed = exclude.length > 0 ? listProjectFiles(root).files : gitFileList(root);
	const files = listed && exclude.length > 0 ? listed.filter((path) => !exclude.some((prefix) => path.startsWith(prefix))) : listed;
	const run = spawn("python3", ["-I", "-S", "-B", "-c", PYTHON_CHECK_SCRIPT], {
		cwd: "/",
		input: JSON.stringify({ root: resolve(root), files, blast_min: BLAST_RADIUS_MIN_DEPENDENTS, ...(options.graph === true ? { graph: true } : {}) }),
		encoding: "utf-8",
		timeout: TIMEOUT_MS,
		maxBuffer: MAX_OUTPUT_BYTES,
	});
	if (run.error) return failureOf(run.error);
	if (run.status !== 0) {
		const tail = String(run.stderr ?? "").trim().slice(-STDERR_TAIL_CHARS);
		return { status: "failed", note: `python3 exited with status ${String(run.status)}: ${tail}` };
	}
	return parseAnswer(String(run.stdout));
}
