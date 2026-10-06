import { describe, expect, it } from "vitest";
import { foldObservation, summarizeOutcomes, type CheckObservation, type DetectorExecution, type FindingState } from "./finding-outcomes.js";

const execution: DetectorExecution = { check: "bad", status: "completed", findings: [{ line: 1, text: "bad()" }], emitted: true, duration_ms: 1 };
const initial: CheckObservation = {
    schema: "check-observations.v1", ts: "2026-10-04T00:00:00Z", session: "s", call: "1",
    file: "a.ts", input: "input-1", detector: "build-1", configuration: "policy-1", scope: "full",
    executions: [execution],
};
function empty(overrides: Partial<CheckObservation> = {}): CheckObservation {
    return { ...initial, call: "next", input: "input-2", executions: [{ ...execution, findings: [], emitted: false }], ...overrides };
}
describe("outcomes require compatible executions, not result-name absence", () => {
    it("keeps a renamed defect open and does not multiply it across detector builds", () => {
        const state = new Map<string, FindingState>();
        foldObservation(state, initial);
        foldObservation(state, { ...initial, call: "renamed", input: "changed",
            executions: [{ ...execution, findings: [{ line: 1, text: "renamedBad()" }] }] });
        expect(summarizeOutcomes(state)[0]).toMatchObject({ unique_findings: 1, present: 1,
            rechecked_clean: 0, ambiguous_occurrences: 1, followup_coverage: 0 });
        foldObservation(state, { ...initial, call: "new-build", detector: "build-2" });
        expect(summarizeOutcomes(state)[0]).toMatchObject({ unique_findings: 1, present: 1,
            rechecked_clean: 0, followup_coverage: 0 });
    });
    it("does not guess which identical occurrence cleared when multiplicity changes", () => {
        const state = new Map<string, FindingState>();
        foldObservation(state, { ...initial, executions: [{ ...execution,
            findings: [{ line: 1, text: "bad()" }, { line: 2, text: "bad()" }] }] });
        foldObservation(state, { ...initial, call: "one-left", input: "changed" });
        expect(summarizeOutcomes(state)[0]).toMatchObject({ unique_findings: 2, present: 1, not_rechecked: 1,
            rechecked_clean: 0, ambiguous_occurrences: 2, followup_coverage: 0 });
        foldObservation(state, empty());
        expect(summarizeOutcomes(state)[0]).toMatchObject({ rechecked_clean: 2, ambiguous_occurrences: 0 });
    });
    it("honors per-occurrence intended delivery over the check default", () => {
        const state = new Map<string, FindingState>();
        foldObservation(state, { ...initial, executions: [{ ...execution, findings: [
            { line: 1, text: "one", emitted: false }, { line: 2, text: "two", emitted: true, suppressed: "reviewed debt" },
        ] }] });
        expect(summarizeOutcomes(state)[0]).toMatchObject({ unique_findings: 2, emissions: 1, acknowledged: 1, rechecked_clean: 0 });
    });
    it("counts ten emissions and a clean recheck as one cleared finding", () => {
        const state = new Map<string, FindingState>();
        for (let i = 0; i < 10; i++) foldObservation(state, { ...initial, call: String(i) });
        foldObservation(state, empty());
        expect(summarizeOutcomes(state)[0]).toMatchObject({ unique_findings: 1, emissions: 10, findings_ever_emitted: 1,
            repeat_emissions: 9, rechecked_clean: 1, followup_coverage: 1, observed_clearance: 1 });
    });
    it.each([
        empty({ scope: "partial" }), empty({ executions: [] }), empty({ detector: "different" }),
        empty({ configuration: "different" }), empty({ input: null }),
    ])("does not clear from partial, disabled, changed, or unbound evidence", (observation) => {
        const state = new Map<string, FindingState>();
        foldObservation(state, initial); foldObservation(state, observation);
        expect(summarizeOutcomes(state)[0]).toMatchObject({ rechecked_clean: 0, not_rechecked: 1 });
    });
    it.each(["unavailable", "suppressed", "removed"] as const)("retains %s without calling it a fix", (status) => {
        const state = new Map<string, FindingState>(); foldObservation(state, initial);
        foldObservation(state, empty({ executions: [{ ...execution, status, findings: [] }] }));
        expect([...state.values()][0]?.latest).toBe(status);
        expect(summarizeOutcomes(state)[0]?.rechecked_clean).toBe(0);
    });
    it("retains identical occurrences and recurrence without inflating the denominator", () => {
        const state = new Map<string, FindingState>();
        const pair = { ...initial, executions: [{ ...execution, findings: [{ line: 1, text: "bad()" }, { line: 2, text: "bad()" }] }] };
        foldObservation(state, pair); foldObservation(state, empty()); foldObservation(state, { ...pair, call: "again" });
        expect(summarizeOutcomes(state)[0]).toMatchObject({ unique_findings: 2, present: 2, recurrences: 2, ambiguous_occurrences: 0 });
    });
    it("does not invent delivery or follow-up for a finding seen once", () => {
        const state = new Map<string, FindingState>();
        foldObservation(state, { ...initial, executions: [{ ...execution, emitted: null }] });
        expect(summarizeOutcomes(state)[0]).toMatchObject({ emissions: 0, delivery_unknown: 1, followup_coverage: 0, observed_clearance: null });
    });
});
