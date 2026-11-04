import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { hash } from "../src/harness/semantic-graph/relation-core.js";
import { gitText } from "../src/harness/semantic-graph/relation-history.js";
import { loadRelationPolicy, snapshotRelations } from "../src/harness/semantic-graph/relation-snapshot.js";
import { freezeRelations, loadRelationArtifact, planFromArtifact } from "../src/harness/semantic-graph/relation-freeze.js";
import { writeArtifactFile, exportBundle } from "../src/harness/semantic-graph/relation-store.js";
import { parseRelationRun } from "../src/harness/semantic-graph/relation-codec.js";
import { assessRelations } from "../src/lib/decision-metrics/relation-assess.js";
import { auditRelations } from "../src/lib/decision-metrics/relation-audit.js";
import { fixtureRelationPlan } from "../src/lib/decision-metrics/relation-fixtures.js";
import { naturalRelationStudies, compactBlindReview } from "../src/lib/decision-metrics/relation-study.js";
import { haikuIdentity } from "../src/lib/decision-metrics/relation-haiku.js";
import { RELATION_CONTRACTS } from "../src/lib/decision-metrics/relation-contracts.js";
import type { EngineSpec } from "../src/harness/semantic-graph/relation-types.js";

const root = resolve(process.cwd()), action = process.argv[2] ?? "prepare", study = resolve(process.argv[3] ?? "semantic-relations/studies/2026-10-27-exploratory");
mkdirSync(study, { recursive: true });
if (action === "prepare") {
    const engines: EngineSpec[] = [
        { id: "D", backend: "ollama", model: "clef-flash:9b", identity: "unavailable:not-installed", command: "thinkthen", endpoint: "http://127.0.0.1:11434", effort: null, maxCalls: 450, maxUsd: 1, timeoutMs: 30000, band: [.2,.8] },
        { id: "J", backend: "typesafe", model: "jev-1.14.0", identity: "jev-1.14.0", command: null, endpoint: "https://api.typesafe.ai/v1/systemone", effort: null, maxCalls: 450, maxUsd: 2, timeoutMs: 20000, band: [.2,.8] },
        { id: "H", backend: "haiku", model: "claude-haiku-5-5", identity: haikuIdentity("/Users/quentincody/.local/bin/claude", "claude-haiku-5-5"), command: "/Users/quentincody/.local/bin/claude", endpoint: null, effort: "low", maxCalls: 450, maxUsd: 8, timeoutMs: 90000, band: [.2,.8] },
    ];
    writeArtifactFile(join(study, "engines.json"), engines);
    const revision = gitText(root, ["rev-parse", "HEAD"]), until = gitText(root, ["show", "-s", "--format=%cI", revision]);
    const scope = gitText(root, ["ls-tree", "-r", "--name-only", revision]).split("\n").filter(p => p.startsWith("src/harness/") && /\.ts$/.test(p) && !/\.test\.|__tests__|\/__fixtures__/.test(p) && /coverage|test-|verification|evidence|obligation|gate|check-engine\/tool-runners/.test(p));
    const policy = loadRelationPolicy(root, null, true);
    const snapshot = snapshotRelations(root, revision, { tip: revision, since: "2026-01-01T00:00:00Z", until, maxCommits: 10000 }, { files: scope, maxFiles: 600, contextFiles: policy.policy.invariants.flatMap(i => i.contextFiles) });
    writeArtifactFile(join(study, "snapshot.json"), snapshot);
    const fixtures = fixtureRelationPlan(engines);
    const studies = naturalRelationStudies(snapshot, policy, engines);
    writeArtifactFile(join(study, "selection.json"), studies.selection);
    writeArtifactFile(join(study, "fixture-checks.json"), fixtures.checks);
    for (const [name, plan] of [["fixtures", fixtures.plan], ["A", studies.A], ["B", studies.B]] as const) {
        writeArtifactFile(join(study, `${name}-plan.json`), plan);
        freezeRelations(root, plan, join(study, `${name}-input`));
        const blind = compactBlindReview(plan) as { cases: unknown[]; units: unknown[]; [key: string]: unknown };
        writeArtifactFile(join(study, `${name}-blind.json`), { ...blind, contracts: RELATION_CONTRACTS });
    }
    writeArtifactFile(join(study, "fixtures-labels.json"), fixtures.labels);
    const preflights = ["h-canary.json", "j-preflight.json", "j-pinned-preflight.json", "jev-models.json"].map(name => ({ name, bytes: readFileSync(join(root, "scratch/semantic-relations-implementation", name), "utf8") }));
    writeArtifactFile(join(study, "preflights.json"), preflights.map(p => ({ name: p.name, result: JSON.parse(p.bytes) })));
    writeArtifactFile(join(study, "protocol.json"), { version: 1, status: "exploratory", sourceRevision: revision, planDigests: { fixtures: fixtures.plan.id, A: studies.A.id, B: studies.B.id }, referenceSource: "GPT-6 Astra blind source review, no human review", fixtures: "Executed behavior checks + authored semantic expectations", naturalCaseCount: 400, split: "development only", threshold: .8, candidateBudgets: [3,6,10,12], noDownloads: true, C: "run after A/B; comparison only unless separately qualified", labelsBlinded: true, baselineSourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"}).trim(), referenceFileHash: hash(RELATION_CONTRACTS) });
    console.log(JSON.stringify({ study, snapshotUnits: snapshot.units.length, files: Object.keys(snapshot.files).length, fixtures: 16, A: 200, B: 200, history: snapshot.history.status }));
} else if (action === "assess") {
    const name = process.argv[4]; if (!name || !["fixtures", "A", "B"].includes(name)) throw new Error("specify fixtures, A or B");
    const plan = planFromArtifact(loadRelationArtifact(join(study, process.argv[5] ?? `${name}-input`)), true);
    let n = 0;
    const run = await assessRelations(root, plan, { fresh: true, onMeasurement: m => { if (++n % 20 === 0 || m.status === "failed") console.log(JSON.stringify({ progress: n, arm: m.armId, status: m.status, reason: m.reason })); } });
    writeArtifactFile(join(study, `${name}-run.json`), run); exportBundle(join(study, `${name}-result`), run, "result");
    if (name === "fixtures") writeArtifactFile(join(study, "fixtures-audit.json"), auditRelations(run, JSON.parse(readFileSync(join(study, "fixtures-labels.json"), "utf8"))));
    console.log(JSON.stringify({ finished: name, measurements: run.measurements.length }));
} else if (action === "audit") {
    for (const name of ["fixtures", "A", "B"]) {
        const run = parseRelationRun(loadRelationArtifact(join(study, `${name}-run.json`)));
        const labels = JSON.parse(readFileSync(join(study, `${name}-labels.json`), "utf8"));
        writeFileSync(join(study, `${name}-audit.json`), JSON.stringify(auditRelations(run, labels), null, 2));
    }
} else throw new Error("expected prepare, assess or audit");
