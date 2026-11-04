// Semantic graph — the build orchestrator. Relationships → units → candidates
// → packets → Jev judgments → appended edges. The one staleness rule lives
// here: a packet whose hash already has a non-stale latest edge is SKIPPED
// (the packet hash covers the source text, every candidate text, the question
// and the model, so an identical hash is an identical question). Refresh is
// therefore "mark what changed stale, then build" (`refresh.ts`).
//
// Jev ranks and proposes; nothing here gates, and nothing here is reachable
// from the check pipeline or `interlinked verify`. Git and the project graph
// are injectable so tests never shell out.

import type { JevClient, JevSpend } from "../jev/client.js";
import { JEV_DEFAULT_MODEL } from "../jev/client.js";
import { buildCandidateIndex, type CandidateDeps, type CandidateIndex, candidatesFor, coChangeFromGit } from "./candidates.js";
import { judgeMany, type ManyPacket } from "./judge.js";
import { buildPacket, candidateIdMap } from "./packet.js";
import { loadRelationships, resolveScope, writeDefaultRelationships } from "./relationships.js";
import { appendEdges, latestEdges, loadEdges, saveUnits } from "./store.js";
import { extractRepoUnits } from "./units.js";
import type { Edge, RelationshipsFile, RelationshipType, Unit } from "./types.js";

/** Co-change window when `since` is absent (a `git log --since` value). */
export const DEFAULT_CO_CHANGE_SINCE = "180 days ago";

export interface BuildDeps {
	/** Units to judge; absent ⇒ `extractRepoUnits(cwd)`. */
	units?: Unit[];
	/** file ⇒ co-changed files; absent ⇒ `coChangeFromGit(cwd, since)`. */
	coChange?: Map<string, string[]>;
	/** Import graph view; absent ⇒ a `ProjectGraph` over `cwd`. */
	graph?: CandidateDeps["graph"];
}

export interface BuildOptions {
	client: JevClient;
	/** Spend ceiling read from `client.spend()` before every ask. */
	maxUsd: number;
	/** Relationship type names to build; absent ⇒ every configured type. */
	types?: string[];
	/** Co-change window; default `DEFAULT_CO_CHANGE_SINCE`. */
	since?: string;
	concurrency?: number;
	/** Per type, the most packets asked after the unchanged skip; the rest count as `cap_skipped`. */
	maxPackets?: number;
	/** The model id the packet hash is computed with; default `jev-latest`. */
	model?: string;
	now?: () => string;
	deps?: BuildDeps;
	log?: (line: string) => void;
}

export interface TypeBuildCounts {
	type: string;
	/** Units of the type's `source_kind`. */
	sources: number;
	/** Sources with zero candidates (no packet). */
	no_candidates: number;
	/** Packets built (= sources − no_candidates). */
	packets: number;
	/** Packets whose hash already had a non-stale latest edge. */
	unchanged: number;
	/** Packets asked. */
	judged: number;
	/** Packets never asked because the budget was reached first. */
	budget_skipped: number;
	/** Packets never asked because `maxPackets` was reached first. */
	cap_skipped: number;
	/** Judged packets whose answer was `none`. */
	none_chosen: number;
	/** Judged packets whose answer was unusable. */
	failures: number;
	/** Edges appended. */
	edges: number;
}

export interface BuildReport {
	relationships_written: boolean;
	units: number;
	model: string;
	spend: JevSpend;
	types: TypeBuildCounts[];
	/** Type names requested but not configured. */
	unknown_types: string[];
}

interface BuildContext {
	index: CandidateIndex;
	model: string;
	/** packet_hash ⇒ a non-stale latest edge exists. */
	judgedHashes: Set<string>;
	log: (line: string) => void;
}

interface PacketPlan {
	type: RelationshipType;
	sources: Unit[];
	packets: ManyPacket[];
	unchanged: number;
	/** Packets dropped by `maxPackets`. */
	capSkipped: number;
}

function selectTypes(configured: RelationshipType[], requested: string[] | undefined): { types: RelationshipType[]; unknown: string[] } {
	if (requested === undefined) return { types: configured, unknown: [] };
	const byName = new Map(configured.map((type) => [type.name, type]));
	const types: RelationshipType[] = [];
	const unknown: string[] = [];
	for (const name of requested) {
		const type = byName.get(name);
		if (type) types.push(type);
		else unknown.push(name);
	}
	return { types, unknown };
}

/** Packet hashes that already have a live (non-stale) latest judgment. */
/** `<type>|<source id>|<packet hash>` for every live latest edge. The source id
 *  is part of the key because two verbatim clones share a packet hash, and a
 *  hash-only key let the second clone be skipped as "unchanged" without an
 *  edge of its own (unit E live run, 239 such packets). */
export function liveHashes(edges: Edge[]): Set<string> {
	const live = new Set<string>();
	for (const edge of latestEdges(edges).values()) {
		if (edge.state !== "stale") live.add(judgedKey(edge.type, edge.source, edge.packet_hash));
	}
	return live;
}

export function judgedKey(type: string, source: string, packetHash: string): string {
	return `${type}|${source}|${packetHash}`;
}

function planPackets(type: RelationshipType, units: Unit[], ctx: BuildContext, maxPackets?: number): PacketPlan {
	const sources = units.filter((unit) => unit.kind === type.source_kind);
	const packets: ManyPacket[] = [];
	let unchanged = 0;
	for (const source of sources) {
		const candidates = candidatesFor(source, type, ctx.index);
		if (candidates.length === 0) continue;
		const built = buildPacket(source, candidates, type, ctx.model);
		if (ctx.judgedHashes.has(judgedKey(type.name, source.id, built.packetHash))) {
			unchanged++;
			continue;
		}
		packets.push({ ...built, candidateIds: candidateIdMap(candidates), source });
	}
	const cap = maxPackets === undefined ? packets.length : Math.max(0, Math.floor(maxPackets));
	const capSkipped = Math.max(0, packets.length - cap);
	return { type, sources, packets: packets.slice(0, cap), unchanged, capSkipped };
}

async function buildType(plan: PacketPlan, opts: BuildOptions, ctx: BuildContext, cwd: string): Promise<TypeBuildCounts> {
	const { type, sources, packets, unchanged, capSkipped } = plan;
	ctx.log(`${type.name}: ${sources.length} source(s), ${packets.length} packet(s) to judge, ${unchanged} unchanged, ${capSkipped} over the packet cap`);
	const result = await judgeMany(
		opts.client,
		packets,
		{ type: type.name, model: ctx.model, now: opts.now ?? (() => new Date().toISOString()) },
		{ maxUsd: opts.maxUsd, ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}) },
	);
	appendEdges(cwd, result.edges);
	return {
		type: type.name,
		sources: sources.length,
		no_candidates: sources.length - packets.length - capSkipped - unchanged,
		packets: packets.length + capSkipped + unchanged,
		unchanged,
		judged: result.judged,
		budget_skipped: result.skipped,
		cap_skipped: capSkipped,
		none_chosen: result.edges.filter((edge) => edge.target === null).length,
		failures: result.failures,
		edges: result.edges.length,
	};
}

function resolveCoChange(cwd: string, opts: BuildOptions): Map<string, string[]> {
	if (opts.deps?.coChange) return opts.deps.coChange;
	try {
		return coChangeFromGit(cwd, opts.since ?? DEFAULT_CO_CHANGE_SINCE);
	} catch (err) {
		// No git history is a weaker candidate set, not a failed build; the rule then yields nothing.
		opts.log?.(`co-change unavailable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
		return new Map();
	}
}

/**
 * Build the semantic graph for `cwd`. Writes the default relationships file
 * when none exists, snapshots the units, and appends one edge per judged
 * packet. Packets whose hash already carries a live judgment are skipped.
 */
/** The units the file's scope admits, unless the caller injected its own. */
export function unitsInScope(cwd: string, file: RelationshipsFile, injected: Unit[] | undefined): Unit[] {
	return injected ?? extractRepoUnits(cwd, resolveScope(file));
}

export async function buildSemanticGraph(cwd: string, opts: BuildOptions): Promise<BuildReport> {
	const log = opts.log ?? (() => undefined);
	const relationshipsWritten = writeDefaultRelationships(cwd);
	const file = loadRelationships(cwd);
	const { types, unknown } = selectTypes(file.relationships, opts.types);
	const units = unitsInScope(cwd, file, opts.deps?.units);
	saveUnits(cwd, units);
	const model = opts.model ?? JEV_DEFAULT_MODEL;
	const deps: CandidateDeps = { coChange: resolveCoChange(cwd, opts), ...(opts.deps?.graph ? { graph: opts.deps.graph } : {}) };
	const ctx: BuildContext = {
		index: buildCandidateIndex(units, cwd, deps),
		model,
		judgedHashes: liveHashes(loadEdges(cwd)),
		log,
	};
	const counts: TypeBuildCounts[] = [];
	for (const type of types) {
		counts.push(await buildType(planPackets(type, units, ctx, opts.maxPackets), opts, ctx, cwd));
	}
	return {
		relationships_written: relationshipsWritten,
		units: units.length,
		model,
		spend: opts.client.spend(),
		types: counts,
		unknown_types: unknown,
	};
}
