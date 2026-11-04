// Semantic graph — the edge store. Append-only JSONL under
// `<cwd>/.interlinked/semantic-graph/edges.jsonl` plus a `units.json`
// snapshot. Every row is a judgment (or a stale copy of one); nothing is ever
// rewritten in place, so history stays replayable and churn is measurable.
//
// The reader is a constructing parser: a row that does not match the `Edge`
// shape is skipped and counted, never partially trusted.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	EDGES_FILE,
	SEMANTIC_GRAPH_DIR,
	UNITS_FILE,
	type Confirmation,
	type Edge,
	type EdgeState,
	type RelationshipType,
	type Unit,
	type UnitKind,
} from "./types.js";

const EDGE_STATES: ReadonlySet<string> = new Set<EdgeState>(["proposed", "confirmed", "contradicted", "stale"]);
const VERDICTS: ReadonlySet<string> = new Set<Confirmation["verdict"]>(["supported", "contradicted", "undecided"]);
const UNIT_KINDS: ReadonlySet<string> = new Set<UnitKind>(["function", "doc_comment", "test", "doc_section"]);

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
	return isRow(value) && Object.values(value).every(isNumber);
}

function parseConfirmation(value: unknown): Confirmation | null {
	if (!isRow(value)) return null;
	const { model, verdict, evidence, confirmed_at } = value;
	if (!isString(model) || !isString(verdict) || !VERDICTS.has(verdict)) return null;
	if (!isString(evidence) || !isString(confirmed_at)) return null;
	return { model, verdict: verdict as Confirmation["verdict"], evidence, confirmed_at };
}

function edgeStrings(row: Row): Pick<Edge, "type" | "source" | "packet_hash" | "source_hash" | "model" | "judged_at"> | null {
	const { type, source, packet_hash, source_hash, model, judged_at } = row;
	if (![type, source, packet_hash, source_hash, model, judged_at].every(isString)) return null;
	return {
		type: type as string,
		source: source as string,
		packet_hash: packet_hash as string,
		source_hash: source_hash as string,
		model: model as string,
		judged_at: judged_at as string,
	};
}

/** Constructing parser for one JSONL row; null when the row is not an Edge. */
export function parseEdge(line: string): Edge | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		// Malformed JSON is counted by the caller because a torn append must not abort the load.
		return null;
	}
	if (!isRow(value)) return null;
	const strings = edgeStrings(value);
	if (strings === null) return null;
	const { target, p, probabilities, confidence, candidates, state, confirmation } = value;
	if (target !== null && !isString(target)) return null;
	if (!isNumber(p) || !isNumber(confidence) || !isNumberRecord(probabilities)) return null;
	if (!isStringArray(candidates) || !isString(state) || !EDGE_STATES.has(state)) return null;
	const edge: Edge = { ...strings, target, p, probabilities, confidence, candidates, state: state as EdgeState };
	if (confirmation !== undefined) {
		const parsed = parseConfirmation(confirmation);
		if (parsed === null) return null;
		edge.confirmation = parsed;
	}
	return edge;
}

function graphDir(cwd: string): string {
	return join(cwd, SEMANTIC_GRAPH_DIR);
}

function edgesPath(cwd: string): string {
	return join(graphDir(cwd), EDGES_FILE);
}

function unitsPath(cwd: string): string {
	return join(graphDir(cwd), UNITS_FILE);
}

/** Append rows; creates the directory when needed. */
export function appendEdges(cwd: string, edges: Edge[]): void {
	if (edges.length === 0) return;
	mkdirSync(graphDir(cwd), { recursive: true });
	const lines = edges.map((edge) => `${JSON.stringify(edge)}\n`).join("");
	appendFileSync(edgesPath(cwd), lines);
}

export interface EdgesReport {
	edges: Edge[];
	/** Rows skipped because they did not parse as an Edge. */
	malformed: number;
}

export function loadEdgesReport(cwd: string): EdgesReport {
	const path = edgesPath(cwd);
	if (!existsSync(path)) return { edges: [], malformed: 0 };
	const edges: Edge[] = [];
	let malformed = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		const edge = parseEdge(line);
		if (edge === null) malformed += 1;
		else edges.push(edge);
	}
	return { edges, malformed };
}

export function loadEdges(cwd: string): Edge[] {
	return loadEdgesReport(cwd).edges;
}

/** Key of the latest-edge view: one row per (type, source). */
export function edgeKey(type: string, source: string): string {
	return `${type}|${source}`;
}

/** Last row wins per `<type>|<source>`: newest `judged_at`, then file order. */
export function latestEdges(edges: Edge[]): Map<string, Edge> {
	const latest = new Map<string, Edge>();
	for (const edge of edges) {
		const key = edgeKey(edge.type, edge.source);
		const current = latest.get(key);
		if (current === undefined || edge.judged_at >= current.judged_at) latest.set(key, edge);
	}
	return latest;
}

/** The newest non-stale edge with `packetHash` judged no later than `current`
 *  (and not `current` itself); the newest overall when `current` is absent.
 *  With `current`, only edges of the SAME source count: verbatim clones share
 *  a packet hash, and comparing one clone's judgment with another's reported
 *  identical-repeat noise as churn (unit E live run, 75/239). */
export function previousJudgment(edges: Edge[], packetHash: string, current?: Edge): Edge | null {
	let best: Edge | null = null;
	for (const edge of edges) {
		if (edge.packet_hash !== packetHash || edge.state === "stale" || edge === current) continue;
		if (current !== undefined && (edge.judged_at > current.judged_at || edge.source !== current.source)) continue;
		if (best === null || edge.judged_at >= best.judged_at) best = edge;
	}
	return best;
}

function isSourceStale(edge: Edge, unitsById: Map<string, Unit>): boolean {
	const unit = unitsById.get(edge.source);
	return unit === undefined || unit.hash !== edge.source_hash;
}

/** Append a `stale` copy of every latest edge (of a listed type) whose source
 *  text changed or vanished. Returns the rows appended. `now` stamps the rows
 *  (the caller's clock, so a refresh's stale copies and fresh judgments agree). */
export function markStale(cwd: string, units: Unit[], relationships: RelationshipType[], now?: () => string): Edge[] {
	const typeNames = new Set(relationships.map((type) => type.name));
	const unitsById = new Map(units.map((unit) => [unit.id, unit]));
	const stamp = (now ?? (() => new Date().toISOString()))();
	const stale: Edge[] = [];
	for (const edge of latestEdges(loadEdges(cwd)).values()) {
		if (edge.state === "stale" || !typeNames.has(edge.type)) continue;
		if (isSourceStale(edge, unitsById)) stale.push({ ...edge, state: "stale", judged_at: stamp });
	}
	appendEdges(cwd, stale);
	return stale;
}

function parseUnit(value: unknown): Unit | null {
	if (!isRow(value)) return null;
	const { id, kind, file, name, line, endLine, text, hash } = value;
	if (![id, file, name, text, hash].every(isString) || !isString(kind) || !UNIT_KINDS.has(kind)) return null;
	if (!isNumber(line) || !isNumber(endLine)) return null;
	return {
		id: id as string,
		kind: kind as UnitKind,
		file: file as string,
		name: name as string,
		line,
		endLine,
		text: text as string,
		hash: hash as string,
	};
}

/** Snapshot of the units the last build judged; replaces the file. */
export function saveUnits(cwd: string, units: Unit[]): void {
	mkdirSync(graphDir(cwd), { recursive: true });
	writeFileSync(unitsPath(cwd), `${JSON.stringify(units, null, "\t")}\n`);
}

/** Units from `units.json`; malformed entries are dropped, a malformed file is empty. */
export function loadUnits(cwd: string): Unit[] {
	const path = unitsPath(cwd);
	if (!existsSync(path)) return [];
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// A torn or hand-edited snapshot is treated as absent because the next build rewrites it.
		return [];
	}
	if (!Array.isArray(value)) return [];
	return value.map(parseUnit).filter((unit): unit is Unit => unit !== null);
}
