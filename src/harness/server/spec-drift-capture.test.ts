import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatSpecDriftWarning } from "../spec-stop-checks.js";
import type { SpecDriftFinding } from "../spec/ledger.js";
import type { SessionTrajectory } from "../types.js";
import { captureSpecDrift } from "./spec-drift-capture.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const cwd = mkdtempSync(join(tmpdir(), "spec-drift-capture-"));
    roots.push(cwd);
    // SAFETY: capture only reads session_id and reads/replaces spec_drift_outstanding.
    const session = ({ ...makeSessionFixture(),  session_id: "test-session" } satisfies SessionTrajectory);
    return { cwd, session };
}

const advisory: SpecDriftFinding = {
    kind: "range_claim_drift", file: "review.md", line: 2,
    message: "Inferred range disagrees with another document", relatedFiles: ["plan.md"],
};
const structural: SpecDriftFinding = {
    kind: "declared_fact_drift", file: "contract.md", line: 5,
    message: "Explicit mode marker disagrees with plan.md", relatedFiles: ["plan.md"],
};

describe("spec evidence capture and Stop confidence", () => {
    it("preserves advisory evidence without emitting a Stop nudge", () => {
        const { cwd, session } = fixture();
        captureSpecDrift(cwd, "review.md", [advisory], session);
        expect(formatSpecDriftWarning(session.spec_drift_outstanding)).toBeNull();
        const row = JSON.parse(readFileSync(join(cwd, ".interlinked/spec-drift.jsonl"), "utf8").trim());
        expect(row).toMatchObject({ kind: "range_claim_drift", stop_eligible: false, message: advisory.message });
        expect(session.spec_drift_outstanding?.[0]?.kind).toBe("range_claim_drift");
    });

    it("prioritizes structural evidence before the stash cap without dropping logged findings", () => {
        const { cwd, session } = fixture();
        const findings = [...Array.from({ length: 12 }, (_, line) => ({ ...advisory, line })), structural];
        captureSpecDrift(cwd, "review.md", findings, session);
        expect(session.spec_drift_outstanding).toHaveLength(10);
        const warning = formatSpecDriftWarning(session.spec_drift_outstanding);
        expect(warning).toContain("1 retained structural spec finding(s)");
        expect(warning).toContain("contract.md:5");
        expect(warning).not.toContain("review.md:2");
        const logPath = join(cwd, ".interlinked/spec-drift.jsonl");
        const retained = readFileSync(logPath, "utf8");
        expect(retained.trim().split("\n")).toHaveLength(13);
        captureSpecDrift(cwd, "contract.md", [], session);
        expect(formatSpecDriftWarning(session.spec_drift_outstanding)).toBeNull();
        expect(readFileSync(logPath, "utf8")).toBe(retained);
    });
});
