import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureProject, type FixtureProject } from "../../harness/project-e2e/__tests__/fixture-projects.js";
import { E2E_POLICY_PATH } from "../../harness/project-e2e/policy.js";
import { SURFACE_INVENTORY_PATH } from "../../harness/project-e2e/surfaces.js";
import { output, outputError } from "../../lib/output.js";
import { testsE2eAdoptionCommand } from "../tests-e2e-adopt.js";

vi.mock("../../lib/output.js", () => ({ getOutputMode: () => "json", output: vi.fn(), outputError: vi.fn() }));

const exitCode = process.exitCode;
const projects: FixtureProject[] = [];
beforeEach(() => { vi.clearAllMocks(); process.exitCode = undefined; });
afterEach(() => { process.exitCode = exitCode; for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
function lastOutput(): unknown { return vi.mocked(output).mock.calls.at(-1)?.[1]; }
function unconfigured(kind: "ts" | "py"): FixtureProject {
    const project = fixtureProject(kind); projects.push(project);
    rmSync(join(project.root, E2E_POLICY_PATH));
    return project;
}

describe("tests e2e adoption workflow — positive", () => {
    it("P1: discover inspects (exit 0), writes the report with --out, and adopt --from writes an advisory policy that doctor then diagnoses", async () => {
        const project = unconfigured("py");
        const report = join(project.root, "discovery.json");
        await testsE2eAdoptionCommand("discover", { cwd: project.root, out: report });
        expect(process.exitCode).toBeUndefined();
        expect(JSON.parse(readFileSync(report, "utf8")).proposal.projects[0].mode).toBe("advisory");
        await testsE2eAdoptionCommand("adopt", { cwd: project.root, from: report });
        expect(process.exitCode).toBeUndefined();
        expect(existsSync(join(project.root, E2E_POLICY_PATH))).toBe(true);
        expect(lastOutput()).toMatchObject({ written: true, policy: { projects: [{ mode: "advisory" }] } });
        await testsE2eAdoptionCommand("doctor", { cwd: project.root });
        expect(lastOutput()).toMatchObject({ status: expect.stringMatching(/ok|warn/), checks: expect.arrayContaining([expect.objectContaining({ id: "policy", status: "ok" })]) });
        expect(process.exitCode).toBeUndefined();
    });
    it("P2: surfaces maps the configured policy and --write persists the replaceable inventory", async () => {
        const project = fixtureProject("ts"); projects.push(project);
        await testsE2eAdoptionCommand("surfaces", { cwd: project.root, write: true });
        expect(process.exitCode).toBeUndefined();
        expect(existsSync(join(project.root, SURFACE_INVENTORY_PATH))).toBe(true);
        expect(lastOutput()).toMatchObject({ inventory: { version: 1 }, mappings: expect.any(Array), path: SURFACE_INVENTORY_PATH });
    });
    it("P3: adopt narrows to --project/--scenario and only an explicit --mode required produces required mode", async () => {
        const project = unconfigured("ts");
        const report = join(project.root, "discovery.json");
        await testsE2eAdoptionCommand("discover", { cwd: project.root, out: report });
        const proposal = JSON.parse(readFileSync(report, "utf8")).proposal;
        const projectId = proposal.projects[0].id, scenarioId = proposal.projects[0].scenarios[0].id;
        await testsE2eAdoptionCommand("adopt", { cwd: project.root, from: report, project: [projectId], scenario: [scenarioId], mode: "required" });
        const written = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8"));
        expect(written.projects.map((row: { id: string }) => row.id)).toEqual([projectId]);
        expect(written.projects[0].scenarios.map((row: { id: string }) => row.id)).toEqual([scenarioId]);
        expect(written.projects[0].mode).toBe("required");
    });
});
describe("tests e2e adoption workflow — negative (never a silent pass)", () => {
    it("N1: adopt without --from is a usage error (exit 2); adopt over an existing policy without --replace is a refusal (exit 1)", async () => {
        const project = fixtureProject("py"); projects.push(project);
        await testsE2eAdoptionCommand("adopt", { cwd: project.root });
        expect(process.exitCode).toBe(2);
        expect(vi.mocked(outputError).mock.calls.at(-1)?.[1]).toMatch(/--from/);
        process.exitCode = undefined;
        const report = join(project.root, "discovery.json");
        writeFileSync(report, JSON.stringify({ version: 1, root: project.root, projects: [], ambiguities: [], proposal: JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) }));
        await testsE2eAdoptionCommand("adopt", { cwd: project.root, from: report });
        expect(process.exitCode).toBe(1);
        expect(vi.mocked(outputError).mock.calls.at(-1)?.[1]).toMatch(/already exists.*--replace/);
    });
    it("N2: surfaces and doctor on an unconfigured repository exit 2 and name the discover command", async () => {
        const project = unconfigured("py");
        await testsE2eAdoptionCommand("surfaces", { cwd: project.root });
        expect(process.exitCode).toBe(2);
        expect(vi.mocked(outputError).mock.calls.at(-1)?.[1]).toMatch(/tests e2e discover/);
        process.exitCode = undefined;
        await testsE2eAdoptionCommand("doctor", { cwd: project.root });
        expect(process.exitCode).toBe(2);
        expect(lastOutput()).toMatchObject({ checks: [expect.objectContaining({ id: "policy", status: "fail", detail: expect.stringMatching(/tests e2e discover/) })] });
    });
    it("N3: an invalid --mode is rejected before anything is written", async () => {
        const project = unconfigured("ts");
        const report = join(project.root, "discovery.json");
        await testsE2eAdoptionCommand("discover", { cwd: project.root, out: report });
        await testsE2eAdoptionCommand("adopt", { cwd: project.root, from: report, mode: "strict" });
        expect(process.exitCode).toBe(2);
        expect(existsSync(join(project.root, E2E_POLICY_PATH))).toBe(false);
    });
});
