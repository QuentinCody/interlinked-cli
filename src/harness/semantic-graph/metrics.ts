// Semantic graph — the four per-type metrics. Pure: edges, units and an
// import-edge oracle in, `TypeMetrics` out. Every number carries its
// denominator (feedback_report_numerator_denominator); nothing here gates.
//
// Denominators:
//   orphans          — units of the type's `source_kind`
//   mismatches       — latest edges that carry a `confirmation`
//   hidden_coupling  — latest edges with a target whose import relation is KNOWN
//   churn            — latest edges with a previous judgment of the same packet hash

import { latestEdges, previousJudgment } from "./store.js";
import { CHURN_NOISE_FLOOR, type Edge, type RelationshipType, type TypeMetrics, type Unit } from "./types.js";

/** Whether `fileA` imports `fileB` (one direction). `null` = unknown, excluded
 *  from the hidden-coupling denominator. */
export type ImportEdgeOracle = (fileA: string, fileB: string) => boolean | null;

export interface MetricsArgs {
	relationships: RelationshipType[];
	units: Unit[];
	edges: Edge[];
	hasImportEdge: ImportEdgeOracle;
}

interface Ratio {
	count: number;
	of: number;
}

function ratio(items: readonly Edge[], hit: (edge: Edge) => boolean): Ratio {
	return { count: items.filter(hit).length, of: items.length };
}

/** Source-kind units with no current judgment: no edge, a `none` edge, or a stale latest edge. */
function orphans(type: RelationshipType, units: Unit[], latest: Map<string, Edge>): Ratio {
	const sources = units.filter((unit) => unit.kind === type.source_kind);
	const isOrphan = (unit: Unit): boolean => {
		const edge = latest.get(`${type.name}|${unit.id}`);
		return edge === undefined || edge.state === "stale" || edge.target === null;
	};
	return { count: sources.filter(isOrphan).length, of: sources.length };
}

function mismatches(live: Edge[]): Ratio {
	const confirmed = live.filter((edge) => edge.confirmation !== undefined);
	return ratio(confirmed, (edge) => edge.confirmation?.verdict === "contradicted");
}

/** `true` = the two files share an import edge in either direction, `false` =
 *  neither direction, `null` = unknown (a unit is missing or the oracle cannot say). */
function filesCoupled(edge: Edge, unitsById: Map<string, Unit>, hasImportEdge: ImportEdgeOracle): boolean | null {
	const source = unitsById.get(edge.source);
	const target = edge.target === null ? undefined : unitsById.get(edge.target);
	if (source === undefined || target === undefined) return null;
	if (source.file === target.file) return true;
	const forward = hasImportEdge(source.file, target.file);
	const backward = hasImportEdge(target.file, source.file);
	if (forward === true || backward === true) return true;
	if (forward === null || backward === null) return null;
	return false;
}

function hiddenCoupling(live: Edge[], unitsById: Map<string, Unit>, hasImportEdge: ImportEdgeOracle): Ratio {
	let count = 0;
	let of = 0;
	for (const edge of live) {
		if (edge.target === null) continue;
		const coupled = filesCoupled(edge, unitsById, hasImportEdge);
		if (coupled === null) continue;
		of += 1;
		if (!coupled) count += 1;
	}
	return { count, of };
}

/** Probabilities are reported to a few decimals; quantize |Δp| so a float
 *  artifact (0.5 + 0.06 = 0.56000000000000005) never crosses the floor. */
const DELTA_QUANTUM = 1e-6;

function movedPastFloor(a: number, b: number): boolean {
	const delta = Math.round(Math.abs(a - b) / DELTA_QUANTUM) * DELTA_QUANTUM;
	return delta > CHURN_NOISE_FLOOR;
}

/** Over live latest edges that repeat an earlier judgment of the same packet. */
function churn(live: Edge[], all: Edge[]): Ratio {
	let count = 0;
	let of = 0;
	for (const edge of live) {
		const previous = previousJudgment(all, edge.packet_hash, edge);
		if (previous === null) continue;
		of += 1;
		if (movedPastFloor(edge.p, previous.p)) count += 1;
	}
	return { count, of };
}

function metricsForType(type: RelationshipType, args: MetricsArgs, latest: Map<string, Edge>, unitsById: Map<string, Unit>): TypeMetrics {
	const live = [...latest.values()].filter((edge) => edge.type === type.name && edge.state !== "stale");
	return {
		type: type.name,
		orphans: orphans(type, args.units, latest),
		mismatches: mismatches(live),
		hidden_coupling: hiddenCoupling(live, unitsById, args.hasImportEdge),
		churn: churn(live, args.edges),
	};
}

export function computeMetrics(args: MetricsArgs): TypeMetrics[] {
	const latest = latestEdges(args.edges);
	const unitsById = new Map(args.units.map((unit) => [unit.id, unit]));
	return args.relationships.map((type) => metricsForType(type, args, latest, unitsById));
}
