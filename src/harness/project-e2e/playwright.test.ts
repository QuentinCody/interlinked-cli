// Unit E2 acceptance: a playwright suite against an OWNED application. The
// unavailable route (no @playwright/test in the project, PE-24) is proven on
// every machine: the run names the gap, every declared browser case is
// unavailable, the obligation is unavailable (exit 2), never a pass. The
// live route (build → own the app → proxy → Playwright serially → correlate)
// is asserted only where this checkout carries @playwright/test and a
// browser cache; elsewhere it is skipped and stays UNVERIFIED here.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_CASE_ID, browserFixturePolicy, browserFixtureProject, repoHasPlaywright } from "./__tests__/fixture-browser.js";
import { injectHttpPersistenceDefect } from "./__tests__/fixture-http.js";
import type { FixtureProject } from "./__tests__/fixture-projects.js";
import { doctorE2e } from "./doctor.js";
import { evaluateE2e } from "./evaluate.js";
import { parseE2ePolicy } from "./policy.js";
import type { E2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 180_000;
function receiptOf(project: FixtureProject, path: string): E2eReceipt { return JSON.parse(readFileSync(join(project.root, path), "utf8")) as E2eReceipt; } // SAFETY: the receipt this run wrote
function verdict(project: FixtureProject) { return evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!; }

describe("playwright suite — policy and unavailable route (every machine)", () => {
    it("P1: the parser admits a playwright suite that owns its app, a browser boundary bound to that service, and native caseIds beside contractIds", () => {
        const policy = parseE2ePolicy(JSON.stringify(browserFixturePolicy()));
        const suite = policy.projects[0]!.suites[0]!, scenario = policy.projects[0]!.scenarios[0]!;
        expect(suite.adapter).toBe("playwright");
        expect(suite.report).toEqual({ format: "playwright", path: "playwright-report.json" });
        expect(suite.services?.[0]?.id).toBe("web");
        expect(scenario.caseIds).toEqual([BROWSER_CASE_ID]);
        expect(scenario.boundary).toEqual({ entry: "browser", service: "web", real: ["application"], requests: [{ method: "POST", path: "/orders" }] });
    });
    it("N1 (PE-24): without @playwright/test the run starts no service, names the install gap, marks the browser case unavailable and the scenario is unavailable, never satisfied", async () => {
        const project = browserFixtureProject();
        projects.push(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode, result.messages.join("\n")).not.toBe(0);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.prepare.every(step => step.ok)).toBe(true);
        expect(receipt.services ?? []).toEqual([]);
        expect(receipt.completion.complete).toBe(false);
        expect(receipt.completion.reasons.join("\n")).toMatch(/@playwright\/test is not installed in the project/);
        expect(receipt.cases.find(row => row.id === BROWSER_CASE_ID)).toMatchObject({ state: "unavailable", runnerKind: "browser", service: "web", boundaryRequests: 0 });
        const row = verdict(project);
        expect(row.status).toBe("unavailable");
        expect(row.satisfied).toBe(false);
        expect(row.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining(["CASE_UNAVAILABLE", "RUN_INCOMPLETE"]));
        expect(row.reasons.find(reason => reason.code === "BOUNDARY_UNSUPPORTED")?.message).toMatch(/names service "web" that the run never owned/);
    }, TIMEOUT);
    it("N1b: the doctor names the same gap without running anything", () => {
        const project = browserFixtureProject();
        projects.push(project);
        const doctor = doctorE2e(project.root);
        expect(doctor.status).toBe("fail");
        expect(doctor.checks.find(check => check.id === "orders:ui:playwright")).toMatchObject({ status: "fail", detail: expect.stringMatching(/npx playwright install/) });
    });
    it("N2: a browser boundary must name an owned service; a playwright suite without services is refused", () => {
        const policy = browserFixturePolicy() as { projects: Array<{ suites: Array<Record<string, unknown>>; scenarios: Array<Record<string, unknown>> }> };
        delete policy.projects[0]!.suites[0]!.services;
        expect(() => parseE2ePolicy(JSON.stringify(policy))).toThrow(/must OWN the application/);
        const unbound = browserFixturePolicy() as { projects: Array<{ scenarios: Array<Record<string, unknown>> }> };
        unbound.projects[0]!.scenarios[0]!.boundary = { entry: "browser", real: ["application"] };
        expect(() => parseE2ePolicy(JSON.stringify(unbound))).toThrow(/service/);
    });
});
describe("playwright suite — live route (only where @playwright/test is installed in this checkout)", () => {
    it.skipIf(!repoHasPlaywright())("P2: build, own the app, proxy, run Playwright serially, credit the case its requests; boundary browser-driver, obligation satisfied", async () => {
        const project = browserFixtureProject({ withPlaywright: true });
        projects.push(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const diagnostics = [...result.messages, ...result.verdicts.flatMap(row => row.reasons.map(reason => `${reason.code}: ${reason.message}`))];
        expect(result.exitCode, diagnostics.join("\n")).toBe(0);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.execution?.argv.slice(-3)).toEqual(["--reporter=json", "--workers=1", "--retries=0"]);
        expect(receipt.report?.format).toBe("playwright");
        const browserCase = receipt.cases.find(row => row.id === BROWSER_CASE_ID);
        expect(browserCase).toMatchObject({ state: "passed", runnerKind: "browser", service: "web" });
        expect(browserCase!.boundaryRequests).toBeGreaterThanOrEqual(2); // GET / and POST /orders at least
        expect(receipt.completion.complete).toBe(true);
        const row = verdict(project);
        expect(row.satisfied).toBe(true);
        expect(row.dimensions.boundary).toBe("browser-driver");
    }, TIMEOUT);
    it.skipIf(!repoHasPlaywright())("N4 (PE-20, found by the release matrix): the UI reports success but persistence is broken — the page's read-back fails the browser case, exit 1, never a pass", async () => {
        const project = browserFixtureProject({ withPlaywright: true });
        projects.push(project);
        injectHttpPersistenceDefect(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).toBe(1);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.cases.find(row => row.id === BROWSER_CASE_ID)?.state).toBe("failed");
        expect(verdict(project).reasons.map(reason => reason.code)).toContain("CASE_FAILED");
    }, TIMEOUT);
    it.skipIf(!repoHasPlaywright())("N3 (mocked-API control, review E5): the real page loads but Playwright intercepts POST /orders — the UI passes, the proxy never sees the operation, the boundary is unsupported and the scenario is not satisfied", async () => {
        const project = browserFixtureProject({ withPlaywright: true });
        projects.push(project);
        const spec = join(project.root, "tests", "orders.spec.mjs");
        // Both the operation AND the read-back are mocked: the UI passes entirely under Playwright's own doubles.
        const mocks = 'await page.route("**/orders", route => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, order: { id: 1, name: "widget" } }) }));\n        await page.route("**/orders/*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 1, name: "widget" }) }));\n        await page.goto("/");';
        writeFileSync(spec, readFileSync(spec, "utf8").replace('await page.goto("/");', mocks));
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        const browserCase = receipt.cases.find(row => row.id === BROWSER_CASE_ID);
        expect(browserCase?.state).toBe("passed");
        expect(browserCase?.boundaryObservations?.some(seen => seen.method === "POST" && seen.path === "/orders")).toBe(false);
        const row = verdict(project);
        expect(row.satisfied).toBe(false);
        expect(row.dimensions.boundary).toBe("unsupported");
        expect(row.reasons.find(reason => reason.code === "BOUNDARY_UNSUPPORTED")?.message).toMatch(/did not drive POST \/orders/);
    }, TIMEOUT);
});
