// Unit E4: runtime dependency observations (plan §7.4, PE-85/86). One proven
// collector — NODE_V8_COVERAGE on the OWNED Node processes — producing a
// versioned edge format with honest attribution: services are shared across
// cases, so every edge is RUN-level; missing child output is incomplete
// coverage, never a measured zero; an unsupported runtime is an optional gap
// unless the project explicitly requires the node profile.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { httpFixtureProject } from "./__tests__/fixture-http.js";
import type { FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH } from "./policy.js";
import type { E2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";
import { collectNodeCoverage, RUNTIME_OBSERVATIONS_FILE, writeRuntimeObservations, type RuntimeEdge } from "./runtime-observations.js";

const dirs: string[] = [];
const projects: FixtureProject[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
function scratch(prefix: string): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir; }
const identity = { runId: "run-1", scenarioIds: ["order-persists"] };
/** A real owned Node child: two functions, one executed, exiting normally so V8 flushes. */
function runOwnedChild(snapshot: string, coverageDirectory: string): void {
    mkdirSync(join(snapshot, "dist"), { recursive: true });
    writeFileSync(join(snapshot, "dist", "app.mjs"), "export function a(){return 1}\nexport function b(){return 2}\nconsole.log(a())\n");
    execFileSync(process.execPath, [join(snapshot, "dist", "app.mjs")], { env: { PATH: process.env.PATH, NODE_V8_COVERAGE: coverageDirectory }, stdio: "ignore" });
}
const TIMEOUT = 90_000;

describe("runtime observations — positive", () => {
    it("P1: an owned Node child's V8 coverage becomes one run-level edge per snapshot source with function counts, normalized to the snapshot-relative path", () => {
        const snapshot = scratch("obs-snap-"), coverageDirectory = join(scratch("obs-cov-"), "coverage");
        runOwnedChild(snapshot, coverageDirectory);
        const result = collectNodeCoverage({ coverageDirectory, snapshotRoot: snapshot, ...identity });
        expect(result.summary).toMatchObject({ version: 1, runtime: "node", method: "NODE_V8_COVERAGE", attribution: "run", complete: true, files: 1, edges: 1, limits: [] });
        expect(result.edges).toEqual([{ version: 1, runId: "run-1", scenarioIds: ["order-persists"], caseId: null, attribution: "run", runtime: { kind: "node", method: "NODE_V8_COVERAGE" }, source: { path: "dist/app.mjs", functions: 3, covered: 2 } }]);
    });
    it("P2: edges are written as one JSON line each under the run directory and the summary names the file", () => {
        const runDirectory = scratch("obs-run-");
        const edge: RuntimeEdge = { version: 1, runId: "run-1", scenarioIds: ["s"], caseId: null, attribution: "run", runtime: { kind: "node", method: "NODE_V8_COVERAGE" }, source: { path: "dist/app.mjs", functions: 3, covered: 2 } };
        const path = writeRuntimeObservations(runDirectory, [edge, { ...edge, source: { path: "dist/b.mjs", functions: 1, covered: 1 } }]);
        expect(path).toBe(RUNTIME_OBSERVATIONS_FILE);
        expect(readFileSync(join(runDirectory, RUNTIME_OBSERVATIONS_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line).source.path)).toEqual(["dist/app.mjs", "dist/b.mjs"]);
    });
    it("P3: a project that requires the node profile gets complete observations from its owned service (the fixture flushes on SIGTERM), the receipt names the built server, and the verdict's observations dimension is complete", async () => {
        const project = httpFixtureProject();
        projects.push(project);
        const policyPath = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(policyPath, "utf8")) as { projects: Array<Record<string, unknown>> }; // SAFETY: fixture-authored
        policy.projects[0]!.observations = { runtimeCoverage: "node-required" };
        writeFileSync(policyPath, JSON.stringify(policy));
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        const receipt = JSON.parse(readFileSync(join(project.root, result.receipts[0]!.path), "utf8")) as E2eReceipt; // SAFETY: the receipt this run wrote
        expect(receipt.observations).toMatchObject({ runtime: "node", complete: true, attribution: "run", path: RUNTIME_OBSERVATIONS_FILE });
        expect(receipt.observations!.edges).toBeGreaterThan(0);
        const edges = readFileSync(join(project.root, ".interlinked/test-runs/e2e", receipt.runId, RUNTIME_OBSERVATIONS_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line) as RuntimeEdge);
        expect(edges.map(row => row.source.path)).toContain("dist/server.js");
        expect(edges.every(row => row.caseId === null && row.attribution === "run")).toBe(true);
        const verdict = evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!;
        expect(verdict.satisfied).toBe(true);
        expect(verdict.dimensions.observations).toBe("complete");
    }, TIMEOUT);
});
describe("runtime observations — negative", () => {
    it("N1: no child output is INCOMPLETE with a named limit, never a measured zero; a malformed coverage file is a limit too", () => {
        const snapshot = scratch("obs-snap-"), empty = join(scratch("obs-cov-"), "coverage");
        const none = collectNodeCoverage({ coverageDirectory: empty, snapshotRoot: snapshot, ...identity });
        expect(none.summary).toMatchObject({ complete: false, files: 0, edges: 0 });
        expect(none.summary.limits.join(" ")).toMatch(/no coverage output/);
        mkdirSync(empty, { recursive: true });
        writeFileSync(join(empty, "coverage-1.json"), "{not json");
        const broken = collectNodeCoverage({ coverageDirectory: empty, snapshotRoot: snapshot, ...identity });
        expect(broken.summary.complete).toBe(false);
        expect(broken.summary.limits.join(" ")).toMatch(/coverage-1\.json/);
    });
    it("N2: scripts outside the snapshot, node: internals and node_modules are never edges; a script that never ran has covered 0, not absent", () => {
        const snapshot = scratch("obs-snap-"), coverageDirectory = join(scratch("obs-cov-"), "coverage");
        mkdirSync(coverageDirectory, { recursive: true });
        const script = (url: string, count: number) => ({ scriptId: "1", url, functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 10, count }], isBlockCoverage: true }] });
        writeFileSync(join(coverageDirectory, "coverage-2.json"), JSON.stringify({ result: [script(`file://${snapshot}/dist/never.js`, 0), script("file:///elsewhere/app.js", 1), script("node:fs", 1), script(`file://${snapshot}/node_modules/dep/index.js`, 1)], timestamp: 1 }));
        const result = collectNodeCoverage({ coverageDirectory, snapshotRoot: snapshot, ...identity });
        expect(result.edges.map(row => [row.source.path, row.source.covered])).toEqual([["dist/never.js", 0]]);
        expect(result.summary.complete).toBe(true);
    });
    it("N3: a project that does not declare the profile collects nothing (no coverage directory, no receipt field) and the dimension is not-required", async () => {
        const project = httpFixtureProject();
        projects.push(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        const receipt = JSON.parse(readFileSync(join(project.root, result.receipts[0]!.path), "utf8")) as E2eReceipt; // SAFETY: the receipt this run wrote
        expect(receipt.observations).toBeUndefined();
        expect(existsSync(join(project.root, ".interlinked/test-runs/e2e", receipt.runId, "coverage"))).toBe(false);
        expect(evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!.dimensions.observations).toBe("not-required");
    }, TIMEOUT);
});
