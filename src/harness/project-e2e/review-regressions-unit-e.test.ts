// Unit E review round 1 (2026-09-25, findings E1–E5 in scratch/review-project-e2e-unit-e/REVIEW.md).
// Every case runs the REAL supervisor against a fixture; the browser cases use
// a reporter test double (a fake @playwright/test package plus a script that
// drives the owned app through the proxy and writes Playwright's JSON), so the
// composite boundary is pinned on every machine without a browser install.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_CASE_ID, browserFixturePolicy, browserFixtureProject } from "./__tests__/fixture-browser.js";
import { httpFixturePolicy, httpFixtureProject } from "./__tests__/fixture-http.js";
import { CONTRACT_MANIFEST } from "../contracts/paths.js";
import { acceptAllContracts, fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { qualifyStability } from "./cohort.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH, parseE2ePolicy } from "./policy.js";
import type { E2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";
import { RUNTIME_OBSERVATIONS_FILE, type RuntimeEdge } from "./runtime-observations.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 120_000;
type PolicyJson = { projects: Array<Record<string, unknown> & { suites: Array<Record<string, unknown> & { run?: { argv: string[] }; services?: Array<Record<string, unknown> & { argv: string[] }> }>; scenarios: Array<Record<string, unknown>> }> };
function editPolicy(project: FixtureProject, edit: (policy: PolicyJson) => void): void {
    const path = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(path, "utf8")) as PolicyJson; // SAFETY: fixture-authored
    edit(policy);
    writeFileSync(path, JSON.stringify(policy));
}
function receiptOf(project: FixtureProject, path: string): E2eReceipt { return JSON.parse(readFileSync(join(project.root, path), "utf8")) as E2eReceipt; } // SAFETY: the receipt this run wrote
function verdict(project: FixtureProject) { return evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!; }
const REPORT = `JSON.stringify({ suites: [{ title: "orders.spec.mjs", file: "orders.spec.mjs", suites: [{ title: "orders page", file: "orders.spec.mjs", specs: [{ title: "creates an order through the page", tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed", retry: 0, startTime: new Date(start).toISOString(), duration: Date.now() - start + 5 }] }] }] }] }] })`;
/** A reporter double: drives the owned app through the proxy exactly as listed, then writes Playwright's JSON for one passing case. */
function installReporterDouble(project: FixtureProject, drive: string): void {
    const packageRoot = join(project.root, "node_modules", "@playwright", "test");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@playwright/test", version: "1.55.1" }));
    writeFileSync(join(project.root, "reporter-double.mjs"), `import { writeFileSync } from "node:fs";\nconst base = process.env.INTERLINKED_E2E_BASE_URL, start = Date.now();\n${drive}\nwriteFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, ${REPORT});\n`);
    editPolicy(project, policy => { policy.projects[0]!.suites[0]!.run = { argv: ["node", "reporter-double.mjs"] }; });
}
const REAL_DRIVE = `await fetch(base + "/");\nawait fetch(base + "/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "widget" }) });`;

describe("Unit E review — E1: a browser scenario qualifies with its support contracts judged by their own mechanism", () => {
    it("E1: the browser case (page + POST /orders through the proxy) plus the http support contract both pass ⇒ satisfied, boundary browser-driver, exit 0", async () => {
        const project = browserFixtureProject();
        projects.push(project);
        installReporterDouble(project, REAL_DRIVE);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.cases.map(row => [row.id, row.state, row.runnerKind])).toEqual([[BROWSER_CASE_ID, "passed", "browser"], ["orders.invalid", "passed", "http"]]);
        expect(receipt.cases[0]!.boundaryObservations).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/orders", status: 201 })]));
        const row = verdict(project);
        expect(row.satisfied).toBe(true);
        expect(row.dimensions.boundary).toBe("browser-driver");
    }, TIMEOUT);
    it("E1b: a browser boundary with no browser case in the scenario is unestablished, never process- or http-driver", async () => {
        const project = browserFixtureProject();
        projects.push(project);
        installReporterDouble(project, REAL_DRIVE);
        editPolicy(project, policy => { policy.projects[0]!.scenarios[0]!.caseIds = ["orders.spec.mjs › orders page › nobody declared this [chromium]"]; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        const codes = verdict(project).reasons.map(reason => reason.code);
        expect(codes).toContain("CASE_NOT_RUN");
        expect(codes).toContain("BOUNDARY_UNSUPPORTED");
        expect(verdict(project).dimensions.boundary).toBe("unsupported");
    }, TIMEOUT);
});
describe("Unit E review — E5: only the declared operation earns the boundary", () => {
    it("E5: a page load alone (the API intercepted) passes the report but never the boundary — BOUNDARY_UNSUPPORTED names POST /orders and what was observed", async () => {
        const project = browserFixtureProject();
        projects.push(project);
        installReporterDouble(project, `await fetch(base + "/");`);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.cases[0]).toMatchObject({ id: BROWSER_CASE_ID, state: "passed", boundaryRequests: 1 });
        const row = verdict(project);
        expect(row.satisfied).toBe(false);
        expect(row.dimensions.boundary).toBe("unsupported");
        expect(row.reasons.find(reason => reason.code === "BOUNDARY_UNSUPPORTED")?.message).toMatch(/did not drive POST \/orders through the owned application \(observed: GET \/ → 200\)/);
    }, TIMEOUT);
    it("E5b: the policy refuses a browser boundary without required requests, a non-browser boundary with them, and a malformed request", () => {
        // SAFETY (all three casts): the fixture builders return the plain JSON shape PolicyJson describes
        const boundaryOf = (policy: PolicyJson) => policy.projects[0]!.scenarios[0]!.boundary as Record<string, unknown>;
        const without = browserFixturePolicy() as PolicyJson;
        delete boundaryOf(without).requests;
        expect(() => parseE2ePolicy(JSON.stringify(without))).toThrow(/requests must list 1–32 requests/);
        const malformed = browserFixturePolicy() as PolicyJson;
        boundaryOf(malformed).requests = [{ method: "post", path: "orders" }];
        expect(() => parseE2ePolicy(JSON.stringify(malformed))).toThrow(/upper-case HTTP method/);
        const http = httpFixturePolicy() as PolicyJson;
        boundaryOf(http).requests = [{ method: "POST", path: "/orders" }];
        expect(() => parseE2ePolicy(JSON.stringify(http))).toThrow(/requests belongs to a browser boundary/);
    });
});
describe("Unit E review — E2: qualify's exit is the shared predicate, never the cohort alone", () => {
    it("E2: two green attempts with UNACCEPTED contracts are not a pass — each attempt is judged by the full predicate, the command exits 1 with EXPECTATION_PROPOSED", async () => {
        const project = fixtureProject("py", { accept: false });
        projects.push(project);
        const result = await qualifyStability({ root: project.root, scenarioId: "order-persists", timeoutMs: TIMEOUT, runs: 2 });
        expect(result.exitCode).toBe(1);
        expect(result.evaluation.exitCode).toBe(1);
        expect(result.evaluation.verdicts[0]!.reasons.map(reason => reason.code)).toContain("EXPECTATION_PROPOSED");
        expect(result.cohort.verdict).not.toBe("qualified");
        expect(result.cohort.attempts[0]!.status).toBe("unavailable");
    }, TIMEOUT);
});
describe("Unit E review round 2 — R1/R2: every service lifetime and every contract process is reconciled by identity", () => {
    it("R1: a playwright suite's browser-stage service that never flushes is still required — the contract-stage instance's file does not replace it; both lifetimes stay in the receipt with their stage", async () => {
        const project = browserFixtureProject();
        projects.push(project);
        installReporterDouble(project, REAL_DRIVE);
        const source = join(project.root, project.sourceFile);
        // The FIRST lifetime (browser stage) exits on SIGTERM without flushing; later lifetimes flush normally.
        writeFileSync(source, readFileSync(source, "utf8").replace('process.on("SIGTERM", () => process.exit(0));', `mkdirSync(dataDir, { recursive: true });\nconst startsFile = join(dataDir, "starts.json");\nconst starts = existsSync(startsFile) ? JSON.parse(readFileSync(startsFile, "utf8")) : [];\nstarts.push(process.pid); writeFileSync(startsFile, JSON.stringify(starts));\nif (starts.length > 1) process.on("SIGTERM", () => process.exit(0));`));
        editPolicy(project, policy => { policy.projects[0]!.observations = { runtimeCoverage: "node-required" }; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).toBe(2);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.services?.map(row => [row.id, row.stage, row.shutdown?.ok])).toEqual([["web", "browser", true], ["web", "contracts", true]]);
        expect(receipt.observations?.complete).toBe(false);
        expect(receipt.observations?.limits.join("\n")).toMatch(new RegExp(`owned service web@browser \\(pid ${receipt.services![0]!.pids[0]}\\) produced no coverage output`));
        const row = verdict(project);
        expect(row.reasons.map(reason => reason.code)).toContain("OBSERVATIONS_INCOMPLETE");
        expect(row.reasons.map(reason => reason.code)).not.toContain("BOUNDARY_UNSUPPORTED"); // the browser case is judged against the browser-stage lifetime, which stopped cleanly
    }, TIMEOUT);
    it("R2: a case whose executable disables collection is a named gap even when a neighbour case's helper child produced a second file; the gap names the case and its pid", async () => {
        const project = fixtureProject("ts", { accept: true });
        projects.push(project);
        const source = join(project.root, project.sourceFile);
        writeFileSync(source, `import { execFileSync } from "node:child_process";\nexecFileSync(process.execPath, ["-e", ""], { stdio: "ignore" });\n${readFileSync(source, "utf8")}`);
        const manifestPath = join(project.root, CONTRACT_MANIFEST), manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { cases: Array<{ id: string; runner: { argv: string[] } }> }; // SAFETY: fixture-authored
        manifest.cases[1]!.runner.argv = ["env", "NODE_V8_COVERAGE=", ...manifest.cases[1]!.runner.argv];
        writeFileSync(manifestPath, JSON.stringify(manifest));
        acceptAllContracts(project.root);
        editPolicy(project, policy => { policy.projects[0]!.observations = { runtimeCoverage: "node-required" }; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).toBe(2);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.cases.map(row => row.state)).toEqual(["passed", "passed"]);
        expect(receipt.cases.every(row => typeof row.observations?.pid === "number")).toBe(true);
        expect(receipt.observations?.files).toBeGreaterThanOrEqual(2);
        expect(receipt.observations?.complete).toBe(false);
        expect(receipt.observations?.limits.join("\n")).toMatch(new RegExp(`contract case ${manifest.cases[1]!.id} \\(pid ${receipt.cases[1]!.observations!.pid}\\) produced no coverage output`));
        expect(verdict(project).reasons.map(reason => reason.code)).toContain("OBSERVATIONS_INCOMPLETE");
    }, TIMEOUT);
});
describe("Unit E review — E3/E4: coverage completeness is an inventory, and contract processes map back to the project", () => {
    it("E3: with two owned services of which one never flushes, node-required is INCOMPLETE naming that service's pid; the other's output does not hide it", async () => {
        const project = httpFixtureProject();
        projects.push(project);
        const source = join(project.root, "src", "server.ts");
        writeFileSync(source, readFileSync(source, "utf8").replace('process.on("SIGTERM", () => process.exit(0));', 'if (!process.argv.includes("--no-flush")) process.on("SIGTERM", () => process.exit(0));'));
        editPolicy(project, policy => {
            const row = policy.projects[0]!;
            row.observations = { runtimeCoverage: "node-required" };
            const suite = row.suites[0]!;
            suite.services!.push({ ...suite.services![0]!, id: "unflushed", argv: [...suite.services![0]!.argv, "--no-flush"] });
        });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).toBe(2);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.services?.map(row => [row.id, row.ready.ok, row.shutdown?.ok])).toEqual([["api", true, true], ["unflushed", true, true]]);
        expect(receipt.observations?.complete).toBe(false);
        const unflushedPid = receipt.services!.find(row => row.id === "unflushed")!.pids[0];
        expect(receipt.observations?.limits.join("\n")).toMatch(new RegExp(`owned service unflushed@contracts \\(pid ${unflushedPid}\\) produced no coverage output`));
        const row = verdict(project);
        expect(row.dimensions.observations).toBe("incomplete");
        expect(row.reasons.map(reason => reason.code)).toContain("OBSERVATIONS_INCOMPLETE");
    }, TIMEOUT);
    it("E4: a supervised TypeScript CLI run under node-required maps the contract processes' copied executable back to dist/cli.js and stays complete", async () => {
        const project = fixtureProject("ts", { accept: true });
        projects.push(project);
        editPolicy(project, policy => { policy.projects[0]!.observations = { runtimeCoverage: "node-required" }; });
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.observations).toMatchObject({ complete: true, limits: [] });
        expect(receipt.observations!.files).toBeGreaterThanOrEqual(2);
        const edges = readFileSync(join(project.root, ".interlinked/test-runs/e2e", receipt.runId, RUNTIME_OBSERVATIONS_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line) as RuntimeEdge); // SAFETY: rows this run wrote
        expect(edges.map(row => row.source.path)).toContain("dist/cli.js");
        expect(edges.find(row => row.source.path === "dist/cli.js")!.source.covered).toBeGreaterThan(0);
    }, TIMEOUT);
});
