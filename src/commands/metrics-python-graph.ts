// Python reads of the import graph for `metrics arch` and `metrics coupling`. One `python3 -I` process
// (src/lib/python-graph/); the directory fold, the propagation cost and the pair labels stay in
// metrics-arch.ts and metrics-coupling.ts, so the rule is the same for every language.

import { loadPythonGraph } from "../lib/python-graph/load.js";
import { importChainLinks } from "../lib/python-graph/reach.js";
import type { PythonGraph } from "../lib/python-graph/types.js";

export interface PythonArch {
	files: string[];
	edges: { from: string; to: string }[];
	/** Unresolved imports of first-party modules; third-party and standard-library imports are never counted. */
	unresolved: number;
}

/** Static and literal-dynamic imports between production modules (tests too when asked). String-literal names are not edges here. */
export function pythonArchGraph(cwd: string, includeTests: boolean): PythonArch | null {
	const loaded = loadPythonGraph(cwd);
	if (loaded.status !== "ok") return null;
	const { graph } = loaded;
	const keep = (path: string): boolean => includeTests || graph.modules.get(path)?.role !== "test";
	const edges = graph.edges
		.filter((edge) => edge.kind !== "string" && keep(edge.from) && keep(edge.to))
		.map((edge) => ({ from: edge.from, to: edge.to }));
	const unique = [...new Map(edges.map((edge) => [`${edge.from}\0${edge.to}`, edge])).values()];
	return { files: [...graph.modules.keys()].filter(keep).sort(), edges: unique, unresolved: graph.unresolved.filter((item) => keep(item.file)).length };
}

/** Link lookup for coupling pairs: true (an import chain joins them), false (none does and nothing is unresolved), null (cannot tell). */
export function pythonLinkLookup(cwd: string): (a: string, b: string) => boolean | null {
	let graph: PythonGraph | null | undefined;
	const load = (): PythonGraph | null => {
		if (graph === undefined) {
			const loaded = loadPythonGraph(cwd);
			graph = loaded.status === "ok" ? loaded.graph : null;
		}
		return graph;
	};
	return (a, b) => {
		const known = load();
		if (known === null || !known.modules.has(a) || !known.modules.has(b)) return null;
		if (importChainLinks(known, a, b)) return true;
		return known.unresolved.some((item) => item.file === a || item.file === b) ? null : false;
	};
}
