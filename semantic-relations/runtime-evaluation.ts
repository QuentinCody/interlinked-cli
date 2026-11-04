import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hash, textHash } from "../src/harness/semantic-graph/relation-core.js";
import { haikuIdentity } from "../src/lib/decision-metrics/relation-haiku.js";
import { loadRelationArtifact } from "../src/harness/semantic-graph/relation-freeze.js";
import { parseRelationRun } from "../src/harness/semantic-graph/relation-codec.js";
import type { EngineSpec, InvariantDefinition, RelationPlan } from "../src/harness/semantic-graph/relation-types.js";

const root = resolve(process.cwd());
const study = join(root, "semantic-relations/studies/2026-10-27-runtime");
const repo = join(root, "scratch/semantic-relations-runtime/repo");
const action = process.argv[2] ?? "prepare";
mkdirSync(study, { recursive: true });
const save = (name: string, value: unknown) => writeFileSync(join(study, name), `${JSON.stringify(value, null, 2)}\n`);
const read = <T>(name: string): T => JSON.parse(readFileSync(join(study, name), "utf8")) as T;
const cli = join(root, "dist/index.js");
function command(name: string, args: string[], withCredentials = false) {
    const environment = { ...process.env };
    if (withCredentials && !environment.TYPESAFE_API_KEY) {
        const config = JSON.parse(readFileSync(join(root, ".interlinked/config.local.json"), "utf8"));
        environment.TYPESAFE_API_KEY = config.TYPESAFE_API_KEY ?? config.typesafe_api_key;
    }
    const started = Date.now();
    const result = spawnSync(process.execPath, [cli, "metrics", "decisions", "relations", ...args], { cwd: root, env: environment, encoding: "utf8", timeout: 600_000, maxBuffer: 1_000_000 });
    const receipt = { name, args, exitCode: result.status, durationMs: Date.now() - started, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null };
    let attempt = 1;
    while (existsSync(join(study, `${name}-command-${attempt}.json`))) attempt++;
    save(`${name}-command-${attempt}.json`, receipt);
    console.log(JSON.stringify({ name, exitCode: result.status, durationMs: receipt.durationMs }));
    if (result.status !== 0) throw new Error(`${name} failed; inspect saved command receipt`);
}
const selector = (file: string, name: string) => `${file}#function:${name}`;
function assessControl(name: string): void {
    const planPath = join(study, `${name}-plan.json`), inputPath = join(study, `${name}-input`), runPath = join(study, `${name}-run.json`);
    const plan = read<RelationPlan>(`${name}-plan.json`);
    // The product retains over-budget packets as unassessed, rather than dropping them.
    if (plan.jobs.some(job => job.packets.filter(packet => packet.complete).length !== 3 || job.packets.some(packet => packet.complete && packet.invariantId !== "runtime.completed-verdict"))) throw new Error("Unexpected control cohort");
    command(`${name}-freeze`, ["freeze", planPath, "--cwd", repo, "--output", inputPath]);
    command(`${name}-assess`, ["assess", inputPath, "--cwd", repo, "--fresh", "--output", runPath], true);
    command(`${name}-export`, ["export", runPath, "--cwd", repo, "--output", join(study, `${name}-result`)]);
}
const definitions: InvariantDefinition[] = [
    {
        id: "runtime.completed-verdict", version: "1",
        statement: "A null child-process exit code is no completed verification verdict. Every reporting path must retain that distinction in its exit behavior, diagnostic and deferred telemetry.",
        applicability: "The supplied resource-command and supervised CLI outcome paths. A child's own numeric exit 75 is distinct from a null exit status.",
        clauses: ["A nullable process code with killed=false and timedOut=false is possible after an external signal or spawn failure.", "No completion may be inferred from the absence of a local cancellation flag."], exceptions: [],
        participants: [selector("src/harness/resource-command.ts", "describeResourceCommandOutcome"), selector("src/harness/resource-cli.ts", "runSupervisedCli"), selector("src/harness/resource-command.ts", "commandStatus")],
        groups: [[selector("src/harness/resource-command.ts", "describeResourceCommandOutcome"), selector("src/harness/resource-cli.ts", "runSupervisedCli")]], contextFiles: [],
    },
    {
        id: "runtime.worker-memory", version: "1",
        statement: "An absolute max-old-space-size setting must not be treated as a portable upper bound on total V8 heap. A total-heap assertion must account for the actual runtime's overhead.",
        applicability: "Node worker command generation and the supplied runtime measurements, across Node 22 and 25. Old-generation configuration and total heap are different quantities.",
        clauses: ["A smaller configured old-space cap must be preserved.", "The observed total heap for a 1536 MiB old-space cap is 1584 MiB on Node 22 and 1728 MiB on Node 25 in this environment."], exceptions: [],
        participants: [selector("src/harness/node-heap-limit.ts", "boundedNodeHeap"), selector("src/harness/test-execution.ts", "testCommand"), selector("src/harness/resource-cli.ts", "runSupervisedCli")],
        groups: [[selector("src/harness/node-heap-limit.ts", "boundedNodeHeap"), selector("src/harness/test-execution.ts", "testCommand")]], contextFiles: ["runtime/heap-measurements.json"],
    },
    {
        id: "runtime.inference-accounting", version: "1",
        statement: "Paid inference with unknown spend stops subsequent paid admission. A cache hit performs no new inference and must not be charged as another call. Failed model results cannot become passing cached judgments.",
        applicability: "The supplied relation backend, assessment loop and immutable artifact store. A valid judgment and a known price are separate facts.",
        clauses: ["Count the isolation canary against the call and cost budget.", "Retain failure and unknown cost without fabricating zero spend.", "Changing pinned source invalidates exact-snapshot inference reuse."], exceptions: [],
        participants: [selector("src/lib/decision-metrics/relation-assess.ts", "assessRelations"), selector("src/lib/decision-metrics/relation-engines.ts", "relationBackend"), selector("src/lib/decision-metrics/relation-haiku.ts", "haikuAccounting")],
        groups: [[selector("src/lib/decision-metrics/relation-assess.ts", "assessRelations"), selector("src/lib/decision-metrics/relation-engines.ts", "relationBackend"), selector("src/lib/decision-metrics/relation-haiku.ts", "haikuAccounting")]], contextFiles: [],
    },
];
if (action === "prepare") {
    if (existsSync(join(repo, ".git"))) throw new Error("runtime capture already exists; do not overwrite its baseline");
    mkdirSync(repo, { recursive: true });
    const sources = new Set<string>([
        "src/harness/resource-command.ts", "src/harness/resource-cli.ts", "src/harness/resource-budget.ts", "src/harness/resource-wait.ts", "src/harness/resource-watch.ts", "src/harness/node-heap-limit.ts", "src/harness/test-execution.ts", "src/harness/verification-stages.ts", "src/harness/check-engine/spawn-async.ts", "scripts/run-resource-bounded.ts",
    ]);
    for (const dir of ["src/harness/semantic-graph", "src/lib/decision-metrics"]) for (const file of readdirSync(join(root, dir))) if (file.endsWith(".ts") && !file.includes(".test.")) sources.add(`${dir}/${file}`);
    const captured = [...sources].sort().map(file => {
        mkdirSync(dirname(join(repo, file)), { recursive: true });
        copyFileSync(join(root, file), join(repo, file));
        return { file, hash: textHash(readFileSync(join(root, file), "utf8")) };
    });
    mkdirSync(join(repo, "runtime"), { recursive: true });
    copyFileSync(join(root, "scratch/semantic-relations-runtime/heap-measurements.json"), join(repo, "runtime/heap-measurements.json"));
    mkdirSync(join(repo, "semantic-relations"), { recursive: true });
    writeFileSync(join(repo, "semantic-relations/invariants.json"), JSON.stringify(definitions));
    writeFileSync(join(repo, "semantic-relations/scenarios.json"), "[]\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q"); git("add", "src", "scripts", "runtime", "semantic-relations");
    git("-c", "core.hooksPath=/dev/null", "-c", "user.name=Interlinked evaluation", "-c", "user.email=evaluation@localhost", "commit", "-qm", "Capture current source for isolated runtime evaluation");
    const revision = git("rev-parse", "HEAD"), until = git("show", "-s", "--format=%cI", "HEAD");
    const engines = readFileSync(join(root, "semantic-relations/studies/2026-10-27-exploratory/engines.json"), "utf8");
    const available = (JSON.parse(engines) as EngineSpec[]).filter(e => e.id === "J" || e.id === "H").map(e => ({ ...e, maxCalls: 100, maxUsd: e.id === "J" ? 1 : 2, ...(e.id === "H" ? { identity: haikuIdentity(e.command!, e.model) } : {}) }));
    save("engines.json", available);
    save("protocol.json", { exploratory: true, objective: "Does the actual CLI add actionable information to ordinary code inspection and executable runtime checks?", sourceCapture: { root: repo, revision, baseRepositoryCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), captured, digest: hash(captured) }, beforeModelBaseline: { known: ["The earlier five failing test files pass all 76 tests under Node 22.", "Actual V8 heap differs by 144 MiB between installed Node 22 and 25 for the same old-space cap.", "Ordinary Astra review has proposed checking missing executable and external child signal handling; these are not model-discovered findings.", "Current relation workflow requires committed source, custom registry, engines, prepare, freeze, assess and manual JSON inspection."], successCriterion: "Credit a model only for a new verified finding, new necessary test, or materially narrower inspection scope absent from the prior baseline.", limits: "Single-agent sequential dogfood, not randomized timing or independent correctness qualification." }, threshold: .8, until, historySince: "2026-01-01T00:00:00Z", kinds: "invariant_membership,invariant_compatibility,invariant_group", D: "Unavailable adapter/model; no automatic download", noAutomaticGate: true });
}
if (action === "prepare" || action === "prepare-commands") {
    const { sourceCapture: { revision }, until } = read<{ sourceCapture: { revision: string }; until: string }>("protocol.json");
    const common = ["--cwd", repo, "--revision", revision, "--policy-revision", revision, "--history-tip", revision, "--since", "2026-01-01T00:00:00Z", "--until", until, "--engines", join(study, "engines.json"), "--max-files", "200", "--k", "12", "--kinds", "invariant_membership,invariant_compatibility,invariant_group"];
    for (const mode of ["curated", "shared_rules", "lexical"]) {
        command(`${mode}-prepare`, ["prepare", ...common, "--mode", mode === "curated" ? "curated" : "retrieved", "--method", mode === "lexical" ? "lexical" : "shared_rules", "--output", join(study, `${mode}-plan.json`)]);
        const plan = read<RelationPlan>(`${mode}-plan.json`);
        save(`${mode}-preparation-summary.json`, { planId: plan.id, snapshotUnits: plan.jobs[0]!.snapshot.units.length, packets: plan.jobs[0]!.packets.map(p => ({ id: p.id, kind: p.kind, invariant: p.invariantId, participants: p.participants, complete: p.complete, missing: p.missing, bytes: JSON.stringify(p.evidence).length })), coverage: plan.coverage });
    }
    command("curated-freeze", ["freeze", join(study, "curated-plan.json"), "--cwd", repo, "--output", join(study, "curated-input")]);
} else if (action === "assess" || action === "cache") {
    const output = join(study, `${action}-run.json`);
    command(action, ["assess", join(study, "curated-input"), "--cwd", repo, ...(action === "assess" ? ["--fresh"] : []), "--output", output], true);
    const run = parseRelationRun(loadRelationArtifact(output));
    save(`${action}-summary.json`, { id: run.id, measurements: run.measurements.map(m => ({ packetId: m.packetId, arm: m.armId, kind: m.recordKind, status: m.status, choice: m.choice, raw: m.raw, cached: m.cached, calls: m.calls, cost: m.costUsd, durationMs: m.durationMs, reason: m.reason })) });
    command(`${action}-export`, ["export", output, "--cwd", repo, "--output", join(study, `${action}-result`)]);
} else if (action === "repair") {
    const protocol = read<{ sourceCapture: { revision: string }; until: string; historySince: string; kinds: string }>("protocol.json");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    if (git("rev-parse", "HEAD") !== protocol.sourceCapture.revision) throw new Error("Repair snapshot already exists; do not overwrite it");
    copyFileSync(join(root, "src/harness/resource-cli.ts"), join(repo, "src/harness/resource-cli.ts"));
    git("add", "src/harness/resource-cli.ts");
    git("-c", "core.hooksPath=/dev/null", "-c", "user.name=Interlinked evaluation", "-c", "user.email=evaluation@localhost", "commit", "-qm", "Preserve external interruption diagnostics and deferred telemetry");
    const revision = git("rev-parse", "HEAD");
    save("repair-protocol.json", { revision, beforeRevision: protocol.sourceCapture.revision, historyTip: protocol.sourceCapture.revision, until: protocol.until, change: "Require a non-null child exit code before the supervisor returns without interruption telemetry", hypothesis: "The completed-verdict contradiction should disappear, with executable probes providing the behavioral evidence", limits: "One repair selected after inspecting the first judgments; exploratory, not held-out repair detection" });
    command("repair-prepare", ["prepare", "--cwd", repo, "--revision", revision, "--policy-revision", protocol.sourceCapture.revision, "--history-tip", protocol.sourceCapture.revision, "--since", protocol.historySince, "--until", protocol.until, "--engines", join(study, "engines.json"), "--max-files", "200", "--mode", "curated", "--k", "12", "--kinds", protocol.kinds, "--output", join(study, "repair-plan.json")]);
    command("repair-freeze", ["freeze", join(study, "repair-plan.json"), "--cwd", repo, "--output", join(study, "repair-input")]);
} else if (action === "repair-assess") {
    command(action, ["assess", join(study, "repair-input"), "--cwd", repo, "--fresh", "--output", join(study, "repair-run.json")], true);
    command("repair-export", ["export", join(study, "repair-run.json"), "--cwd", repo, "--output", join(study, "repair-result")]);
} else if (action === "compare") {
    command("paired-plan", ["compare", join(study, "assess-run.json"), "--after", join(study, "repair-run.json"), "--cwd", repo, "--output-plan", join(study, "paired-plan.json")]);
    command("paired-freeze", ["freeze", join(study, "paired-plan.json"), "--cwd", repo, "--output", join(study, "paired-input")]);
    command("paired-assess", ["assess", join(study, "paired-input"), "--cwd", repo, "--output", join(study, "paired-run.json")], true);
    command("paired-compare", ["compare", "--assessment-run", join(study, "paired-run.json"), "--cwd", repo, "--output", join(study, "comparison.json")]);
    command("paired-export", ["export", join(study, "paired-run.json"), "--cwd", repo, "--output", join(study, "paired-result")]);
} else if (action === "control-comment-only-resume") {
    assessControl("control-comment-only");
} else if (action === "control-comment-only" || action === "control-no-comment") {
    if (existsSync(join(study, `${action}-protocol.json`))) throw new Error("Control already captured; preserve its original results");
    const protocol = read<{ sourceCapture: { revision: string }; until: string; historySince: string }>("protocol.json");
    const repair = read<{ revision: string }>("repair-protocol.json");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    const file = "src/harness/resource-cli.ts";
    const before = execFileSync("git", ["-C", repo, "show", `${protocol.sourceCapture.revision}:${file}`], { encoding: "utf8" });
    const after = execFileSync("git", ["-C", repo, "show", `${repair.revision}:${file}`], { encoding: "utf8" });
    const comment = "    // An external signal can leave code null without setting a local cancellation flag.\n";
    const originalGuard = "    if (!result.killed && !result.timedOut && !signal.aborted) return;";
    if (!before.includes(originalGuard) || !after.includes(comment)) throw new Error("Control source no longer matches the frozen repair");
    const content = action === "control-comment-only" ? before.replace(originalGuard, comment + originalGuard) : after.replace(comment, "");
    writeFileSync(join(repo, file), content);
    git("add", file);
    git("-c", "core.hooksPath=/dev/null", "-c", "user.name=Interlinked evaluation", "-c", "user.email=evaluation@localhost", "commit", "-qm", action);
    const revision = git("rev-parse", "HEAD");
    save(`${action}-protocol.json`, { revision, control: action, sourceHash: textHash(content), source: content, expectation: action === "control-comment-only" ? "Broken code remains contradictory despite the explanatory comment" : "Fixed code remains compatible without the explanatory comment", selection: "First three compatibility/group packets, all for runtime.completed-verdict; includes the unchanged commandStatus pair as a stability control", limits: "Post-hoc construct check, one fresh observation per arm and packet; not a reliability estimate" });
    const planPath = join(study, `${action}-plan.json`);
    command(`${action}-prepare`, ["prepare", "--cwd", repo, "--revision", revision, "--policy-revision", protocol.sourceCapture.revision, "--history-tip", protocol.sourceCapture.revision, "--since", protocol.historySince, "--until", protocol.until, "--engines", join(study, "engines.json"), "--max-files", "200", "--mode", "curated", "--k", "12", "--kinds", "invariant_compatibility,invariant_group", "--max-packets", "3", "--output", planPath]);
    assessControl(action);
} else throw new Error("Unknown runtime study action");
