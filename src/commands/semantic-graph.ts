// `interlinked semantic-graph metrics|status|edges` — read-only views of the
// semantic graph store. Nothing here calls Jev or Haiku, and nothing here
// is reachable from the check pipeline or `interlinked verify`: the graph
// ranks and proposes, it never gates. The Jev-calling actions live on the
// internal runner (`semantic-graph-internal.ts`).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProjectGraph } from "../harness/project-graph.js";
import { formatEdgeLines, formatMetricsTable } from "../harness/semantic-graph/format.js";
import { computeMetrics, type ImportEdgeOracle } from "../harness/semantic-graph/metrics.js";
import { loadRelationships } from "../harness/semantic-graph/relationships.js";
import { latestEdges, loadEdgesReport, loadUnits } from "../harness/semantic-graph/store.js";
import { type Edge, RELATIONSHIPS_FILE, type RelationshipsFile } from "../harness/semantic-graph/types.js";
import { getOutputMode, output } from "../lib/output.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const DEFAULT_EDGE_LIMIT = 25;

export interface SemanticGraphReadOptions {
	cwd?: string;
	json?: boolean;
	short?: boolean;
}

export interface SemanticGraphMetricsOptions extends SemanticGraphReadOptions {
	/** Injected in tests; a `ProjectGraph` over `cwd` otherwise. */
	hasImportEdge?: ImportEdgeOracle;
}

export interface SemanticGraphEdgesOptions extends SemanticGraphReadOptions {
	type?: string;
	state?: string;
	limit?: string;
}

type RelationshipsSource = "file" | "default";

function relationshipsSource(cwd: string): RelationshipsSource {
	return existsSync(join(cwd, RELATIONSHIPS_FILE)) ? "file" : "default";
}

/** Loads the relationships file; a malformed file is reported on stderr and yields null. */
function relationshipsOrReport(cwd: string): RelationshipsFile | null {
	try {
		return loadRelationships(cwd);
	} catch (err) {
		// The loader's message names the file and the offending key; the command only relays it.
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		return null;
	}
}

/** One-direction import oracle over the project graph; `null` when either file is outside the graph. */
export function importOracleFor(cwd: string): ImportEdgeOracle {
	try {
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		return (fileA, fileB) => {
			const absA = join(cwd, fileA);
			const absB = join(cwd, fileB);
			if (!graph.hasFile(absA) || !graph.hasFile(absB)) return null;
			return graph.getDependencies(absA).some((edge) => edge.toFile === absB);
		};
	} catch {
		// Without a graph every pair is unknown: the hidden-coupling denominator shrinks, nothing is guessed.
		return () => null;
	}
}

function liveLatest(edges: Edge[]): Edge[] {
	return [...latestEdges(edges).values()].filter((edge) => edge.state !== "stale");
}

/** The four metrics per configured type. */
export async function semanticGraphMetricsAction(opts: SemanticGraphMetricsOptions = {}): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const relationships = relationshipsOrReport(cwd);
	if (!relationships) return EXIT_ERROR;
	const report = loadEdgesReport(cwd);
	const metrics = computeMetrics({
		relationships: relationships.relationships,
		units: loadUnits(cwd),
		edges: report.edges,
		hasImportEdge: opts.hasImportEdge ?? importOracleFor(cwd),
	});
	const source = relationshipsSource(cwd);
	output(getOutputMode(opts), metrics, {
		json: () => ({ relationships: source, malformed_rows: report.malformed, metrics }),
		normal: () => `${formatMetricsTable(metrics)}\n(relationships: ${source}; ${report.edges.length} rows, ${report.malformed} malformed)`,
	});
	return EXIT_OK;
}

type StateCounts = Partial<Record<Edge["state"], number>>;

function countByTypeAndState(edges: Edge[]): Record<string, StateCounts> {
	const types: Record<string, StateCounts> = {};
	for (const edge of edges) {
		const row = (types[edge.type] ??= {});
		row[edge.state] = (row[edge.state] ?? 0) + 1;
	}
	return types;
}

function formatStatus(status: { units: number; rows: number; malformed: number; relationships: string; types: Record<string, StateCounts> }): string {
	const lines = [
		`units: ${status.units}`,
		`edge rows: ${status.rows} (${status.malformed} malformed)`,
		`relationships: ${status.relationships}`,
	];
	const names = Object.keys(status.types).sort();
	if (names.length === 0) lines.push("latest edges: none");
	for (const name of names) {
		const cells = Object.entries(status.types[name] ?? {}).map(([state, count]) => `${state} ${count}`);
		lines.push(`  ${name}: ${cells.join(", ")}`);
	}
	return lines.join("\n");
}

/** Store health: latest-edge counts by type and state, units, malformed rows, relationships source. */
export async function semanticGraphStatusAction(opts: SemanticGraphReadOptions = {}): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const report = loadEdgesReport(cwd);
	const status = {
		units: loadUnits(cwd).length,
		rows: report.edges.length,
		malformed: report.malformed,
		relationships: relationshipsSource(cwd),
		types: countByTypeAndState([...latestEdges(report.edges).values()]),
	};
	output(getOutputMode(opts), status, { normal: () => formatStatus(status) });
	return EXIT_OK;
}

function parseLimit(raw: string | undefined): number {
	const parsed = raw === undefined ? DEFAULT_EDGE_LIMIT : Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_EDGE_LIMIT;
}

/** Latest live edges by `p` descending, filtered by type and state. */
export async function semanticGraphEdgesAction(opts: SemanticGraphEdgesOptions = {}): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const limit = parseLimit(opts.limit);
	const edges = liveLatest(loadEdgesReport(cwd).edges)
		.filter((edge) => (opts.type === undefined || edge.type === opts.type) && (opts.state === undefined || edge.state === opts.state))
		.sort((a, b) => b.p - a.p)
		.slice(0, limit);
	output(getOutputMode(opts), edges, {
		json: () => ({ edges }),
		normal: () => (edges.length === 0 ? "no edges" : formatEdgeLines(edges, limit).join("\n")),
	});
	return EXIT_OK;
}
