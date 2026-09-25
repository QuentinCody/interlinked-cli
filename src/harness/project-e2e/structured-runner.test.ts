// Unit C2: the generic structured-runner suite. A JSON/JUnit report normalizes
// EXECUTION evidence for declared native case ids; boundary evidence still comes
// from the portable contracts the same scenario binds (plan §10.1, PE-52/55).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH, parseE2ePolicy, type E2ePolicy, type E2eSuite } from "./policy.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 90_000;
const JSON_REPORT = { version: 1, cases: [{ id: "unit/a", status: "passed" }, { id: "unit/b", status: "passed" }] };

/** The TS fixture plus a structured suite whose run script writes whatever `report` the test asks for. */
function structuredFixture(report: unknown, options: { format?: "json" | "junit"; writeReport?: boolean } = {}): { project: FixtureProject; policy: E2ePolicy } {
    const project = fixtureProject("ts", { accept: true }); projects.push(project);
    const format = options.format ?? "json";
    const body = options.writeReport === false ? "" : `writeFileSync(${JSON.stringify(`report.${format === "json" ? "json" : "xml"}`)}, ${JSON.stringify(typeof report === "string" ? report : JSON.stringify(report))});`;
    writeFileSync(join(project.root, "run-tests.mjs"), `import { writeFileSync } from "node:fs";\n${body}\nprocess.exit(0);\n`);
    const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy; // SAFETY: fixture-authored, re-parsed on load
    const cli = policy.projects[0]!.suites[0]!;
    const native: E2eSuite = { id: "native", adapter: "structured-runner", prepare: cli.prepare!, artifacts: cli.artifacts!, run: { argv: ["node", "run-tests.mjs"] }, report: { format, path: format === "json" ? "report.json" : "report.xml" } };
    policy.projects[0]!.suites.push(native);
    policy.projects[0]!.protectedInputs = [...policy.projects[0]!.protectedInputs, "run-tests.mjs"];
    policy.projects[0]!.scenarios = [{ id: "native-suite", suite: "native", affects: [...policy.projects[0]!.protectedInputs], contractIds: ["orders.create"], caseIds: ["unit/a", "unit/b"], required: true }];
    writeFileSync(join(project.root, E2E_POLICY_PATH), JSON.stringify(policy));
    return { project, policy };
}
function verdict(root: string) { return evaluateE2e({ root, atMs: 5 }).verdicts[0]!; }

describe("structured-runner suite — positive (must qualify without a plugin)", () => {
    it("P1: a JSON protocol report with every declared case passed, plus the bound contract, satisfies the scenario; the receipt carries structured cases and the report digest", async () => {
        const { project } = structuredFixture(JSON_REPORT);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        const receipt = JSON.parse(readFileSync(join(project.root, result.receipts[0]!.path), "utf8"));
        expect(receipt.cases.filter((row: { runnerKind: string }) => row.runnerKind === "structured").map((row: { id: string; state: string }) => [row.id, row.state])).toEqual([["unit/a", "passed"], ["unit/b", "passed"]]);
        expect(receipt.report).toMatchObject({ format: "json", path: "report.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(receipt.selection.required).toEqual(expect.arrayContaining(["orders.create", "unit/a", "unit/b"]));
        expect(verdict(project.root).satisfied).toBe(true);
    }, TIMEOUT);
    it("P2: a JUnit XML report qualifies through the same route", async () => {
        const xml = `<testsuite name="s" tests="2"><testcase classname="unit" name="a"/><testcase classname="unit" name="b"/></testsuite>`;
        const { project, policy } = structuredFixture(xml, { format: "junit" });
        policy.projects[0]!.scenarios[0]!.caseIds = ["unit::a", "unit::b"];
        writeFileSync(join(project.root, E2E_POLICY_PATH), JSON.stringify(policy));
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).toBe(0);
        expect(verdict(project.root).satisfied).toBe(true);
    }, TIMEOUT);
    it("P3: editing the run script (a source input) after a green run makes the scenario stale", async () => {
        const { project } = structuredFixture(JSON_REPORT);
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).toBe(0);
        writeFileSync(join(project.root, "run-tests.mjs"), "process.exit(0);\n");
        expect(verdict(project.root).status).toBe("stale");
    }, TIMEOUT);
});
describe("structured-runner suite — negative (report format alone never qualifies, PE-55)", () => {
    it("N1: a report that omits a declared case leaves it not-run; gate 1", async () => {
        const { project } = structuredFixture({ version: 1, cases: [{ id: "unit/a", status: "passed" }] });
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).toBe(1);
        const row = verdict(project.root);
        expect(row.reasons.map(reason => reason.code)).toContain("CASE_NOT_RUN");
        expect(row.reasons.map(reason => reason.message).join("\n")).toMatch(/unit\/b/);
    }, TIMEOUT);
    it("N2: skipped and todo are not passes; a failed case is a measured failure", async () => {
        const { project } = structuredFixture({ version: 1, cases: [{ id: "unit/a", status: "skipped" }, { id: "unit/b", status: "failed", message: "boom" }] });
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).toBe(1);
        const codes = verdict(project.root).reasons.map(reason => reason.code);
        expect(codes).toContain("CASE_UNAVAILABLE");
        expect(codes).toContain("CASE_FAILED");
    }, TIMEOUT);
    it("N3: a run that produces no report is incomplete, and a pre-existing (stale) report at that path is removed first, never substituted", async () => {
        const { project } = structuredFixture(JSON_REPORT, { writeReport: false });
        writeFileSync(join(project.root, "report.json"), JSON.stringify(JSON_REPORT)); // a leftover all-green report in the live tree
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).toBe(1); // the declared cases never ran: an unsatisfied requirement (same shape as a failed prepare step, PE-24)
        const receipt = JSON.parse(readFileSync(join(project.root, result.receipts[0]!.path), "utf8"));
        expect(receipt.completion.complete).toBe(false);
        expect(receipt.completion.reasons.join("\n")).toMatch(/report\.json was not produced/);
        expect(verdict(project.root).reasons.map(reason => reason.code)).toContain("RUN_INCOMPLETE");
        expect(existsSync(join(project.root, "report.json"))).toBe(true); // the live tree is never touched
    }, TIMEOUT);
    it("N4: a malformed or truncated report is incomplete with the parser's reason, never a partial pass", async () => {
        const { project } = structuredFixture("{\"version\":1,\"cases\":[{\"id\":\"unit/a\",\"status\":\"passed\"}");
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).exitCode).toBe(1);
        const row = verdict(project.root);
        expect(row.reasons.map(reason => reason.code)).toContain("RUN_INCOMPLETE");
        expect(row.reasons.map(reason => reason.message).join("\n")).toMatch(/not valid JSON/);
    }, TIMEOUT);
    it("N5: the policy parser refuses a structured suite without run/report, a scenario on it without caseIds, a boundary claim on it, and caseIds on a managed-contracts suite", () => {
        const { policy } = structuredFixture(JSON_REPORT);
        const attempt = (mutate: (policy: E2ePolicy) => void) => { const copy = JSON.parse(JSON.stringify(policy)) as E2ePolicy; mutate(copy); return () => parseE2ePolicy(JSON.stringify(copy)); };
        expect(attempt(copy => { delete copy.projects[0]!.suites[1]!.report; })).toThrow(/report/);
        expect(attempt(copy => { delete copy.projects[0]!.suites[1]!.run; })).toThrow(/run/);
        expect(attempt(copy => { delete copy.projects[0]!.scenarios[0]!.caseIds; })).toThrow(/caseIds/);
        expect(attempt(copy => { copy.projects[0]!.scenarios[0]!.boundary = { entry: "process", real: ["application"] }; })).toThrow(/boundary/);
        expect(attempt(copy => { copy.projects[0]!.scenarios[0]!.suite = "cli"; })).toThrow(/caseIds/);
        expect(attempt(copy => { copy.projects[0]!.suites[1]!.report = { format: "yaml" as "json", path: "r.yaml" }; })).toThrow(/format/);
        expect(attempt(copy => { copy.projects[0]!.scenarios[0]!.contractIds = []; })).toThrow(/contractIds/);
    });
});
