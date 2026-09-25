// Unit E1 acceptance: stability cohorts through the supervisor (plan §9.5,
// PE-27/80–84). Every attempt is an independent supervised run with its own
// recorded seed and clock; the cohort qualifies only when every required
// attempt passed; mixed outcomes quarantine the generation; an exhausted
// budget defers the cohort and a later call resumes it; a repair (new
// generation) starts a fresh cohort while an unchanged rerun cannot erase a
// quarantine.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { qualifyStability } from "./cohort.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH, type E2ePolicy, type E2eStability } from "./policy.js";
import type { E2eReceipt } from "./receipt.js";
import { quarantineFor, readCohort } from "./stability.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 120_000;
const SAVE_LINE = "        json.dump(orders, handle, separators=(\",\", \":\"))";
function project(stability: E2eStability): FixtureProject {
    const fixture = fixtureProject("py", { accept: true }); projects.push(fixture);
    const path = join(fixture.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(path, "utf8")) as E2ePolicy; // SAFETY: fixture-authored
    policy.projects[0]!.scenarios[0]!.stability = stability;
    writeFileSync(path, JSON.stringify(policy));
    return fixture;
}
/** The application "flakes" on one attempt: it saves nothing when the cohort attempt index equals `attempt` (an env every owned process sees). */
function flakeOn(fixture: FixtureProject, attempt: number): void {
    const path = join(fixture.root, fixture.sourceFile), source = readFileSync(path, "utf8");
    const patched = source.replace(SAVE_LINE, `        if os.environ.get("INTERLINKED_E2E_ATTEMPT") != "${attempt}":\n    ${SAVE_LINE}`);
    if (patched === source) throw new Error("save anchor not found");
    writeFileSync(path, patched.includes("import os") ? patched : `import os\n${patched}`);
}
function verdict(fixture: FixtureProject) { return evaluateE2e({ root: fixture.root, atMs: 5 }).verdicts[0]!; }
function receiptOf(fixture: FixtureProject, path: string): E2eReceipt { return JSON.parse(readFileSync(join(fixture.root, path), "utf8")) as E2eReceipt; } // SAFETY: the receipt a run wrote
const qualify = (fixture: FixtureProject, extra: Partial<Parameters<typeof qualifyStability>[0]> = {}) => qualifyStability({ root: fixture.root, scenarioId: "order-persists", timeoutMs: TIMEOUT, ...extra });

describe("stability cohorts — positive (independent passes qualify the profile)", () => {
    it("P1 (PE-80/84): three independent attempts pass ⇒ qualified; each attempt is its own run with the baseline seed first and derived seeds after, the clock recorded, and the env visible to the application", async () => {
        const fixture = project({ qualificationRuns: 3, seed: "base-7", clock: "2026-01-02T03:04:05Z" });
        const result = await qualify(fixture);
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        expect(result.cohort).toMatchObject({ verdict: "qualified", required: 3, baselineSeed: "base-7", clock: "2026-01-02T03:04:05Z" });
        expect(result.cohort.attempts.map(attempt => attempt.status)).toEqual(["passed", "passed", "passed"]);
        expect(new Set(result.cohort.attempts.map(attempt => attempt.runId)).size).toBe(3);
        expect(result.cohort.attempts[0]!.seed).toBe("base-7");
        expect(result.cohort.attempts[1]!.seed).not.toBe("base-7");
        expect(receiptOf(fixture, result.cohort.attempts[2]!.receipt).stability).toEqual({ cohortId: result.cohort.cohortId, attempt: 3, seed: result.cohort.attempts[2]!.seed, clock: "2026-01-02T03:04:05Z" });
        expect(readCohort(fixture.root, result.cohort.cohortId)?.reasons.join(" ")).toMatch(/not a flake-free guarantee/);
        const row = verdict(fixture);
        expect(row).toMatchObject({ satisfied: true, dimensions: { stability: "qualified" } });
    }, TIMEOUT);
    it("P2 (PE-82): a budget that ends after the first attempt defers the cohort with the remaining count; the next call RESUMES it (same cohort id) and qualifies", async () => {
        const fixture = project({ qualificationRuns: 2 });
        let calls = 0;
        const deferred = await qualify(fixture, { now: () => (calls++ < 2 ? 0 : 10 ** 12) }); // start, attempt-1 check, then out of budget
        expect(deferred.exitCode).toBe(2);
        expect(deferred.cohort).toMatchObject({ verdict: "deferred", attempts: [{ index: 1, status: "passed" }] });
        expect(deferred.messages.join("\n")).toMatch(/deferred: 1 attempt\(s\) remaining/);
        expect(verdict(fixture)).toMatchObject({ satisfied: false, status: "unavailable", dimensions: { stability: "deferred" } });
        const resumed = await qualify(fixture);
        expect(resumed.decision).toMatchObject({ action: "resume", remaining: 1 });
        expect(resumed.cohort.cohortId).toBe(deferred.cohort.cohortId);
        expect(resumed.cohort).toMatchObject({ verdict: "qualified", attempts: [{ index: 1 }, { index: 2, status: "passed" }] });
        expect(verdict(fixture).satisfied).toBe(true);
    }, TIMEOUT);
});
describe("stability cohorts — negative (nothing short of every attempt passing qualifies)", () => {
    it("N1 (PE-81/83): a mixed cohort is a flake finding — quarantined for this generation, every attempt retained, required completion nonzero; an unchanged rerun cannot erase it; a repair (new generation) starts a fresh cohort that qualifies", async () => {
        const fixture = project({ qualificationRuns: 3 });
        flakeOn(fixture, 2);
        const mixed = await qualify(fixture);
        expect(mixed.exitCode).toBe(1);
        expect(mixed.cohort).toMatchObject({ verdict: "mixed" });
        expect(mixed.cohort.attempts.map(attempt => attempt.status)).toEqual(["passed", "failed", "passed"]);
        const quarantine = quarantineFor(fixture.root, "orders/order-persists", mixed.cohort.generation);
        expect(quarantine).toMatchObject({ cohortId: mixed.cohort.cohortId, attempts: [{ status: "passed" }, { status: "failed" }, { status: "passed" }] });
        expect(verdict(fixture)).toMatchObject({ satisfied: false, status: "failed", dimensions: { stability: "quarantined" } });
        const rerun = await qualify(fixture);
        expect(rerun.decision).toEqual({ action: "diagnose" });
        expect(rerun.exitCode).toBe(1);
        expect(rerun.messages.join("\n")).toMatch(/quarantined/);
        expect(verdict(fixture).dimensions.stability).toBe("quarantined");
        // The repair: remove the flake. A new generation, a fresh cohort, and the old quarantine stays attached to its own generation.
        const path = join(fixture.root, fixture.sourceFile);
        writeFileSync(path, readFileSync(path, "utf8").replace(`        if os.environ.get("INTERLINKED_E2E_ATTEMPT") != "2":\n    ${SAVE_LINE}`, SAVE_LINE));
        const repaired = await qualify(fixture);
        expect(repaired.decision).toEqual({ action: "start" });
        expect(repaired.cohort.cohortId).not.toBe(mixed.cohort.cohortId);
        expect(repaired.cohort.verdict).toBe("qualified");
        expect(verdict(fixture)).toMatchObject({ satisfied: true, dimensions: { stability: "qualified" } });
        expect(quarantineFor(fixture.root, "orders/order-persists", mixed.cohort.generation)).not.toBeNull();
    }, TIMEOUT);
    it("N2: a declared stability profile with no cohort keeps the scenario open (not-qualified) even after an ordinary passing run; a scenario without a profile needs none", async () => {
        const fixture = project({ qualificationRuns: 1 });
        const { runProjectE2e } = await import("./run.js");
        expect((await runProjectE2e({ root: fixture.root, timeoutMs: TIMEOUT })).exitCode).toBe(2);
        const row = verdict(fixture);
        expect(row).toMatchObject({ satisfied: false, dimensions: { execution: "passed", stability: "not-qualified" } });
        expect(row.reasons.map(reason => reason.code)).toContain("STABILITY_NOT_QUALIFIED");
        const plain = fixtureProject("py", { accept: true }); projects.push(plain);
        expect((await runProjectE2e({ root: plain.root, timeoutMs: TIMEOUT })).exitCode).toBe(0);
        expect(verdict(plain).dimensions.stability).toBe("not-required");
    }, TIMEOUT);
    it("N3: qualify refuses an unknown scenario and a scenario without a profile unless --runs is given", async () => {
        const plain = fixtureProject("py", { accept: true }); projects.push(plain);
        await expect(qualify(plain, { scenarioId: "nope" })).rejects.toThrow(/unknown scenario nope/);
        await expect(qualify(plain)).rejects.toThrow(/declares no stability profile/);
        const explicit = await qualify(plain, { runs: 1 });
        expect(explicit.cohort).toMatchObject({ verdict: "qualified", required: 1 });
    }, TIMEOUT);
});
