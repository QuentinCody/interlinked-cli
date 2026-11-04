import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRelationArtifact } from "../src/harness/semantic-graph/relation-freeze.js";
import { parseRelationRun } from "../src/harness/semantic-graph/relation-codec.js";
import { parseRelationLabels } from "../src/lib/decision-metrics/relation-audit.js";
import { hash } from "../src/harness/semantic-graph/relation-core.js";
import type { RelationLabel } from "../src/lib/decision-metrics/relation-audit.js";
import type { RelationMeasurement, RelationRun } from "../src/harness/semantic-graph/relation-types.js";

const study = resolve(process.argv[2] ?? "semantic-relations/studies/2026-10-27-exploratory");
const read = <T>(name: string): T => JSON.parse(readFileSync(join(study, name), "utf8")) as T;
const run = (name: string) => parseRelationRun(loadRelationArtifact(join(study, name)));
const count = (values: string[]) => values.reduce<Record<string, number>>((a, v) => { a[v] = (a[v] ?? 0) + 1; return a; }, {});
function top(m: RelationMeasurement): string | null {
    if (!m.raw || m.raw.kind === "yes_no" || ["failed", "unassessed"].includes(m.status)) return null;
    const ranked = Object.entries(m.raw.probabilities).sort((a, b) => b[1] - a[1]);
    return ranked[0] && ranked[0][1] !== ranked[1]?.[1] ? ranked[0][0] : null;
}
function summarize(measurements: RelationMeasurement[], labels: RelationLabel[]) {
    const references = new Map(labels.map(l => [l.packetId, l.choice]));
    const answered = measurements.filter(m => m.status === "answered");
    const resolved = measurements.filter(m => ["answered", "insufficient_evidence"].includes(m.status));
    const correct = (m: RelationMeasurement) => m.choice === references.get(m.packetId);
    return {
        n: measurements.length, statuses: count(measurements.map(m => m.status)),
        answeredCorrect: answered.filter(correct).length, answered: answered.length,
        resolvedCorrect: resolved.filter(correct).length, resolved: resolved.length,
        retrospectiveArgmaxCorrect: measurements.filter(m => top(m) !== null && top(m) === references.get(m.packetId)).length,
        retrospectiveArgmaxUnique: measurements.filter(m => top(m) !== null).length,
        referenceCounts: count(measurements.map(m => references.get(m.packetId) ?? "unlabeled")),
        knownCostUsd: measurements.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
        unknownCostObservations: measurements.filter(m => m.calls > 0 && m.costUsd === null).length,
        calls: measurements.reduce((sum, m) => sum + m.calls, 0),
        latencyMs: measurementLatency(measurements),
        servedModels: [...new Set(measurements.map(m => m.servedModel).filter(Boolean))],
        errors: measurements.filter(m => m.status === "failed").map(m => ({ packetId: m.packetId, reason: m.reason })),
        resolvedDisagreements: resolved.filter(m => !correct(m)).map(m => ({ packetId: m.packetId, kind: m.recordKind, reference: references.get(m.packetId), choice: m.choice, raw: m.raw })),
    };
}
const cohorts = ["A", "B", "fixtures", "fixtures-neutral", "B-targeted"].map(name => {
    const j = run(name === "B" ? "B-retry-result" : `${name}-result`);
    const h = name === "fixtures-neutral" ? j : run(`${name}-H-result`);
    const jLabels = parseRelationLabels(read(`${name}-labels.json`), j.plan).labels;
    const hLabels = parseRelationLabels(read(`${name}${name === "fixtures-neutral" ? "" : "-H"}-labels.json`), h.plan).labels;
    const jm = j.measurements.filter(m => m.armId === "J"), hm = h.measurements.filter(m => m.armId === "H");
    if (hash(jm.map(m => m.packetId).sort()) !== hash(hm.map(m => m.packetId).sort())) throw new Error(`${name}: unmatched H/J packet cohorts`);
    const kinds = [...new Set(jm.map(m => m.recordKind))];
    const byKind = kinds.map(kind => ({ kind, J: summarize(jm.filter(m => m.recordKind === kind), jLabels), H: summarize(hm.filter(m => m.recordKind === kind), hLabels) }));
    return { name, J: summarize(jm, jLabels), H: summarize(hm, hLabels), byKind, runs: { J: j.id, H: h.id }, labels: { J: hash(jLabels), H: hash(hLabels) } };
});
const coverage = read<{ candidateCoverage: Array<{ method: string; k: number; recovered: number; reference: number; missingSelectors: string[]; historyAvailable: boolean }> }>("A-audit.json").candidateCoverage;
const candidateCoverage = [3, 6, 10, 12].flatMap(k => ["shared_rules", "lexical"].map(method => {
    const rows = coverage.filter(c => c.k === k && c.method === method);
    return { k, method, recovered: rows.reduce((sum, r) => sum + r.recovered, 0), reference: rows.reduce((sum, r) => sum + r.reference, 0), missingSelectors: rows.flatMap(r => r.missingSelectors), historyAvailable: rows.every(r => r.historyAvailable) };
}));
const baselines = ["A", "B"].flatMap(name => {
    const reference = new Map(read<{ labels: RelationLabel[] }>(`${name}-labels.json`).labels.map(l => [l.packetId, l.choice]));
    const baseline = read<{ predictions: Array<{ packetId: string; kind: string; structural: string; lexical: string }> }>(`${name}-baselines.json`);
    return ["structural", "lexical"].flatMap(method => [...new Set(baseline.predictions.map(p => p.kind))].map(kind => {
        const rows = baseline.predictions.filter(p => p.kind === kind);
        return { cohort: name, kind, method, n: rows.length, correct: rows.filter(p => p[method as "structural" | "lexical"] === reference.get(p.packetId)).length };
    }));
});
type Repeat = { runId: string; observations: Array<Pick<RelationMeasurement, "logicalKey" | "choice" | "status" | "raw">> };
const repetitionSummary = (name: string) => {
    const repeats = read<Repeat[]>(name);
    return repeats[0]!.observations.map(first => {
        const rows = repeats.map(r => r.observations.find(o => o.logicalKey === first.logicalKey)!);
        const probabilities = rows.map(r => r.raw && r.raw.kind !== "yes_no" ? r.raw.probabilities : null);
        const options = [...new Set(probabilities.flatMap(p => p ? Object.keys(p) : []))];
        const ranges = Object.fromEntries(options.map(o => {
            const values = probabilities.flatMap(p => p?.[o] === undefined ? [] : [p[o]!]);
            return [o, values.length ? Math.max(...values) - Math.min(...values) : null];
        }));
        return { logicalKey: first.logicalKey, repeats: rows.length, states: count(rows.map(r => `${r.status}:${r.choice}`)), completeProbabilities: probabilities.every(Boolean), ranges };
    });
};
type Comparison = { rows: Array<{ armId: string; outcome: string; reason: string }>; unmatched: string[] };
const comparisons = [{ arm: "J", condition: "original identifiers" }, { arm: "J", condition: "neutral identifiers" }, { arm: "H", condition: "neutral identifiers" }].map(({ arm, condition }) => {
    const neutral = condition === "neutral identifiers";
    const data = read<Comparison>(neutral ? "C-neutral-comparison.json" : "C-comparison.json");
    const rows = data.rows.filter(r => r.armId === arm);
    const repeats = repetitionSummary(neutral ? `C-neutral-${arm}-repeats.json` : "C-repeats.json");
    const repeatedRuns: RelationRun[] = Array.from({ length: 5 }, (_, i) => run(neutral ? `C-neutral-${arm}-repeat-${i + 1}-result` : `C-repeat-${i + 1}.json`));
    const comparisonRuns = ["before", "after"].map(side => run(neutral ? `C-neutral-${side}-result` : `C-${side}-run.json`));
    const measurements = [...repeatedRuns, ...comparisonRuns].flatMap(r => r.measurements.filter(m => m.armId === arm));
    return { arm, condition, rows: rows.length, outcomes: count(rows.map(r => r.outcome)), unmatched: data.unmatched.filter(u => u.startsWith(`${arm}:`)).length, repeats, knownCostUsd: measurements.reduce((sum, m) => sum + (m.costUsd ?? 0), 0), statuses: count(measurements.map(m => m.status)), observations: measurements.length };
});
const failedB = run("B-result").measurements.filter(m => m.armId === "J");
const originalProtocol = read<Record<string, unknown>>("protocol.json");
const { sourceImplementationCommit: legacyCommitName, ...protocolBody } = originalProtocol;
const protocol = { ...protocolBody, baselineSourceCommit: originalProtocol.baselineSourceCommit ?? legacyCommitName, originalProtocolDigest: hash(originalProtocol), implementationProvenance: "Uncommitted implementation bytes are retained in input freezes; the baseline Git commit does not identify them. B retry retains the original frozen plan but has no separate execution freeze; see provenance-amendment.json." };
const summary = { schema: "interlinked.semantic-study-summary/1", protocol, threshold: .8, candidateCoverage, cohorts, baselines, comparisons, retainedInitialB: summarize(failedB, read<{ labels: RelationLabel[] }>("B-labels.json").labels), qualification: "Exploratory model-reference and authored-fixture diagnostics only; no deployment or scale qualification." };
writeFileSync(join(study, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
const lines = ["# Computed experiment results", "", "Generated by `semantic-relations/summarize-experiments.ts`. Full-cohort matches include correctly selected insufficient-evidence; abstentions, failures and unassessed cases remain in N. Answered matches exclude insufficient-evidence. Argmax is a retrospective diagnostic with tied maxima unresolved, not a replacement for the frozen 0.80 threshold.", "", "## Candidate coverage", "", "| k | Method | Recovered / registry counterparts |", "| --- | --- | --- |", ...candidateCoverage.map(c => `| ${c.k} | ${c.method} | ${c.recovered} / ${c.reference} |`), "", "## Frozen-threshold judgments", "", "| Cohort | Contract | Arm | N | Answered matches / answered | Resolved matches / N | Abstained | Insufficient evidence | Failed | Unassessed |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
for (const c of cohorts) for (const row of c.byKind) for (const arm of ["J", "H"] as const) {
    const s = row[arm];
    lines.push(`| ${c.name} | ${row.kind} | ${arm} | ${s.n} | ${s.answeredCorrect} / ${s.answered} | ${s.resolvedCorrect} / ${s.n} | ${s.statuses.abstained ?? 0} | ${s.statuses.insufficient_evidence ?? 0} | ${s.statuses.failed ?? 0} | ${s.statuses.unassessed ?? 0} |`);
}
lines.push("", "## Retrospective argmax and runtime", "", "J costs are adapter estimates at $0.042 per million input tokens. H costs are Claude CLI reported list-equivalent usage under the user's subscription, not an incremental invoice. Latencies include CLI startup and the first canary where applicable; hardware and concurrent workloads were uncontrolled.", "", "| Cohort | Arm | Unique argmax matches / N | Unique maxima | Known USD | Calls | p50 / p95 ms |", "| --- | --- | --- | --- | --- | --- | --- |");
for (const c of cohorts) for (const arm of ["J", "H"] as const) {
    const s = c[arm];
    lines.push(`| ${c.name} | ${arm} | ${s.retrospectiveArgmaxCorrect} / ${s.n} | ${s.retrospectiveArgmaxUnique} | ${s.knownCostUsd.toFixed(6)} | ${s.calls} | ${s.latencyMs.p50} / ${s.latencyMs.p95} |`);
}
lines.push("", "## Naive controls", "", "Structural means same-file or forward import; lexical uses Jaccard ≥0.15. Matches map to related/update; role is always absent and compatibility/group always compatible. These controls are not optimized baselines.", "", "| Cohort | Contract | Control | Matches / N |", "| --- | --- | --- | --- |", ...baselines.map(b => `| ${b.cohort} | ${b.kind} | ${b.method} | ${b.correct} / ${b.n} |`), "", "## Before/after controls and fresh repeats", "", "| Arm / condition | Same assessment | Changed assessment | Non-comparable | Unmatched | Stable categorical states across 5 repeats | Largest probability-component range |", "| --- | --- | --- | --- | --- | --- | --- |");
for (const c of comparisons) lines.push(`| ${c.arm} / ${c.condition} | ${c.outcomes.same_assessment ?? 0} | ${c.outcomes.changed_assessment ?? 0} | ${c.outcomes.non_comparable ?? 0} | ${c.unmatched} | ${c.repeats.filter(r => Object.keys(r.states).length === 1).length} / ${c.repeats.length} | ${Math.max(...c.repeats.flatMap(r => Object.values(r.ranges).filter((v): v is number => v !== null))).toFixed(3)} |`);
lines.push("", "Stability uses status plus choice, so a malformed-response failure also counts as unstable. Probability ranges use valid available responses; the neutral J repetitions include one failed observation. These are observed ranges, not statistical noise bounds.", "", "| C arm / condition | Observations (before + after + repeats) | Known USD | Failed |", "| --- | --- | --- | --- |", ...comparisons.map(c => `| ${c.arm} / ${c.condition} | ${c.observations} | ${c.knownCostUsd.toFixed(6)} | ${c.statuses.failed ?? 0} |`), "", `The retained initial broad B/J attempt has ${summary.retainedInitialB.statuses.abstained ?? 0} abstentions, ${summary.retainedInitialB.statuses.failed ?? 0} failures and ${summary.retainedInitialB.statuses.unassessed ?? 0} unassessed cases; known cost is $${summary.retainedInitialB.knownCostUsd.toFixed(6)} with ${summary.retainedInitialB.unknownCostObservations} unknown-cost observation. Primary B tables use the declared fresh full-cohort retry.`, "", "Categorical comparison is not a preservation, drift or repair verdict. See REPORT.md for sample construction, limitations and the product decision.", "");
writeFileSync(join(study, "RESULTS.md"), lines.join("\n"));
console.log(JSON.stringify({ cohorts: cohorts.map(c => ({ name: c.name, J: c.J, H: c.H })), comparisons: comparisons.map(({ repeats, ...c }) => ({ ...c, stable: repeats.filter(r => Object.keys(r.states).length === 1).length })), candidateCoverage }, null, 2));

function measurementLatency(measurements: RelationMeasurement[]) {
    const latency = measurements.filter(m => m.calls > 0 && !m.cached).map(m => m.durationMs).sort((a, b) => a - b);
    return { p50: latency[Math.max(0, Math.ceil(latency.length * .5) - 1)] ?? null, p95: latency[Math.max(0, Math.ceil(latency.length * .95) - 1)] ?? null };
}
