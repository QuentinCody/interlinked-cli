// ===========================================
// `interlinked deadcode` — the Python half
// ===========================================
// Reachability over the Python import graph (src/lib/python-graph/), then unused exports. Every row is a
// CANDIDATE, as in the TypeScript half. Evidence that weakens a row is named on the row: a computed
// `import_module`, `getattr` on a module, a star import of the module, a module passed around as a value.

import { loadPythonGraph, type LoadOptions } from "../lib/python-graph/load.js";
import type { DeadCodeReport } from "./deadcode.js";
import { findUnusedExports, type UnusedExport } from "../lib/python-graph/exports.js";
import { reachableModules } from "../lib/python-graph/reach.js";
import type { EntryRoot, PyRole, PythonGraph, PyUnresolved } from "../lib/python-graph/types.js";

export interface PythonDeadExport {
	file: string;
	detail: string;
	language: "python";
	name: string;
	line: number;
	kind: UnusedExport["kind"];
	weaker: UnusedExport["weaker"];
}

export interface PythonDeadCode {
	language: "python";
	unreachableFiles: string[];
	deadImportBindings: { file: string; binding: string }[];
	deadExports: PythonDeadExport[];
	testOnlyImporterFiles: string[];
	scannedFiles: number;
	scannedPaths: string[];
	python: {
		status: "ok" | "unavailable" | "failed";
		note?: string;
		modules: number;
		edgesByKind: Record<string, number>;
		unresolvedImports: { count: number; items: PyUnresolved[]; unjudged: Record<string, number> };
		entryRoots: EntryRoot[];
		rootsByKind: Record<string, number>;
		dynamicImports: { literal: number; computed: { file: string; line: number }[]; treeHasDynamicImports: boolean };
		unreachable: { path: string; role: PyRole; weaker: string[] }[];
		exportScan: { considered: number; decorated: number };
		unparsedFiles: number;
	};
}

const TEST_SIDE_ROOTS = new Set(["test", "conftest", "pytest-plugin"]);
const UNRESOLVED_LIST_CAP = 200;

function count<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
	const found: Record<string, number> = {};
	for (const item of items) found[key(item)] = (found[key(item)] ?? 0) + 1;
	return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

function detailOf(item: UnusedExport): string {
	const base = `"${item.name}" (${item.kind}, line ${item.line}) has no importer or attribute read in the scanned tree`;
	return item.weaker.length > 0 ? `${base}; weaker evidence: ${item.weaker.join(", ")}` : base;
}

function emptyReport(status: "unavailable" | "failed", note: string): PythonDeadCode {
	return {
		language: "python", unreachableFiles: [], deadImportBindings: [], deadExports: [], testOnlyImporterFiles: [], scannedFiles: 0, scannedPaths: [],
		python: {
			status, note, modules: 0, edgesByKind: {}, unresolvedImports: { count: 0, items: [], unjudged: {} }, entryRoots: [], rootsByKind: {},
			dynamicImports: { literal: 0, computed: [], treeHasDynamicImports: false }, unreachable: [], exportScan: { considered: 0, decorated: 0 }, unparsedFiles: 0,
		},
	};
}

interface Reachability {
	scanned: string[];
	unreachable: PythonDeadCode["python"]["unreachable"];
	testOnly: string[];
	computed: { file: string; line: number }[];
}

/** Which scanned (non-test) modules no root reaches, and which only a test-side root reaches. */
function reachability(graph: PythonGraph, rootSet: ReadonlySet<string>): Reachability {
	const appRoots = graph.roots.filter((root) => !TEST_SIDE_ROOTS.has(root.kind)).map((root) => root.path);
	const reachedApp = reachableModules(graph, appRoots);
	const reachedAny = reachableModules(graph, rootSet);
	const computed = [...graph.modules.values()].flatMap((module) => module.dynamicComputed.map((line) => ({ file: module.path, line })));
	const scanned = [...graph.modules.values()].filter((module) => module.role !== "test");
	const weaker = computed.length > 0 ? ["dynamic_import_in_tree"] : [];
	return {
		scanned: scanned.map((module) => module.path).sort((a, b) => a.localeCompare(b)),
		unreachable: scanned.filter((module) => !reachedAny.has(module.path)).map((module) => ({ path: module.path, role: module.role, weaker })),
		testOnly: scanned.filter((module) => reachedAny.has(module.path) && !reachedApp.has(module.path) && !rootSet.has(module.path)).map((module) => module.path).sort((a, b) => a.localeCompare(b)),
		computed,
	};
}

function pythonDetails(graph: PythonGraph, reach: Reachability, exportScan: { considered: number; decorated: number }): PythonDeadCode["python"] {
	return {
		status: "ok", modules: graph.modules.size, edgesByKind: count(graph.edges, (edge) => edge.kind),
		unresolvedImports: { count: graph.unresolved.length, items: graph.unresolved.slice(0, UNRESOLVED_LIST_CAP), unjudged: graph.skips },
		entryRoots: graph.roots, rootsByKind: count(graph.roots, (root) => root.kind),
		dynamicImports: { literal: graph.edges.filter((edge) => edge.kind === "dynamic").length, computed: reach.computed, treeHasDynamicImports: reach.computed.length > 0 },
		unreachable: reach.unreachable, exportScan, unparsedFiles: graph.unparsed,
	};
}

/** The dead-code report of one loaded graph. Pure: no process, no disk. */
function pythonDeadCodeFromGraph(graph: PythonGraph): PythonDeadCode {
	const rootSet = new Set(graph.roots.map((root) => root.path));
	const reach = reachability(graph, rootSet);
	const exportScan = findUnusedExports(graph, rootSet);
	return {
		language: "python",
		unreachableFiles: reach.unreachable.map((item) => item.path).sort((a, b) => a.localeCompare(b)),
		deadImportBindings: graph.deadImports.filter((item) => graph.modules.get(item.file)?.role !== "test"),
		deadExports: exportScan.items.map((item) => ({ file: item.file, detail: detailOf(item), language: "python", name: item.name, line: item.line, kind: item.kind, weaker: item.weaker })),
		testOnlyImporterFiles: reach.testOnly,
		scannedFiles: graph.modules.size,
		scannedPaths: reach.scanned,
		python: pythonDetails(graph, reach, { considered: exportScan.considered, decorated: exportScan.decorated }),
	};
}

/** Scan the Python files under `cwd`. Null when the tree holds no Python file. */
export function scanPythonDeadCode(cwd: string, options: LoadOptions = {}): PythonDeadCode | null {
	const loaded = loadPythonGraph(cwd, options);
	if (loaded.status === "empty") return null;
	if (loaded.status !== "ok") return emptyReport(loaded.status, loaded.note);
	return pythonDeadCodeFromGraph(loaded.graph);
}

/** The TypeScript report with the Python rows added under the same keys; `language` says which halves ran. */
export function withPython(scripts: DeadCodeReport, python: PythonDeadCode | null): DeadCodeReport {
	if (python === null) return { ...scripts, language: "typescript" };
	return {
		unreachableFiles: [...scripts.unreachableFiles, ...python.unreachableFiles].sort((a, b) => a.localeCompare(b)),
		deadImportBindings: [...scripts.deadImportBindings, ...python.deadImportBindings],
		deadExports: [...scripts.deadExports, ...python.deadExports],
		deadTypeExports: scripts.deadTypeExports,
		testOnlyImporterFiles: [...(scripts.testOnlyImporterFiles ?? []), ...python.testOnlyImporterFiles],
		scannedFiles: scripts.scannedFiles + python.scannedFiles,
		scannedPaths: [...scripts.scannedPaths, ...python.scannedPaths],
		language: scripts.scannedFiles === 0 ? "python" : "mixed",
		python: python.python,
	};
}

/** Plain-report lines that state the Python evidence: roots by kind, unresolved imports and the dynamic-import caveat. */
export function pythonSummaryLines(report: DeadCodeReport): string[] {
	const python = report.python;
	if (python === undefined) return [];
	if (python.status !== "ok") return [`Python: not analysed (${python.note ?? python.status})`];
	const kinds = Object.entries(python.rootsByKind).map(([kind, total]) => `${kind} ${total}`).join(", ");
	const lines = [`Python: ${python.modules} modules, ${python.entryRoots.length} entry roots (${kinds || "none"}), ${python.unresolvedImports.count} unresolved internal imports`];
	if (python.dynamicImports.treeHasDynamicImports) {
		lines.push(`Python: ${python.dynamicImports.computed.length} computed or discovery imports; unreachable files and unused exports are candidates only`);
	}
	return lines;
}
