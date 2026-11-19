// Unused exports of a Python tree: public module-level names that no other module imports or reads by
// attribute. The evidence that weakens a finding is listed on the item, never hidden in a threshold.

import type { PythonGraph, PyModule } from "./types.js";

export type ExportGraph = Pick<PythonGraph, "modules" | "edges" | "consumed" | "valueUsed" | "getattrOn">;

export type WeakerEvidence =
	| "dynamic_import_in_tree"
	| "getattr_on_module"
	| "star_import_of_module"
	| "module_used_as_value"
	| "listed_in_all"
	| "used_in_own_file"
	| "defined_in_package_init";

export interface UnusedExport {
	file: string;
	name: string;
	line: number;
	kind: "function" | "class" | "variable";
	/** Reasons this finding is less certain than a plain "no importer". Empty: the strongest claim this analysis makes. */
	weaker: WeakerEvidence[];
}

export interface ExportScan {
	items: UnusedExport[];
	/** Public definitions looked at (non-test, non-root modules). */
	considered: number;
	/** Decorated definitions not judged: a decorator may register them at import. */
	decorated: number;
}

function isPublic(name: string, module: PyModule): boolean {
	if (name.startsWith("__") && name.endsWith("__")) return false;
	return !name.startsWith("_") || module.all.includes(name);
}

function moduleEvidence(module: PyModule, graph: ExportGraph, starTargets: ReadonlySet<string>, treeDynamic: boolean): WeakerEvidence[] {
	const found: WeakerEvidence[] = [];
	if (treeDynamic) found.push("dynamic_import_in_tree");
	if (module.getattr || graph.getattrOn[module.path]) found.push("getattr_on_module");
	if (starTargets.has(module.path)) found.push("star_import_of_module");
	if (graph.valueUsed[module.path]) found.push("module_used_as_value");
	if (module.path.endsWith("/__init__.py") || module.path === "__init__.py") found.push("defined_in_package_init");
	return found;
}

function scanModule(module: PyModule, consumed: Record<string, string[]>, base: readonly WeakerEvidence[], scan: ExportScan): void {
	// A module that an importer enumerates (`dir(module)`, `vars(module)`) has every public name read.
	if (consumed["*"]) return;
	for (const item of module.defs) {
		if (!isPublic(item.name, module)) continue;
		if (item.decorated) {
			scan.decorated++;
			continue;
		}
		scan.considered++;
		if (consumed[item.name]) continue;
		const weaker = [...base];
		if (module.all.includes(item.name)) weaker.push("listed_in_all");
		if (item.ownUse) weaker.push("used_in_own_file");
		scan.items.push({ file: module.path, name: item.name, line: item.line, kind: item.kind, weaker });
	}
}

/** Public names with no importer and no attribute read. `rootPaths` (entry roots) are never scanned: something outside the graph uses their names. */
export function findUnusedExports(graph: ExportGraph, rootPaths: ReadonlySet<string>): ExportScan {
	const starTargets = new Set(graph.edges.filter((edge) => edge.star).map((edge) => edge.to));
	const treeDynamic = [...graph.modules.values()].some((module) => module.dynamicComputed.length > 0);
	const scan: ExportScan = { items: [], considered: 0, decorated: 0 };
	for (const module of graph.modules.values()) {
		if (module.role === "test" || rootPaths.has(module.path)) continue;
		scanModule(module, graph.consumed[module.path] ?? {}, moduleEvidence(module, graph, starTargets, treeDynamic), scan);
	}
	scan.items.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
	return scan;
}
