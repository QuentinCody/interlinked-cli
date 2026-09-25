import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { adoptPolicy } from "./adopt.js";
import { discoverProjects } from "./discover.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH, loadE2ePolicy } from "./policy.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
function unconfigured(language: "ts" | "py"): FixtureProject {
    const project = fixtureProject(language); projects.push(project);
    rmSync(join(project.root, E2E_POLICY_PATH));
    return project;
}

describe("adoptPolicy — positive", () => {
    it("P1: adopting a discovery proposal writes an advisory policy that loads, reconciles and evaluates (configuration alone is no pass)", () => {
        const project = unconfigured("py");
        const report = discoverProjects(project.root);
        const result = adoptPolicy({ root: project.root, proposal: report, atMs: 1 });
        expect(result.written).toBe(true);
        expect(existsSync(join(project.root, E2E_POLICY_PATH))).toBe(true);
        const loaded = loadE2ePolicy(project.root);
        expect(loaded.status).toBe("configured");
        if (loaded.status !== "configured") return;
        expect(loaded.policy.projects[0]?.mode).toBe("advisory");
        expect(loaded.policy.expectations).toEqual([]);
        const evaluation = evaluateE2e({ root: project.root, atMs: 2 });
        expect(evaluation.verdicts.map(row => row.status)).toEqual(["pending", "pending"]);
        expect(evaluation.exitCode).toBe(0); // advisory scenarios never gate; they are visible
    });
    it("P2: an explicit selection narrows projects and scenarios, and --mode required is the only way to require", () => {
        const project = unconfigured("ts");
        const report = discoverProjects(project.root);
        const result = adoptPolicy({ root: project.root, proposal: report, scenarioIds: ["orders.create"], mode: "required", atMs: 1 });
        expect(result.policy.projects[0]?.scenarios.map(row => row.id)).toEqual(["orders.create"]);
        expect(result.policy.projects[0]?.mode).toBe("required");
        expect(result.policy.projects[0]?.scenarios[0]?.required).toBe(true);
    });
});
describe("adoptPolicy — negative (never silent)", () => {
    it("N1: an existing policy is not overwritten without replace, and the refusal names the file", () => {
        const project = fixtureProject("py"); projects.push(project);
        const before = readFileSync(join(project.root, E2E_POLICY_PATH), "utf8");
        expect(() => adoptPolicy({ root: project.root, proposal: discoverProjects(project.root), atMs: 1 })).toThrow(/already exists.*--replace/);
        expect(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")).toBe(before);
        expect(adoptPolicy({ root: project.root, proposal: discoverProjects(project.root), replace: true, atMs: 1 }).written).toBe(true);
    });
    it("N2: a proposal carrying expectations has them stripped — adoption never accepts inferred behavior", () => {
        const project = unconfigured("py");
        const report = discoverProjects(project.root);
        // SAFETY (test): a proposal is a plain object; an expectation is injected to prove it is dropped.
        (report.proposal as unknown as { expectations: unknown[] }).expectations = [{ id: "inferred", lifecycle: "accepted" }];
        const result = adoptPolicy({ root: project.root, proposal: report, atMs: 1 });
        expect(result.policy.expectations).toEqual([]);
        expect(result.notes.join("\n")).toMatch(/expectations are never adopted/);
    });
    it("N3: unknown project or scenario selections and an invalid proposal are refused before any write", () => {
        const project = unconfigured("py");
        const report = discoverProjects(project.root);
        expect(() => adoptPolicy({ root: project.root, proposal: report, projectIds: ["ghost"], atMs: 1 })).toThrow(/unknown project ghost/);
        expect(() => adoptPolicy({ root: project.root, proposal: report, scenarioIds: ["ghost"], atMs: 1 })).toThrow(/unknown scenario ghost/);
        // SAFETY (test): corrupt the proposal to prove the parser gate runs before the write.
        (report.proposal as unknown as { version: number }).version = 7;
        expect(() => adoptPolicy({ root: project.root, proposal: report, atMs: 1 })).toThrow(/unknown schema version/);
        expect(existsSync(join(project.root, E2E_POLICY_PATH))).toBe(false);
    });
});
