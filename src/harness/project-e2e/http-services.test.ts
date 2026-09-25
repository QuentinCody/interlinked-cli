// Unit D1 acceptance: a TypeScript HTTP project qualifies through an OWNED
// managed service (build → allocate port → start in the snapshot → ready →
// create → restart → read-back → stop → port silent), and every false-pass
// variant the plan names is rejected (§16 Unit D, §18 "TypeScript HTTP",
// PE-19/20/21/23/24/26).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_MANIFEST } from "../contracts/paths.js";
import { runContracts } from "../contracts/runner.js";
import { httpFixtureProject, httpFixturePolicy, injectHttpPersistenceDefect } from "./__tests__/fixture-http.js";
import type { FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH, parseE2ePolicy } from "./policy.js";
import type { E2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
const scratch: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const TIMEOUT = 90_000;
function fresh(): FixtureProject { const project = httpFixtureProject(); projects.push(project); return project; }
function receiptOf(project: FixtureProject, path: string): E2eReceipt { return JSON.parse(readFileSync(join(project.root, path), "utf8")) as E2eReceipt; } // SAFETY: the receipt this run wrote
function verdict(project: FixtureProject) { return evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!; }
function codes(project: FixtureProject): string[] { return verdict(project).reasons.map(row => row.code); }
type PolicyJson = Record<string, unknown> & { projects: Array<Record<string, unknown> & { suites: Array<Record<string, unknown>>; scenarios: Array<Record<string, unknown>> }> };
function editPolicy(project: FixtureProject, edit: (policy: PolicyJson) => void): void {
    const path = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(path, "utf8")) as PolicyJson; // SAFETY: fixture-authored
    edit(policy);
    writeFileSync(path, JSON.stringify(policy));
}

describe("managed HTTP project — positive (must qualify through the owned service)", () => {
    it("P1: build, own the service, create → restart → read-back, stop; every case passes, the boundary is http-driver, the obligation is satisfied", async () => {
        const project = fresh();
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.services).toHaveLength(1);
        expect(receipt.services![0]).toMatchObject({ id: "api", restarts: 1, ready: { ok: true, status: 200 }, shutdown: { ok: true, portSilent: true } });
        expect(receipt.services![0]!.argv).toEqual(["node", "dist/server.js", "--port", String(receipt.services![0]!.port)]);
        expect(receipt.cases.map(row => [row.id, row.state, row.runnerKind, row.service])).toEqual([["orders.create", "passed", "http", "api"], ["orders.read-after-restart", "passed", "http", "api"], ["orders.invalid", "passed", "http", "api"]]);
        expect(receipt.completion.complete).toBe(true);
        const row = verdict(project);
        expect(row.satisfied).toBe(true);
        expect(row.dimensions.boundary).toBe("http-driver");
    }, TIMEOUT);
    it("P2: the policy parser admits {port} in a service's argv/env, an http boundary bound to an owned service, and fixture-store bound through {fixture-directory}", () => {
        const policy = parseE2ePolicy(JSON.stringify(httpFixturePolicy()));
        expect(policy.projects[0]!.suites[0]!.services![0]).toMatchObject({ id: "api", ready: { kind: "http", path: "/health", status: 200 }, env: { DATA_DIR: "{fixture-directory}" } });
        expect(policy.projects[0]!.scenarios[0]!.boundary).toEqual({ entry: "http", service: "api", real: ["application", "fixture-store"] });
    });
});
describe("managed HTTP project — negative (false passes rejected)", () => {
    it("N1 (PE-20/PE-23): a 201 response whose state is lost fails the read-after-restart case; the scenario is failed, never satisfied", async () => {
        const project = fresh();
        injectHttpPersistenceDefect(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).toBe(1);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.cases.find(row => row.id === "orders.create")?.state).toBe("passed");
        expect(receipt.cases.find(row => row.id === "orders.read-after-restart")?.state).toBe("failed");
        expect(verdict(project).status).toBe("failed");
        expect(codes(project)).toContain("CASE_FAILED");
    }, TIMEOUT);
    it("N2 (PE-24): a service whose executable is absent is never ready; no case runs and the run is incomplete", async () => {
        const project = fresh();
        editPolicy(project, policy => { policy.projects[0]!.suites[0]!.services = [{ id: "api", argv: ["definitely-not-a-real-executable-xyz", "--port", "{port}"], env: { DATA_DIR: "{fixture-directory}" }, ready: { kind: "http", path: "/health", status: 200 } }]; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.services![0]!.ready.ok).toBe(false);
        expect(receipt.completion.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/service api not ready: .*could not be started|service api not ready: .*exited/)]));
        expect(receipt.cases).toEqual([]);
        expect(codes(project)).toContain("RUN_INCOMPLETE");
    }, TIMEOUT);
    it("N3 (PE-19/PE-26): a responder that outlives the owned process group leaves the port answering after shutdown; the run is incomplete and the boundary unsupported", async () => {
        const project = fresh();
        const pidDir = mkdtempSync(join(tmpdir(), "e2e-orphan-")); scratch.push(pidDir);
        const pidFile = join(pidDir, "orphan.pid");
        writeFileSync(join(project.root, "wrapper.mjs"), `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst port = process.argv[process.argv.indexOf("--port") + 1];\nconst orphan = spawn(process.execPath, ["dist/server.js", "--port", port], { detached: true, stdio: "ignore", env: process.env });\norphan.unref();\nwriteFileSync(process.env.ORPHAN_PID_FILE, String(orphan.pid));\nsetInterval(() => {}, 1000);\n`);
        editPolicy(project, policy => { policy.projects[0]!.suites[0]!.services = [{ id: "api", argv: ["node", "wrapper.mjs", "--port", "{port}"], env: { DATA_DIR: "{fixture-directory}", ORPHAN_PID_FILE: pidFile }, ready: { kind: "http", path: "/health", status: 200 } }]; });
        try {
            const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
            expect(result.exitCode).not.toBe(0);
            const receipt = receiptOf(project, result.receipts[0]!.path);
            expect(receipt.services![0]!.shutdown).toMatchObject({ ok: false, portSilent: false });
            expect(receipt.completion.complete).toBe(false);
            expect(codes(project)).toEqual(expect.arrayContaining(["BOUNDARY_UNSUPPORTED", "RUN_INCOMPLETE"]));
            expect(verdict(project).dimensions.boundary).toBe("unsupported");
        } finally { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); }
    }, TIMEOUT);
    it("N4 (PE-21): a scenario that declares a process boundary cannot be satisfied by http cases, however green they are", async () => {
        const project = fresh();
        editPolicy(project, policy => { policy.projects[0]!.scenarios[0]!.boundary = { entry: "process", real: ["application"] }; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        expect(receiptOf(project, result.receipts[0]!.path).cases.every(row => row.state === "passed")).toBe(true);
        expect(codes(project)).toContain("BOUNDARY_MISMATCH");
        expect(verdict(project).dimensions.boundary).toBe("mismatch");
    }, TIMEOUT);
    it("N5: a literal-URL http case names no owned service, so its boundary is unsupported even inside a service-owning run", async () => {
        const project = fresh();
        const manifestPath = join(project.root, CONTRACT_MANIFEST), manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { cases: Array<Record<string, unknown>> }; // SAFETY: fixture-authored
        manifest.cases[2]!.runner = { kind: "http", url: "http://127.0.0.1:1/orders", method: "GET" };
        writeFileSync(manifestPath, JSON.stringify(manifest));
        editPolicy(project, policy => { delete policy.projects[0]!.scenarios[0]!.boundary; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        expect(verdict(project).reasons.map(row => row.message)).toEqual(expect.arrayContaining([expect.stringMatching(/orders\.invalid targets a literal URL nobody owns/)]));
    }, TIMEOUT);
    it("N6: without the supervisor, the standalone contract runner marks service-bound cases unavailable — never a verdict", async () => {
        const project = fresh();
        const report = await runContracts(project.root, { timeoutMs: 20_000 });
        expect(report.cases.map(row => row.state)).toEqual(["unavailable", "unavailable", "unavailable"]);
        expect(report.cases[0]!.details.join(" ")).toMatch(/needs the managed e2e supervisor/);
    }, TIMEOUT);
    it("N7: the policy parser refuses {port} outside a service, an http boundary without an owned service, fixture-store without a {fixture-directory} binding, and services on a structured-runner suite", () => {
        const attempt = (edit: (policy: PolicyJson) => void) => () => { const policy = httpFixturePolicy() as PolicyJson; edit(policy); return parseE2ePolicy(JSON.stringify(policy)); };
        expect(attempt(policy => { policy.projects[0]!.suites[0]!.prepare = [{ argv: ["node", "build.mjs", "{port}"] }]; })).toThrow(/unknown placeholder \{port\}/);
        expect(attempt(policy => { policy.projects[0]!.scenarios[0]!.boundary = { entry: "http", service: "db", real: ["application"] }; })).toThrow(/"db" is not an owned service/);
        expect(attempt(policy => { (policy.projects[0]!.suites[0]!.services as Array<Record<string, unknown>>)[0]!.env = {}; })).toThrow(/fixture-store/);
        expect(attempt(policy => { policy.projects[0]!.suites[0]!.adapter = "structured-runner"; policy.projects[0]!.suites[0]!.run = { argv: ["node", "x.mjs"] }; policy.projects[0]!.suites[0]!.report = { format: "json", path: "r.json" }; })).toThrow(/structured-runner suite cannot bind/);
    });
});
