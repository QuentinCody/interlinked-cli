// ===========================================
// Base-policy comparison — is the head policy weaker than the trusted base? (Unit F3, plan §13)
// ===========================================
// Compares two PARSED policies (never text), so a reorder, a description, a
// suite refactor or an added scenario is silent, while anything that removes
// or lowers a requirement is a named weakening. A reviewed replacement record
// (policy-changes.ts) that binds exactly this base digest and head digest
// discharges the weakening it names — the reviewed path of §13, never a
// bypass. The trusted base is chosen by the caller (`--base`) and is NOT the
// `proof.revision` comparison side (PE-74): the two bases stay independent.

import type { PolicyChangeRecord } from "./policy-changes.js";
import { policyDigest, type E2eBoundary, type E2eGates, type E2ePolicy, type E2eProject, type E2eScenario } from "./policy.js";

export type WeakeningKind = "project-removed" | "project-demoted" | "gate-loosened" | "observations-loosened" | "scope-narrowed"
    | "scenario-removed" | "scenario-demoted" | "contract-unbound" | "case-unbound" | "boundary-loosened" | "proof-dropped" | "stability-loosened";
export interface Weakening { kind: WeakeningKind; projectId: string; scenarioId?: string; detail: string; }
export interface PolicyComparison { baseDigest: string | null; headDigest: string; bootstrap: boolean; weakening: Weakening[]; replaced: Weakening[]; }

const GATE_RANK: Record<string, number> = { require: 2, warn: 1, advisory: 1, off: 0 };
const OBSERVATION_RANK: Record<string, number> = { "node-required": 2, node: 1, off: 0 };
const PROOF_RANK: Record<string, number> = { execution: 0, characterization: 1, "old-new": 2, "controlled-fault": 2 };
const GATE_KEYS = ["stop", "commit", "ci", "review"] as const;
/** An omitted gate is its EFFECTIVE default (`gateDecision`: commit/ci require; Stop reminds; review advisory), so `require → off` is a weakening even when the base wrote nothing (review F-R6). */
export const GATE_DEFAULTS: Required<E2eGates> = { stop: "warn", commit: "require", ci: "require", review: "advisory" };

function missing<T>(base: readonly T[] | undefined, head: readonly T[] | undefined): T[] { const set = new Set(head ?? []); return (base ?? []).filter(item => !set.has(item)); }
function added<T>(base: readonly T[] | undefined, head: readonly T[] | undefined): T[] { return missing(head, base); }
function gateChanges(base: E2eGates | undefined, head: E2eGates | undefined): string[] {
    return GATE_KEYS.flatMap(key => {
        const before = base?.[key] ?? GATE_DEFAULTS[key], after = head?.[key] ?? GATE_DEFAULTS[key];
        const written = (value: string, gates: E2eGates | undefined): string => gates?.[key] === undefined ? `${value} (default)` : value;
        return (GATE_RANK[after] ?? 0) < (GATE_RANK[before] ?? 0) ? [`gates.${key} ${written(before, base)} → ${written(after, head)}`] : [];
    });
}
function boundaryChanges(base: E2eBoundary | undefined, head: E2eBoundary | undefined): string[] {
    if (!base) return [];
    if (!head) return ["boundary removed"];
    const changes: string[] = [];
    if (head.entry !== base.entry) changes.push(`entry ${base.entry} → ${head.entry}`);
    if (base.service !== undefined && head.service !== base.service) changes.push(`service ${base.service} → ${head.service ?? "none"}`);
    for (const component of missing(base.real, head.real)) changes.push(`real component ${component} dropped`);
    for (const double of added(base.allowedDoubles, head.allowedDoubles)) changes.push(`double ${double} newly allowed`);
    const requests = (rows: E2eBoundary["requests"]): string[] => (rows ?? []).map(row => `${row.method} ${row.path}`);
    for (const request of missing(requests(base.requests), requests(head.requests))) changes.push(`required request ${request} dropped`);
    return changes;
}
function scenarioWeakening(projectId: string, base: E2eScenario, head: E2eScenario): Weakening[] {
    const rows: Weakening[] = [];
    const push = (kind: WeakeningKind, detail: string): number => rows.push({ kind, projectId, scenarioId: base.id, detail });
    if (base.required && !head.required) push("scenario-demoted", `scenario ${base.id} required → advisory`);
    for (const id of missing(base.contractIds, head.contractIds)) push("contract-unbound", `scenario ${base.id} no longer binds contract ${id}`);
    for (const id of missing(base.caseIds, head.caseIds)) push("case-unbound", `scenario ${base.id} no longer binds native case ${id}`);
    const shrunk = missing(base.affects, head.affects);
    if (shrunk.length) push("scope-narrowed", `scenario ${base.id} affects dropped ${shrunk.join(", ")}`);
    for (const change of boundaryChanges(base.boundary, head.boundary)) push("boundary-loosened", `scenario ${base.id}: ${change}`);
    const baseProof = base.proof?.mode ?? "execution", headProof = head.proof?.mode ?? "execution";
    if ((PROOF_RANK[headProof] ?? 0) < (PROOF_RANK[baseProof] ?? 0)) push("proof-dropped", `scenario ${base.id} proof ${baseProof} → ${headProof}`);
    if (base.stability && (!head.stability || head.stability.qualificationRuns < base.stability.qualificationRuns)) push("stability-loosened", `scenario ${base.id} stability ${base.stability.qualificationRuns} run(s) → ${head.stability?.qualificationRuns ?? "none"}`);
    return rows;
}
function scenarioRows(base: E2eProject, head: E2eProject): Weakening[] {
    return base.scenarios.flatMap(scenario => {
        const after = head.scenarios.find(row => row.id === scenario.id);
        if (!after) return [{ kind: "scenario-removed" as const, projectId: base.id, scenarioId: scenario.id, detail: `scenario ${scenario.id} removed (was ${scenario.required ? "required" : "advisory"})` }];
        return scenarioWeakening(base.id, scenario, after);
    });
}
function projectWeakening(base: E2eProject, head: E2eProject): Weakening[] {
    const rows: Weakening[] = [];
    const push = (kind: WeakeningKind, detail: string): number => rows.push({ kind, projectId: base.id, detail });
    if (base.mode === "required" && head.mode !== "required") push("project-demoted", `project ${base.id} required → ${head.mode}`);
    for (const change of gateChanges(base.gates, head.gates)) push("gate-loosened", `project ${base.id} ${change}`);
    const baseObs = base.observations?.runtimeCoverage ?? "off", headObs = head.observations?.runtimeCoverage ?? "off";
    if ((OBSERVATION_RANK[headObs] ?? 0) < (OBSERVATION_RANK[baseObs] ?? 0)) push("observations-loosened", `project ${base.id} observations ${baseObs} → ${headObs}`);
    const narrowed = missing(base.protectedInputs, head.protectedInputs);
    if (narrowed.length) push("scope-narrowed", `project ${base.id} protectedInputs dropped ${narrowed.join(", ")}`);
    return [...rows, ...scenarioRows(base, head)];
}
/** A record discharges a weakening when it binds exactly these digests and names the project and (unless it covers the project) the scenario. */
function replacedBy(records: readonly PolicyChangeRecord[], baseDigest: string, headDigest: string, row: Weakening): boolean {
    return records.some(record => record.baseDigest === baseDigest && record.headDigest === headDigest && record.projectId === row.projectId && (record.scenarioId === undefined || record.scenarioId === row.scenarioId));
}
/** Head against base. `base === null` is first adoption (PE-38): a bootstrap, nothing to weaken. */
export function comparePolicies(base: E2ePolicy | null, head: E2ePolicy, records: readonly PolicyChangeRecord[]): PolicyComparison {
    const headDigest = policyDigest(head);
    if (!base) return { baseDigest: null, headDigest, bootstrap: true, weakening: [], replaced: [] };
    const baseDigest = policyDigest(base);
    const all = base.projects.flatMap(project => {
        const after = head.projects.find(row => row.id === project.id);
        return after ? projectWeakening(project, after) : [{ kind: "project-removed" as const, projectId: project.id, detail: `project ${project.id} removed from the policy` }];
    });
    const replaced = all.filter(row => replacedBy(records, baseDigest, headDigest, row));
    return { baseDigest, headDigest, bootstrap: false, weakening: all.filter(row => !replaced.includes(row)), replaced };
}
