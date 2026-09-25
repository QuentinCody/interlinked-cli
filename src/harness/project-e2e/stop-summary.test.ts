// Unit F6 (plan §12, PE-39): the Stop reminder for project e2e obligations is
// BOUNDED — an unchanged set of open obligations is reminded a fixed number
// of times per session, then paused until the set changes; an obligation
// that is unavailable here is a truthful handoff, never a "run it again"
// loop; a quarantined required scenario stays visible with the repair path.
import { describe, expect, it } from "vitest";
import type { ScenarioVerdict } from "./qualify.js";
import { MAX_STOP_REMINDERS, StopReminderMemory, stopSummary } from "./stop-summary.js";

const dims = (stability: ScenarioVerdict["dimensions"]["stability"] = "not-required"): ScenarioVerdict["dimensions"] => ({ execution: "passed", provenance: "matched", boundary: "process-driver", authority: "accepted", scope: "complete", completion: "complete", sensitivity: "not-required", stability, observations: "not-required" });
const open = (id: string, status: ScenarioVerdict["status"], extra: Partial<ScenarioVerdict> = {}): ScenarioVerdict => ({ key: `p/${id}`, projectId: "p", scenarioId: id, required: true, satisfied: false, status, generation: `g-${id}`, reasons: [], advisories: [], dimensions: dims(), ...extra });

describe("stop summary — positive", () => {
    it("P1: an unchanged open set is reminded MAX_STOP_REMINDERS times, then one pause note, then nothing until the set changes; a change resets the count", () => {
        const memory = new StopReminderMemory();
        const rows = [open("a", "pending")];
        for (let i = 0; i < MAX_STOP_REMINDERS; i += 1) expect(stopSummary(rows, memory, "s1")).toMatch(/1 required scenario\(s\) unresolved: p\/a \(pending\)/);
        expect(stopSummary(rows, memory, "s1")).toMatch(/reminders paused/);
        expect(stopSummary(rows, memory, "s1")).toBeNull();
        expect(stopSummary(rows, memory, "s1")).toBeNull();
        expect(stopSummary([open("a", "pending", { generation: "g2" })], memory, "s1")).toMatch(/unresolved/); // a new generation is a new obligation
        expect(stopSummary(rows, memory, "s2")).toMatch(/unresolved/); // another session has its own count
    });
    it("P2: a quarantined required scenario stays visible and names the repair path", () => {
        const memory = new StopReminderMemory();
        const line = stopSummary([open("q", "failed", { dimensions: dims("quarantined") })], memory, "s1");
        expect(line).toMatch(/p\/q \(quarantined\)/);
        expect(line).toMatch(/interlinked tests e2e qualify/);
    });
    it("P3: an empty open set is silent and clears the session's count", () => {
        const memory = new StopReminderMemory();
        stopSummary([open("a", "pending")], memory, "s1");
        expect(stopSummary([], memory, "s1")).toBeNull();
        expect(memory.count("s1")).toBe(0);
    });
});
describe("stop summary — negative (no continuation loop)", () => {
    it("N1: when every open obligation is unavailable here, the line is a handoff — it names the first reason and does NOT say to run the suite again", () => {
        const memory = new StopReminderMemory();
        const line = stopSummary([open("u", "unavailable", { reasons: [{ code: "CASE_UNAVAILABLE", message: "cargo is not installed" }] })], memory, "s1");
        expect(line).toMatch(/unavailable here/);
        expect(line).toMatch(/cargo is not installed/);
        expect(line).not.toMatch(/Run: interlinked tests e2e run/);
        expect(line).toMatch(/hand off/);
    });
    it("N2: the handoff is bounded too — after the pause note it is silent", () => {
        const memory = new StopReminderMemory();
        const rows = [open("u", "unavailable", { reasons: [{ code: "PREPARE_FAILED", message: "build tool missing" }] })];
        for (let i = 0; i < MAX_STOP_REMINDERS + 1; i += 1) expect(stopSummary(rows, memory, "s1")).not.toBeNull();
        expect(stopSummary(rows, memory, "s1")).toBeNull();
    });
});
