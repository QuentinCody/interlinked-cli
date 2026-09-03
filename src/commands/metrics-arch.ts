// ===========================================
// interlinked metrics arch — Martin metrics + propagation cost from the graph
// ===========================================
// Folds the ProjectGraph's file-level import edges to directories and computes
// Robert Martin's afferent/efferent coupling and instability I = Ce/(Ca+Ce),
// plus MacCormack's propagation cost (mean fraction of files transitively
// reachable from a file — one number for "how far does a change travel").
// Spec: docs/design/history-relational-metrics.md §3 #4. Abstractness and
// distance-from-main-sequence need export-kind classification and are
// deliberately out of v1 (noted in the doc).
//
// Granularity is FILES, not classes — the natural unit for a TS codebase and
// the same unit the rest of the harness reasons in.

import { join } from "node:path";
import { ProjectGraph } from "../harness/project-graph.js";
import { getOutputMode, output } from "../lib/output.js";

export interface Edge {
	from: string;
	to: string;
}

export interface DirMetrics {
	dir: string;
	files: number;
	/** Afferent: distinct outside files importing anything inside. */
	ca: number;
	/** Efferent: distinct inside files importing anything outside. */
	ce: number;
	/** Ce / (Ca + Ce); null when the dir has no cross-dir coupling at all. */
	instability: number | null;
}

/** Fold a file path to its first `depth` DIRECTORY segments (basename dropped). */
export function dirAtDepth(path: string, depth: number): string {
	const segs = path.split("/");
	return segs.slice(0, Math.min(depth, segs.length - 1)).join("/") || segs[0] || path;
}

const TEST_PATH_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)__tests__\/)|(\.d\.ts$)/i;
const CODE_EXT_RE = /\.[cm]?[jt]sx?$/i;

/** Production code only: source extension, not a test/spec/__tests__/.d.ts file. */
export function isProductionSource(path: string): boolean {
	return CODE_EXT_RE.test(path) && !TEST_PATH_RE.test(path);
}

/** Ca/Ce/I per folded directory; intra-dir edges are ignored. */
export function computeDirMetrics(edges: Edge[], depth: number): DirMetrics[] {
	const filesByDir = new Map<string, Set<string>>();
	const inbound = new Map<string, Set<string>>();
	const outbound = new Map<string, Set<string>>();

	const note = (dir: string, file: string): void => {
		let set = filesByDir.get(dir);
		if (!set) {
			set = new Set();
			filesByDir.set(dir, set);
		}
		set.add(file);
	};

	for (const e of edges) {
		const fromDir = dirAtDepth(e.from, depth);
		const toDir = dirAtDepth(e.to, depth);
		note(fromDir, e.from);
		note(toDir, e.to);
		if (fromDir === toDir) continue;
		let inSet = inbound.get(toDir);
		if (!inSet) {
			inSet = new Set();
			inbound.set(toDir, inSet);
		}
		inSet.add(e.from);
		let outSet = outbound.get(fromDir);
		if (!outSet) {
			outSet = new Set();
			outbound.set(fromDir, outSet);
		}
		outSet.add(e.from);
	}

	const rows: DirMetrics[] = [];
	for (const [dir, files] of filesByDir) {
		const ca = inbound.get(dir)?.size ?? 0;
		const ce = outbound.get(dir)?.size ?? 0;
		rows.push({
			dir,
			files: files.size,
			ca,
			ce,
			instability: ca + ce === 0 ? null : ce / (ca + ce),
		});
	}
	rows.sort((a, b) => b.ca + b.ce - (a.ca + a.ce) || a.dir.localeCompare(b.dir));
	return rows;
}

export interface PropagationCost {
	files: number;
	/** Mean fraction of the codebase transitively reachable from a file (0..1). */
	cost: number;
}

/** Size of the transitive closure reachable from `start`, excluding `start` itself. */
function reachableCount(start: string, adj: Map<string, string[]>): number {
	const visited = new Set<string>([start]);
	const queue = [start];
	while (queue.length > 0) {
		const cur = queue.pop();
		if (cur === undefined) break;
		for (const next of adj.get(cur) ?? []) {
			if (!visited.has(next)) {
				visited.add(next);
				queue.push(next);
			}
		}
	}
	return visited.size - 1;
}

/** BFS closure per node; self counts only as the excluded start, never as reach. */
export function computePropagationCost(edges: Edge[]): PropagationCost {
	const adj = new Map<string, string[]>();
	const nodes = new Set<string>();
	for (const e of edges) {
		nodes.add(e.from);
		nodes.add(e.to);
		const list = adj.get(e.from);
		if (list) list.push(e.to);
		else adj.set(e.from, [e.to]);
	}
	const n = nodes.size;
	if (n === 0) return { files: 0, cost: 0 };
	let totalReach = 0;
	for (const start of nodes) {
		totalReach += reachableCount(start, adj);
	}
	return { files: n, cost: totalReach / (n * n) };
}

interface MetricsArchOpts {
	cwd?: string;
	depth?: string;
	includeTests?: boolean;
	json?: boolean;
	short?: boolean;
}

function extractEdges(cwd: string, includeTests: boolean): Edge[] | null {
	try {
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		const keep = (rel: string): boolean =>
			!rel.startsWith("..") && (includeTests || isProductionSource(rel));
		const edges: Edge[] = [];
		for (const abs of graph.allFiles()) {
			const from = graph.toRelative(abs);
			if (!keep(from)) continue;
			for (const edge of graph.getDependencies(join(cwd, from))) {
				const to = graph.toRelative(edge.toFile);
				if (!keep(to)) continue;
				edges.push({ from, to });
			}
		}
		return edges;
	} catch {
		return null;
	}
}

function renderArch(rows: DirMetrics[], prop: PropagationCost, depth: number): string {
	const lines: string[] = [];
	lines.push(
		`Architecture — ${prop.files} files, propagation cost ${(prop.cost * 100).toFixed(1)}% ` +
			"(mean share of the codebase a change can reach)",
	);
	lines.push("");
	lines.push("  dir" + " ".repeat(Math.max(1, 30 - 3)) + "files    Ca    Ce     I");
	for (const r of rows.slice(0, 20)) {
		const inst = r.instability === null ? "  —" : r.instability.toFixed(2);
		lines.push(
			`  ${r.dir.padEnd(30)} ${String(r.files).padStart(5)} ${String(r.ca).padStart(5)} ${String(r.ce).padStart(5)}  ${inst}`,
		);
	}
	lines.push("");
	lines.push(`depth ${depth}; I = Ce/(Ca+Ce) — 0 stable/depended-upon, 1 unstable/dependent.`);
	return lines.join("\n");
}

/** Public API — wired by `interlinked metrics arch` in registrars/quality.ts. */
export async function metricsArchCommand(opts: MetricsArchOpts): Promise<void> {
	const cwd = opts.cwd || process.cwd();
	const depth = Number(opts.depth ?? "") || 2;
	const mode = getOutputMode(opts);
	const edges = extractEdges(cwd, opts.includeTests === true);
	if (edges === null) {
		process.stderr.write("project graph unavailable (initialize failed)\n");
		process.exitCode = 1;
		return;
	}
	const rows = computeDirMetrics(edges, depth);
	const prop = computePropagationCost(edges);
	output(mode, rows, {
		json: () => ({ depth, propagation: prop, dirs: rows }),
		short: () =>
			`${prop.files} files, propagation ${(prop.cost * 100).toFixed(1)}%, ${rows.length} dirs`,
		normal: () => renderArch(rows, prop, depth),
	});
}
