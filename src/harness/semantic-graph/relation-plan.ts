import { dirname, posix, relative } from "node:path";
import { parseImports } from "../project-graph/parser-imports.js";
import { buildCandidateIndex, candidatesFor, nameTokens, type ImportGraphView } from "./candidates.js";
import { hash, integer, unique } from "./relation-core.js";
import { makeRelationPacket, selectUnits, unitLogicalKey } from "./relation-packet.js";
import type { ImportEdge } from "../types.js";
import type { CandidateCoverage, EngineSpec, InvariantDefinition, PolicyReference, RelationKind, RelationPacket, RelationPlan, RelationSnapshot } from "./relation-types.js";
import type { Unit } from "./types.js";
import { RELATION_CONTRACTS } from "../../lib/decision-metrics/relation-contracts.js";

// Reuse the graph parser, but resolve exclusively against the immutable snapshot.
// Bare imports are not guessed. Their omission is reported by the snapshot graph.
export function snapshotGraph(snapshot: RelationSnapshot, root: string): { graph: ImportGraphView; unresolved: string[] } {
    const edges = new Map<string, ImportEdge[]>(), reverse = new Map<string, string[]>();
    const unresolved: string[] = [];
    for (const [file, source] of Object.entries(snapshot.files)) {
        for (const edge of parseImports(source.text, file)) {
            const specifier = edge.specifier;
            if (!specifier.startsWith(".")) { unresolved.push(`${file}:${specifier}`); continue; }
            const base = posix.normalize(posix.join(dirname(file), specifier));
            const stem = base.replace(/\.[cm]?jsx?$/, "");
            const target = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`].find(p => Object.hasOwn(snapshot.files, p));
            if (!target) { unresolved.push(`${file}:${specifier}`); continue; }
            edges.set(file, [...(edges.get(file) ?? []), { ...edge, fromFile: `${root}/${file}`, toFile: `${root}/${target}` }]);
            reverse.set(target, [...(reverse.get(target) ?? []), `${root}/${file}`]);
        }
    }
    return { graph: { getDependencies: file => edges.get(relative(root, file)) ?? [], getDependents: file => reverse.get(relative(root, file)) ?? [] }, unresolved };
}
export function lexicalCandidates(query: string, units: Unit[], k: number): Unit[] {
    const words = nameTokens(query);
    return units.map(unit => ({ unit, score: [...words].filter(word => nameTokens(`${unit.name} ${unit.text}`).has(word)).length }))
        .sort((a, b) => b.score - a.score || a.unit.id.localeCompare(b.unit.id)).slice(0, k).map(row => row.unit);
}
export function sealPlan(value: Omit<RelationPlan, "id">): RelationPlan { return { ...value, id: hash(value) }; }
export interface PrepareRelationsOptions {
    mode: "curated" | "retrieved"; method: "shared_rules" | "lexical"; k: number;
    kinds: RelationKind[]; maxPackets: number;
}
export function prepareRelations(snapshot: RelationSnapshot, policy: PolicyReference, engines: EngineSpec[], options: PrepareRelationsOptions): RelationPlan {
    integer(options.k, 2, 12); integer(options.maxPackets, 1, 10000);
    unique(engines.map(e => e.id), "engine id");
    if (!engines.length) throw new Error("explicit engines required");
    const root = "/snapshot";
    const { graph, unresolved } = snapshotGraph(snapshot, root);
    const index = buildCandidateIndex(snapshot.units, root, { graph, coChange: new Map(Object.entries(snapshot.history.map)) });
    const packets: RelationPacket[] = [], coverage: CandidateCoverage[] = [];
    for (const invariant of policy.policy.invariants) {
        const { selected, anchor, selectedIds } = recordInvariantSelection(snapshot, invariant, options, index, unresolved, coverage);
        appendParticipantPackets(policy, options, packets, invariant, snapshot, selected, anchor);
        appendGroupPackets(invariant, snapshot, selectedIds, options, packets);
    }
    // Retain every excluded packet so assessment/recall denominators cannot shrink.
    const deduped = [...new Map(packets.map(p => [p.id, p])).values()];
    if (options.mode === "retrieved" && options.method === "shared_rules" && snapshot.history.status !== "available") {
        for (const packet of deduped) { markPacketMissing(packet, "history_unavailable"); }
    }
    for (const packet of deduped.slice(options.maxPackets)) {
        markPacketMissing(packet, "packet_budget_exceeded");
    }
    return sealPlan({ schema: "interlinked.relation-plan/1", kind: "single_snapshot", createdAt: new Date().toISOString(), policy, jobs: engines.map(engine => ({ id: hash({ engine, snapshot: snapshot.digest, packets: deduped.map(p => p.id) }), side: "single", snapshot, packets: deduped, engine })), coverage, sourcePlans: [], experimental: true, unmatched: missingLogicalUnits(snapshot), contractDigest: hash(RELATION_CONTRACTS) });
}
function appendParticipantPackets(policy: PolicyReference, options: PrepareRelationsOptions, packets: RelationPacket[], invariant: InvariantDefinition, snapshot: RelationSnapshot, selected: Unit[], anchor: Unit | undefined) {
    const add = (kind: RelationKind, participants: Unit[], scenario = null as typeof policy.policy.scenarios[number] | null, role = null as "enforces" | "assumes" | "propagates" | "reports" | "tests" | null) => {
        if (options.kinds.includes(kind)) packets.push(makeRelationPacket(kind, invariant, participants, snapshot, scenario, role));
    };
    for (const unit of selected) {
        add("invariant_membership", [unit]);
        for (const role of ["enforces", "assumes", "propagates", "reports", "tests"] as const) add("invariant_role", [unit], null, role);
        if (anchor && unit.id !== anchor.id) {
            add("invariant_compatibility", [anchor, unit]);
            for (const scenario of policy.policy.scenarios.filter(s => s.invariantId === invariant.id)) {
                add("semantic_coupling", [anchor, unit], scenario);
                add("semantic_coupling", [unit, anchor], scenario);
            }
        }
    }
}

function missingLogicalUnits(snapshot: RelationSnapshot): string[] {
    const counts = new Map<string, number>();
    for (const unit of snapshot.units) counts.set(unitLogicalKey(unit), (counts.get(unitLogicalKey(unit)) ?? 0) + 1);
    return [...counts].filter(([, count]) => count > 1).map(([id]) => `ambiguous:${id}`);
}

function appendGroupPackets(invariant: InvariantDefinition, snapshot: RelationSnapshot, selectedIds: Set<string>, options: PrepareRelationsOptions, packets: RelationPacket[]): void {
    for (const selectors of invariant.groups) {
        const members = selectors.flatMap(selector => { const found = selectUnits(snapshot.units, selector); return found.length === 1 ? found : []; });
        const expected = selectors.map(selector => { const found = selectUnits(snapshot.units, selector); return found.length === 1 ? unitLogicalKey(found[0]!) : `unresolved:${selector}`; });
        const packet = makeRelationPacket("invariant_group", invariant, members, snapshot, null, null, 24000, expected);
        if (members.length !== selectors.length || members.some(u => !selectedIds.has(u.id))) {
            markPacketMissing(packet, "incomplete_group");
        }
        if (options.kinds.includes("invariant_group")) packets.push(packet);
    }
}

function retrieveInvariantCandidates(snapshot: RelationSnapshot, invariant: InvariantDefinition, options: PrepareRelationsOptions, index: ReturnType<typeof buildCandidateIndex>, anchor: Unit | undefined): Unit[] {
    return !anchor ? [] : options.method === "lexical"
        ? lexicalCandidates(`${invariant.statement} ${anchor.text}`, snapshot.units.filter(u => u.id !== anchor.id && u.kind === "function"), options.k)
        : candidatesFor(anchor, { name: invariant.id, description: invariant.statement, source_kind: anchor.kind, target_kind: "function", question: "Candidate only", none_description: "No candidate", candidate_rules: ["import_edge", "co_change", "companion", "name_match", "same_file"], k: options.k }, index);
}

function recordInvariantSelection(snapshot: RelationSnapshot, invariant: InvariantDefinition, options: PrepareRelationsOptions, index: ReturnType<typeof buildCandidateIndex>, unresolved: string[], coverage: CandidateCoverage[]) {
    const missingSelectors: string[] = [];
    const references = invariant.participants.flatMap(selector => {
        const selected = selectUnits(snapshot.units, selector);
        if (selected.length !== 1) { missingSelectors.push(`${selector}:${selected.length ? "ambiguous" : "missing"}`); return []; }
        return selected;
    });
    const anchors = selectUnits(snapshot.units, invariant.participants[0] ?? "");
    const anchor = anchors.length === 1 ? anchors[0] : undefined;
    const retrieved = retrieveInvariantCandidates(snapshot, invariant, options, index, anchor);
    const selected = options.mode === "curated" ? references : anchor ? [anchor, ...retrieved] : [];
    const selectedIds = new Set(selected.map(u => u.id));
    const reference = invariant.participants.slice(1).map(selector => { const found = selectUnits(snapshot.units, selector); return found.length === 1 ? found[0]!.id : `unresolved:${selector}`; });
    coverage.push({ invariantId: invariant.id, method: options.mode === "curated" ? "curated" : options.method, mode: options.mode, limit: options.k, universe: snapshot.units.length, selected: selected.filter(u => u.id !== anchor?.id).map(u => u.id), reference, recovered: reference.filter(id => selectedIds.has(id)), missingSelectors, historyAvailable: snapshot.history.status === "available", omissions: [...snapshot.omitted, ...unresolved.map(p => `unresolved_import:${p}`)] });
    return { selected, anchor, selectedIds };
}

function markPacketMissing(packet: RelationPacket, reason: string): void {
    packet.missing.push(reason); packet.complete = false;
    packet.evidenceHash = hash({ evidence: packet.evidence, dependencies: packet.dependencies, missing: packet.missing });
    packet.id = hash({ logicalKey: packet.logicalKey, evidenceHash: packet.evidenceHash });
}
