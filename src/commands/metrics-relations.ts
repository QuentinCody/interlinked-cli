import { resolve } from "node:path";
import { record } from "../harness/semantic-graph/relation-core.js";
import { parseEngine, parseRelationRun } from "../harness/semantic-graph/relation-codec.js";
import { comparePairedRun, pairedRelationPlan } from "../harness/semantic-graph/relation-compare.js";
import { freezeRelations, loadRelationArtifact, planFromArtifact } from "../harness/semantic-graph/relation-freeze.js";
import { prepareRelations } from "../harness/semantic-graph/relation-plan.js";
import { loadRelationPolicy, snapshotRelations } from "../harness/semantic-graph/relation-snapshot.js";
import { exportBundle, readRelationJson, writeArtifactFile } from "../harness/semantic-graph/relation-store.js";
import type { RelationKind } from "../harness/semantic-graph/relation-types.js";
import { assessRelations } from "../lib/decision-metrics/relation-assess.js";
import { auditRelations, blindRelationPackets } from "../lib/decision-metrics/relation-audit.js";
import { RELATION_CONTRACTS } from "../lib/decision-metrics/relation-contracts.js";

export interface RelationsOptions {
    cwd?: string; output?: string; engines?: string; revision?: string; policyRevision?: string; exploratory?: boolean;
    historyTip?: string; since?: string; until?: string; maxHistory?: string; files?: string[]; maxFiles?: string;
    mode?: string; method?: string; k?: string; kinds?: string; maxPackets?: string; after?: string; assessmentRun?: string;
    outputPlan?: string; labels?: string; fresh?: boolean; json?: boolean;
}
function required(value: string | undefined, flag: string): string { if (!value) throw new Error(`${flag} is required`); return value; }
export async function relationsAction(action: string, input: string | undefined, options: RelationsOptions): Promise<number> {
    const root = resolve(options.cwd ?? process.cwd());
    try {
        let result: unknown;
        if (action === "catalog") result = RELATION_CONTRACTS;
        else if (action === "prepare") {
            result = prepareRelationCommand(options, root);
        } else if (action === "compare") {
            result = compareRelationCommand(options, input);
        } else {
            const artifact = loadRelationArtifact(resolve(required(input, "input artifact")));
            if (action === "freeze") { freezeRelations(root, planFromArtifact(artifact), resolve(required(options.output, "--output bundle directory"))); result = { frozen: resolve(options.output!), status: "exploratory" }; }
            else if (action === "assess") result = await assessRelations(root, planFromArtifact(artifact, true), { fresh: options.fresh ?? false });
            else if (action === "export") { const run = parseRelationRun(artifact); exportBundle(resolve(required(options.output, "--output bundle directory")), run, "result"); result = { exported: run.id, directory: resolve(options.output!) }; }
            else if (action === "labels") { const r = record(artifact); result = blindRelationPackets(r.schema === "interlinked.relation-run/2" ? parseRelationRun(artifact).plan : planFromArtifact(artifact)); }
            else if (action === "audit") result = auditRelations(parseRelationRun(artifact), readRelationJson(resolve(required(options.labels, "--labels"))));
            else throw new Error("unknown relation action");
        }
        if (options.output && !["freeze", "export"].includes(action)) { writeArtifactFile(resolve(options.output), result); console.log(JSON.stringify({ output: resolve(options.output) })); }
        else console.log(JSON.stringify(result, null, 2));
        return 0;
    } catch (error) { console.error(JSON.stringify({ error: error instanceof Error ? error.message : "relation command failed" })); return 1; }
}

function compareRelationCommand(options: RelationsOptions, input: string | undefined) {
    if (options.assessmentRun) {
        if (input || options.after || options.outputPlan) throw new Error("--assessment-run is exclusive with before/after/output-plan");
        return comparePairedRun(parseRelationRun(loadRelationArtifact(resolve(options.assessmentRun))));
    } else {
        const before = parseRelationRun(loadRelationArtifact(resolve(required(input, "before run"))));
        const after = parseRelationRun(loadRelationArtifact(resolve(required(options.after, "--after"))));
        const plan = pairedRelationPlan(before, after);
        writeArtifactFile(resolve(required(options.outputPlan, "--output-plan")), plan);
        return { pairedPlan: plan.id, jobs: plan.jobs.length, unmatched: plan.unmatched, next: "freeze the paired plan; assess that frozen bundle; compare --assessment-run <run>" };
    }
}

function prepareRelationCommand(options: RelationsOptions, root: string) {
    const revision = required(options.revision, "--revision");
    const policy = loadRelationPolicy(root, options.exploratory ? null : options.policyRevision ?? revision, options.exploratory ?? false);
    const value = readRelationJson(resolve(required(options.engines, "--engines")));
    if (!Array.isArray(value)) throw new Error("engines must be an array of explicit backend specifications");
    const engines = value.map(parseEngine);
    const snapshot = snapshotRelations(root, revision, { tip: required(options.historyTip, "--history-tip"), since: required(options.since, "--since"), until: required(options.until, "--until"), maxCommits: Number(options.maxHistory ?? 10000) }, { ...(options.files ? { files: options.files } : {}), maxFiles: Number(options.maxFiles ?? 2000), contextFiles: policy.policy.invariants.flatMap(i => i.contextFiles) });
    const mode = options.mode ?? "curated", method = options.method ?? "shared_rules";
    if (mode !== "curated" && mode !== "retrieved") throw new Error("mode must be curated or retrieved");
    if (method !== "shared_rules" && method !== "lexical") throw new Error("method must be shared_rules or lexical");
    const kinds = (options.kinds ?? Object.keys(RELATION_CONTRACTS).join(",")).split(",");
    if (kinds.some(k => !Object.hasOwn(RELATION_CONTRACTS, k))) throw new Error("unknown relation contract");
    return prepareRelations(snapshot, policy, engines, { mode, method, k: Number(options.k ?? 10), kinds: kinds as RelationKind[], maxPackets: Number(options.maxPackets ?? 1000) });
}
