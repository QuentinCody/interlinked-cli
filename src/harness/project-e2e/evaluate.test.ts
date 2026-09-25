import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, touchSource, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e, formatEvaluation } from "./evaluate.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 60_000;

describe("evaluateE2e", () => {
    it("P1: unconfigured is explicit and exits 2; it is never a pass (PE-42)", () => {
        const project = fixtureProject("py"); projects.push(project);
        rmSync(`${project.root}/.interlinked/e2e-policy.json`);
        const evaluation = evaluateE2e({ root: project.root, atMs: 1 });
        expect(evaluation).toMatchObject({ status: "unconfigured", exitCode: 2, verdicts: [] });
        expect(formatEvaluation(evaluation)[0]).toMatch(/UNCONFIGURED/);
    });
    it("P2: before any run every required scenario is pending with NO_EVIDENCE (exit 1); after a run it is satisfied (exit 0); after a relevant edit it is stale (PE-03, PE-04)", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const before = evaluateE2e({ root: project.root, atMs: 1 });
        expect(before.verdicts.map(row => [row.scenarioId, row.status])).toEqual([["order-persists", "pending"]]);
        expect(before.exitCode).toBe(1);
        await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const after = evaluateE2e({ root: project.root, atMs: 2 });
        expect(after.verdicts[0]).toMatchObject({ status: "satisfied", satisfied: true });
        expect(after.exitCode).toBe(0);
        expect(formatEvaluation(after).join("\n")).toMatch(/order-persists: satisfied/);
        touchSource(project);
        const stale = evaluateE2e({ root: project.root, atMs: 3 });
        expect(stale.verdicts[0]?.satisfied).toBe(false);
        expect(stale.verdicts[0]?.reasons.map(row => row.code)).toContain("STALE_GENERATION");
        expect(stale.exitCode).toBe(1);
    }, TIMEOUT);
    it("N1: a selected subset is labelled as a subset; whole-project satisfaction is reported separately (PE-43)", () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const evaluation = evaluateE2e({ root: project.root, atMs: 1, scenarioIds: ["order-persists"] });
        expect(evaluation.scope).toEqual({ requested: "subset", scenarioIds: ["order-persists"] });
        expect(() => evaluateE2e({ root: project.root, atMs: 1, projectId: "ghost" })).toThrow(/unknown project ghost/);
    });
});
