import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hash } from "../src/harness/semantic-graph/relation-core.js";
import { sealPlan } from "../src/harness/semantic-graph/relation-plan.js";
import { freezeRelations, loadRelationArtifact } from "../src/harness/semantic-graph/relation-freeze.js";
import { pairedRelationPlan, comparePairedRun } from "../src/harness/semantic-graph/relation-compare.js";
import { exportBundle, writeArtifactFile } from "../src/harness/semantic-graph/relation-store.js";
import { assessRelations } from "../src/lib/decision-metrics/relation-assess.js";
import type { RelationPlan } from "../src/harness/semantic-graph/relation-types.js";

const root = process.cwd();
const study = resolve(process.argv[2] ?? "semantic-relations/studies/2026-10-27-exploratory");
// C remains last. Require the complete A/B Haiku artifacts, including any failure states.
for (const name of ["A", "B"]) loadRelationArtifact(join(study, `${name}-H-result`));
const plans = ["before", "after"].map(side => {
    const original = (loadRelationArtifact(join(study, `C-${side}-input`)) as { plan: RelationPlan }).plan;
    const { id, ...body } = original;
    return sealPlan({ ...body, createdAt: new Date().toISOString(), jobs: original.jobs.filter(j => j.engine.id === "H"), sourcePlans: [id] });
});
writeArtifactFile(join(study, "C-H-protocol.json"), {
    originalProtocolDigest: hash(JSON.parse(readFileSync(join(study, "C-protocol.json"), "utf8"))),
    packetsUnchanged: true, threshold: 0.8, freshRepeats: 5, orderedTransitionInference: false,
    authenticationFix: "Preserve USER for native Claude Code keychain lookup; tools remain disabled.",
    interpretation: "Before/after categorical comparison and numeric repeat variability; neither is a drift verdict.",
});
const runs = [];
for (const [index, side] of ["before", "after"].entries()) {
    const plan = plans[index]!;
    freezeRelations(root, plan, join(study, `C-H-${side}-input`));
    const run = await assessRelations(root, plan, { fresh: true });
    exportBundle(join(study, `C-H-${side}-result`), run, "result");
    runs.push(run);
    console.log(JSON.stringify({ completed: side, cases: run.measurements.length }));
}
const paired = pairedRelationPlan(runs[0]!, runs[1]!);
freezeRelations(root, paired, join(study, "C-H-paired-input"));
const assessed = await assessRelations(root, paired);
exportBundle(join(study, "C-H-paired-result"), assessed, "result");
writeArtifactFile(join(study, "C-H-comparison.json"), comparePairedRun(assessed));
const repeats = [];
for (let i = 1; i <= 5; i++) {
    const run = await assessRelations(root, plans[0]!, { fresh: true });
    exportBundle(join(study, `C-H-repeat-${i}-result`), run, "result");
    repeats.push({ runId: run.id, observations: run.measurements.map(m => ({ logicalKey: m.logicalKey, choice: m.choice, status: m.status, raw: m.raw })) });
    console.log(JSON.stringify({ completed: `repeat-${i}`, cases: run.measurements.length }));
}
writeArtifactFile(join(study, "C-H-repeats.json"), repeats);
