// Unit E1: stability cohorts (plan §9.5). The pure parts — per-attempt seed
// derivation, the cohort verdict over its attempts, the resume decision — and
// the durable cohort / quarantine records. A quarantine row is a diagnosis
// schedule, never a waiver; a rerun of an unchanged failed cohort cannot
// erase the failure (PE-81/83).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendQuarantine, attemptSeed, classifyCohort, cohortDecision, quarantineFor, readCohort, writeCohort, type CohortRecord } from "./stability.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const GENERATION = "a".repeat(64);
function cohort(statuses: Array<CohortRecord["attempts"][number]["status"]>, required = 3, extra: Partial<CohortRecord> = {}): CohortRecord {
    return { version: 1, cohortId: "c1", key: "orders/order-persists", generation: GENERATION, required, baselineSeed: "0", clock: "real", startedAt: "t", updatedAt: "t", verdict: "in-progress", reasons: [], attempts: statuses.map((status, index) => ({ index: index + 1, runId: `r${index + 1}`, receipt: `p${index + 1}`, status, seed: attemptSeed("0", index + 1), clock: "real", durationMs: 1 })), ...extra };
}

describe("stability — positive (a cohort qualifies only through independent passing attempts)", () => {
    it("P1: attempt 1 uses the baseline seed verbatim; later attempts derive distinct, reproducible seeds from it", () => {
        expect(attemptSeed("42", 1)).toBe("42");
        expect(attemptSeed("42", 2)).toMatch(/^[a-f0-9]{16}$/);
        expect(attemptSeed("42", 2)).toBe(attemptSeed("42", 2));
        expect(attemptSeed("42", 2)).not.toBe(attemptSeed("42", 3));
        expect(attemptSeed("42", 2)).not.toBe(attemptSeed("7", 2));
    });
    it("P2 (PE-80): three independent passes ⇒ qualified — a sample, never a flake-free claim", () => {
        const verdict = classifyCohort(cohort(["passed", "passed", "passed"]));
        expect(verdict).toMatchObject({ verdict: "qualified" });
        expect(verdict.reasons.join(" ")).toMatch(/3\/3 independent attempts passed/);
        expect(verdict.reasons.join(" ")).toMatch(/sample/);
    });
    it("P3: the decision for a changed profile is a fresh cohort; a deferred cohort of the same generation resumes; a quarantined generation is diagnosed, not rerun", () => {
        expect(cohortDecision({ generation: GENERATION, cohort: null, quarantined: false })).toMatchObject({ action: "start" });
        expect(cohortDecision({ generation: GENERATION, cohort: { ...cohort(["passed"]), verdict: "deferred" }, quarantined: false })).toMatchObject({ action: "resume", remaining: 2 });
        expect(cohortDecision({ generation: GENERATION, cohort: { ...cohort(["passed"], 3, { generation: "b".repeat(64) }), verdict: "deferred" }, quarantined: false })).toMatchObject({ action: "start" });
        expect(cohortDecision({ generation: GENERATION, cohort: cohort(["passed", "failed", "passed"]), quarantined: true })).toMatchObject({ action: "diagnose" });
    });
    it("P4: cohort and quarantine records round-trip through their files", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-stab-")); roots.push(root);
        const record = cohort(["passed", "failed"]);
        const path = writeCohort(root, record);
        expect(readCohort(root, record.cohortId)).toEqual(record);
        expect(readFileSync(join(root, path), "utf8")).toContain('"cohortId": "c1"');
        const row = appendQuarantine(root, { key: record.key, generation: GENERATION, cohortId: "c1", attempts: record.attempts.map(attempt => ({ runId: attempt.runId, status: attempt.status })), reason: "mixed", atMs: 10, reviewAtMs: 20 });
        expect(quarantineFor(root, record.key, GENERATION)).toEqual(row);
        expect(quarantineFor(root, record.key, "b".repeat(64))).toBeNull();
    });
});
describe("stability — negative (nothing short of every required attempt passing qualifies)", () => {
    it("N1 (PE-81): mixed pass/fail ⇒ mixed (a flake finding), never qualified", () => {
        expect(classifyCohort(cohort(["passed", "failed", "passed"]))).toMatchObject({ verdict: "mixed" });
        expect(classifyCohort(cohort(["failed", "failed", "failed"]))).toMatchObject({ verdict: "failed" });
    });
    it("N2 (PE-82): fewer attempts than required ⇒ deferred with the remaining count; partial success is not qualification", () => {
        expect(classifyCohort(cohort(["passed"]))).toMatchObject({ verdict: "deferred", remaining: 2 });
        expect(classifyCohort(cohort([]))).toMatchObject({ verdict: "deferred", remaining: 3 });
    });
    it("N3: an infrastructure gap (unavailable/stale attempt) is unavailable, distinguished from an application failure", () => {
        expect(classifyCohort(cohort(["passed", "unavailable", "passed"]))).toMatchObject({ verdict: "unavailable" });
        expect(classifyCohort(cohort(["passed", "stale", "passed"]))).toMatchObject({ verdict: "unavailable" });
        expect(classifyCohort(cohort(["failed", "unavailable", "passed"]))).toMatchObject({ verdict: "mixed" }); // a real failure is never hidden behind a gap
    });
    it("N4: an unknown cohort id reads as null; a record whose generation is malformed is refused", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-stab-")); roots.push(root);
        expect(readCohort(root, "nope")).toBeNull();
        writeCohort(root, { ...cohort(["passed"]), cohortId: "bad", generation: "short" });
        expect(readCohort(root, "bad")).toBeNull();
    });
});
