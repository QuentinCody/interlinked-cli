// Unit D review, round 1 (2026-09-25): five reproducible findings, each pinned
// here through the supervisor and the public fixtures (D5's process-group pin
// is services.test.ts N5).
//   D1 a comparison that never reaches its action (missing dependency: exit 1,
//      no primary output) is INCONCLUSIVE, never a demonstrated red; the
//      genuine persistence regression next to it still demonstrates.
//   D2 a comparison whose lifecycle did not complete (its service leaked a
//      responder that outlived teardown) certifies nothing, in every mode.
//   D3 the resolved comparison commit is part of the generation: a moved ref
//      makes the proof stale; an unresolvable ref is a scope gap.
//   D4 an owned service's executable is an artifact-covered input, not
//      immutable source: a prebuilt tree + a harmless edit passes; a path with
//      a real source role keeps its drift check.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { httpFixtureProject, injectHttpPersistenceDefect } from "./__tests__/fixture-http.js";
import { acceptAllContracts, fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { CONTRACT_MANIFEST } from "../contracts/paths.js";
import { evaluateE2e } from "./evaluate.js";
import { scenarioGeneration, scenarioInputs, type ScenarioGeneration } from "./generation.js";
import { E2E_POLICY_PATH, loadE2ePolicy, type E2ePolicy, type E2eProof } from "./policy.js";
import type { E2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";

const TIMEOUT = 180_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" }).trim();
}
function tracked(project: FixtureProject): FixtureProject {
    roots.push(project.root);
    git(project.root, "init", "--quiet");
    git(project.root, "add", ".");
    git(project.root, "commit", "--quiet", "--no-gpg-sign", "-m", "good");
    return project;
}
function source(project: FixtureProject): string { return readFileSync(join(project.root, project.sourceFile), "utf8"); }
function writeSource(project: FixtureProject, content: string): void { writeFileSync(join(project.root, project.sourceFile), content); }
function commitAll(project: FixtureProject, message: string): void { git(project.root, "commit", "--quiet", "--no-gpg-sign", "-am", message); }
function patchPolicy(project: FixtureProject, mutate: (policy: E2ePolicy) => void): void {
    const path = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(path, "utf8")) as E2ePolicy; // SAFETY: fixture-authored
    mutate(policy);
    writeFileSync(path, JSON.stringify(policy));
}
function setProof(project: FixtureProject, proof: E2eProof, contractIds?: string[]): void {
    patchPolicy(project, policy => { const scenario = policy.projects[0]!.scenarios[0]!; scenario.proof = proof; if (contractIds) scenario.contractIds = contractIds; });
}
function generation(project: FixtureProject): ScenarioGeneration {
    const loaded = loadE2ePolicy(project.root);
    if (loaded.status !== "configured") throw new Error(`policy not configured: ${loaded.status}`);
    return scenarioGeneration(project.root, loaded.policy, loaded.digest, loaded.policy.projects[0]!, loaded.policy.projects[0]!.scenarios[0]!);
}
function verdict(project: FixtureProject) { return evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!; }
async function run(project: FixtureProject) {
    const result = await runProjectE2e({ root: project.root, timeoutMs: 60_000 });
    const receipt = JSON.parse(readFileSync(join(project.root, result.receipts[0]!.path), "utf8")) as E2eReceipt; // SAFETY: the receipt this run wrote
    return { result, receipt, sensitivity: receipt.sensitivity?.["order-persists"] };
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
/** Kill the responder a leaking fixture recorded at `marker`, if it is still alive. */
function reap(marker: string): void {
    if (!existsSync(marker)) return;
    const pid = Number(readFileSync(marker, "utf8"));
    if (alive(pid)) process.kill(pid, "SIGKILL");
}
/** The HTTP fixture's server rewritten so the OWNED process only spawns a DETACHED responder (its own group) and idles: the responder outlives every teardown. */
function leakingServer(good: string, marker: string): string {
    const guarded = good.replace("createServer((request, response)", "if (process.env.E2E_REVIEW_RESPONDER) createServer((request, response)");
    if (guarded === good) throw new Error("createServer anchor not found in the HTTP fixture");
    return `import { spawn } from "node:child_process";\n${guarded}\nelse { const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "ignore", env: { ...process.env, E2E_REVIEW_RESPONDER: "1" } }); child.unref(); writeFileSync(${JSON.stringify(marker)}, String(child.pid)); setInterval(() => {}, 1000); }\n`;
}
function httpRepo(): FixtureProject { return tracked(httpFixtureProject()); }
function pyRepo(): FixtureProject { return tracked(fixtureProject("py", { accept: true })); }

describe("Unit D review — D1: a comparison must ESTABLISH the action before its failure counts", () => {
    it("D1: the old revision fails at import (exit 1, no primary output) ⇒ INCONCLUSIVE setup-build-dependency-failure and the obligation stays open; the genuine persistence regression beside it ⇒ demonstrated", async () => {
        const crash = pyRepo();
        const good = source(crash);
        writeSource(crash, "import nonexistent_dependency_for_review\n");
        commitAll(crash, "old: missing dependency");
        writeSource(crash, good);
        setProof(crash, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }] });
        const { result, sensitivity } = await run(crash);
        expect(result.exitCode).not.toBe(0);
        expect(sensitivity).toMatchObject({ mode: "old-new", verdict: "inconclusive", category: "setup-build-dependency-failure" });
        expect(sensitivity?.reasons.join("\n")).toMatch(/orders\.create did not establish its action on the comparison: exitCode, json differed \(exit 1\)/);
        expect(sensitivity?.compared.find(row => row.id === "orders.create")).toMatchObject({ state: "failed", primaryOutput: false, exitCode: 1, matched: [], mismatched: expect.arrayContaining(["exitCode"]) });
        const row = verdict(crash);
        expect(row.satisfied).toBe(false);
        expect(row.reasons.map(reason => reason.code)).toContain("SENSITIVITY_INCONCLUSIVE");
        expect(row.dimensions.sensitivity).toBe("inconclusive");
        // The regression alongside: the old program exits 0 and prints its answer — action established, designated outcome (the file) differs.
        const regression = pyRepo();
        const fixed = source(regression);
        injectPersistenceDefect(regression);
        commitAll(regression, "old: defect");
        writeSource(regression, fixed);
        setProof(regression, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }] });
        const demonstrated = await run(regression);
        expect(demonstrated.result.exitCode, demonstrated.result.messages.join("\n")).toBe(0);
        expect(demonstrated.sensitivity).toMatchObject({ verdict: "demonstrated", category: "designated-expectation-mismatch" });
        expect(demonstrated.sensitivity?.compared.find(row => row.id === "orders.create")).toMatchObject({ state: "failed", primaryOutput: true, exitCode: 0, matched: expect.arrayContaining(["exitCode"]), mismatched: ["files"] });
        expect(verdict(regression).satisfied).toBe(true);
    }, TIMEOUT);
});

describe("Unit D review — D2: a comparison whose lifecycle did not complete certifies nothing", () => {
    it("D2: the old service leaks a responder that outlives teardown ⇒ characterization is INCONCLUSIVE (comparison-lifecycle-failure) with the shutdown evidence retained, and so is an old-new whose designated case fails on that side", async () => {
        const markers = mkdtempSync(join(tmpdir(), "e2e-review-d2-")); roots.push(markers);
        const character = httpRepo(), characterMarker = join(markers, "character.pid");
        const good = source(character);
        writeSource(character, leakingServer(good, characterMarker));
        commitAll(character, "old: leaks its responder");
        writeSource(character, good);
        setProof(character, { mode: "characterization", revision: "HEAD" }, ["orders.create"]);
        try {
            const { result, sensitivity } = await run(character);
            expect(result.exitCode).not.toBe(0);
            expect(sensitivity).toMatchObject({ mode: "characterization", verdict: "inconclusive", category: "comparison-lifecycle-failure", lifecycle: { complete: false } });
            expect(sensitivity?.lifecycle?.reasons.join("\n")).toMatch(/service api shutdown failed: port \d+ still answers after the owned process group stopped/);
            expect(sensitivity?.lifecycle?.services?.[0]?.shutdown).toMatchObject({ ok: false, portSilent: false });
            expect(sensitivity?.compared.map(row => row.state)).toEqual(["passed"]); // exactly the evidence that must NOT count
            const row = verdict(character);
            expect(row.satisfied).toBe(false);
            expect(row.reasons.map(reason => reason.code)).toContain("SENSITIVITY_INCONCLUSIVE");
        } finally { reap(characterMarker); }
        const oldNew = httpRepo(), oldNewMarker = join(markers, "old-new.pid");
        const leaking = leakingServer(good, oldNewMarker).replace("send(response, 201, { ok: true, order });", "send(response, 201, { ok: false, order });");
        expect(leaking).toContain("ok: false");
        writeSource(oldNew, leaking);
        commitAll(oldNew, "old: leaks its responder and answers ok:false");
        writeSource(oldNew, good);
        setProof(oldNew, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["json"] }] }, ["orders.create"]);
        try {
            const { result, sensitivity } = await run(oldNew);
            expect(result.exitCode).not.toBe(0);
            expect(sensitivity).toMatchObject({ mode: "old-new", verdict: "inconclusive", category: "comparison-lifecycle-failure", lifecycle: { complete: false } });
            expect(sensitivity?.compared.find(row => row.id === "orders.create")).toMatchObject({ state: "failed", status: 201, mismatched: ["json"] }); // would have demonstrated, had the lifecycle completed
            expect(verdict(oldNew).dimensions.sensitivity).toBe("inconclusive");
        } finally { reap(oldNewMarker); }
    }, TIMEOUT);
});

describe("Unit D review — D3: the resolved comparison commit is part of the generation and of qualification", () => {
    it("D3: a green old-new proof against HEAD goes stale when HEAD moves — check is no longer green and a fresh run of the unchanged policy is NOT demonstrated; an unresolvable revision is a scope gap", async () => {
        const project = pyRepo();
        const good = source(project);
        injectPersistenceDefect(project);
        commitAll(project, "old: defect");
        writeSource(project, good);
        setProof(project, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }] });
        const before = generation(project);
        expect(before.comparison).toBe(git(project.root, "rev-parse", "HEAD"));
        const first = await run(project);
        expect(first.result.exitCode, first.result.messages.join("\n")).toBe(0);
        expect(first.sensitivity?.comparison.identity).toBe(before.comparison);
        expect(verdict(project).satisfied).toBe(true);
        commitAll(project, "fixed candidate"); // only HEAD moves: policy bytes and working-tree bytes are unchanged
        const after = generation(project);
        expect(after.comparison).toMatch(/^[a-f0-9]{40}$/);
        expect(after.comparison).not.toBe(before.comparison);
        expect(after.generation).not.toBe(before.generation);
        const moved = verdict(project);
        expect(moved.satisfied).toBe(false);
        expect(moved.status).toBe("stale");
        expect(moved.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining(["STALE_GENERATION", "SENSITIVITY_INCONCLUSIVE"]));
        expect(moved.reasons.map(reason => reason.message).join("\n")).toMatch(/the proof revision now resolves to [a-f0-9]{12}; the recorded comparison ran against [a-f0-9]{12}/);
        const fresh = await run(project);
        expect(fresh.result.exitCode).not.toBe(0);
        expect(fresh.sensitivity).toMatchObject({ verdict: "not-demonstrated", category: "comparison-passes" });
        setProof(project, { mode: "old-new", revision: "no-such-revision", designated: [{ id: "orders.create", outcome: ["files"] }] });
        const missing = generation(project);
        expect(missing.comparison).toBeUndefined();
        expect(missing.gaps).toContain('proof revision "no-such-revision" does not resolve to a commit in the project repository');
        expect(verdict(project).reasons.map(reason => reason.code)).toContain("SCOPE_INCOMPLETE");
    }, TIMEOUT);
});

describe("Unit D review — D4: an owned service's executable is an artifact-covered input, never immutable source by itself", () => {
    it("D4: dist/server.js prebuilt in the live tree + a harmless source edit ⇒ the executable is captured AND regenerated, the run rebuilds it and passes; with dist/** also declared as source the source role wins and the rebuild is drift", async () => {
        const project = httpFixtureProject(); roots.push(project.root);
        execFileSync("node", ["build.mjs"], { cwd: project.root });
        writeSource(project, `${source(project)}\n// harmless edit after a local build\n`);
        const inputs = generation(project).inputs;
        expect(inputs.files.map(file => file.path)).toEqual(expect.arrayContaining(["dist/server.js", "build.mjs", "src/server.ts"]));
        expect(inputs.regenerated).toEqual(["dist/server.js"]);
        const { result, receipt } = await run(project);
        expect(result.exitCode, receipt.completion.reasons.join("\n")).toBe(0);
        expect(receipt.completion.complete).toBe(true);
        expect(receipt.cases.map(row => row.state)).toEqual(["passed", "passed", "passed"]);
        // Genuine overlap: the same executable declared as SOURCE (affects) keeps its source role — preparation's rewrite is drift and no case runs.
        const overlap = httpFixtureProject(); roots.push(overlap.root);
        execFileSync("node", ["build.mjs"], { cwd: overlap.root });
        patchPolicy(overlap, policy => { policy.projects[0]!.scenarios[0]!.affects.push("dist/**"); });
        writeSource(overlap, `${source(overlap)}\n// harmless edit after a local build\n`);
        expect(generation(overlap).inputs.regenerated).toEqual([]);
        const rejected = await run(overlap);
        expect(rejected.result.exitCode).not.toBe(0);
        expect(rejected.receipt.completion.reasons.join("\n")).toMatch(/preparation modified declared input dist\/server\.js/);
        expect(rejected.receipt.cases).toEqual([]);
        // A build script named by a prepare step keeps its source role whatever artifact glob covers it (round-7 H2 still holds).
        const scripted = httpFixtureProject(); roots.push(scripted.root);
        patchPolicy(scripted, policy => { (policy.projects[0]!.suites[0]!.artifacts ??= []).push("build.mjs"); });
        const loaded = loadE2ePolicy(scripted.root);
        if (loaded.status !== "configured") throw new Error(loaded.status);
        const scriptedInputs = scenarioInputs(scripted.root, loaded.policy, loaded.policy.projects[0]!, loaded.policy.projects[0]!.scenarios[0]!);
        expect(scriptedInputs.files.map(file => file.path)).toContain("build.mjs");
        expect(scriptedInputs.regenerated).toEqual([]);
    }, TIMEOUT);
});

describe("Unit D review round 2 — R1: only DECLARED precondition/action evidence establishes the action; output presence never does", () => {
    it("R1 negative: a startup banner before a missing import (exit 1 with stdout) and a 500 dependency-error body before the action are both INCONCLUSIVE setup failures", async () => {
        const banner = pyRepo();
        const good = source(banner);
        writeSource(banner, 'print("Starting orders service...")\nimport nonexistent_dependency_for_review\n');
        commitAll(banner, "old: banner then missing dependency");
        writeSource(banner, good);
        setProof(banner, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["files"] }] });
        const py = await run(banner);
        expect(py.result.exitCode).not.toBe(0);
        expect(py.sensitivity).toMatchObject({ verdict: "inconclusive", category: "setup-build-dependency-failure" });
        expect(py.sensitivity?.compared.find(row => row.id === "orders.create")).toMatchObject({ state: "failed", primaryOutput: true, exitCode: 1, matched: [] }); // the banner IS output — and proves nothing
        expect(verdict(banner).reasons.map(reason => reason.code)).toContain("SENSITIVITY_INCONCLUSIVE");
        const http = httpRepo();
        const server = source(http);
        const failing = server.replace('if (request.method === "POST" && url === "/orders") { void create(request, response); return; }', 'if (request.method === "POST" && url === "/orders") { send(response, 500, { error: "database dependency unavailable; action not executed" }); return; }');
        expect(failing).not.toBe(server);
        writeSource(http, failing);
        commitAll(http, "old: dependency error before the action");
        writeSource(http, server);
        setProof(http, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.create", outcome: ["json"] }] }, ["orders.create"]);
        const svc = await run(http);
        expect(svc.result.exitCode).not.toBe(0);
        expect(svc.sensitivity).toMatchObject({ verdict: "inconclusive", category: "setup-build-dependency-failure", reasons: [expect.stringMatching(/status differed \(HTTP 500\)/)] });
        expect(svc.sensitivity?.compared.find(row => row.id === "orders.create")).toMatchObject({ state: "failed", status: 500, primaryOutput: true, matched: [], mismatched: ["status", "json"] });
    }, TIMEOUT);
    it("R1 positive: the HTTP workflow proof — the old service answers 201 without saving; `orders.create` PASSING on the old side establishes the action and the designated read-back fails ⇒ demonstrated", async () => {
        const project = httpRepo();
        const good = source(project);
        injectHttpPersistenceDefect(project);
        commitAll(project, "old: answers 201, saves nothing");
        writeSource(project, good);
        setProof(project, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.read-after-restart", action: ["orders.create"] }] });
        const { result, sensitivity } = await run(project);
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        expect(sensitivity).toMatchObject({ mode: "old-new", verdict: "demonstrated", category: "designated-expectation-mismatch", designated: [{ id: "orders.read-after-restart", action: ["orders.create"] }] });
        expect(sensitivity?.compared.find(row => row.id === "orders.create")).toMatchObject({ state: "passed", status: 201 });
        expect(sensitivity?.compared.find(row => row.id === "orders.read-after-restart")).toMatchObject({ state: "failed", status: 404, mismatched: ["status", "json"] });
        expect(verdict(project)).toMatchObject({ satisfied: true, dimensions: { sensitivity: "demonstrated" } });
    }, TIMEOUT);
});

describe("Unit D review round 3 — R1: an action must EXECUTE before the observation it establishes", () => {
    it("R1: the manifest runs read-back BEFORE create and the candidate fabricates the read ⇒ a scope gap before execution, and the proof is INCONCLUSIVE, never demonstrated", async () => {
        const project = httpRepo(); // HEAD = the ordinary implementation
        const good = source(project);
        const fabricated = good.replace('else send(response, 404, { error: "not found" });', 'else send(response, 200, { id: 1, name: "widget" });');
        expect(fabricated).not.toBe(good);
        writeSource(project, fabricated);
        const manifestPath = join(project.root, CONTRACT_MANIFEST);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: number; cases: Array<{ id: string }> }; // SAFETY: fixture-authored
        const read = manifest.cases.find(row => row.id === "orders.read-after-restart")!, create = manifest.cases.find(row => row.id === "orders.create")!;
        manifest.cases = [read, create];
        writeFileSync(manifestPath, JSON.stringify(manifest));
        acceptAllContracts(project.root);
        setProof(project, { mode: "old-new", revision: "HEAD", designated: [{ id: "orders.read-after-restart", action: ["orders.create"] }] }, ["orders.read-after-restart", "orders.create"]);
        expect(generation(project).gaps.join("\n")).toMatch(/proof designated orders\.read-after-restart names action orders\.create, but .* executes orders\.create after it/);
        const { result, sensitivity } = await run(project);
        expect(result.exitCode).not.toBe(0);
        expect(sensitivity?.verdict).toBe("inconclusive");
        expect(sensitivity?.reasons.join("\n")).toMatch(/executed after orders\.read-after-restart on the candidate|executed AFTER orders\.read-after-restart on the comparison/);
        const row = verdict(project);
        expect(row.satisfied).toBe(false);
        expect(row.reasons.map(reason => reason.code)).toContain("SCOPE_INCOMPLETE");
    }, TIMEOUT);
});
