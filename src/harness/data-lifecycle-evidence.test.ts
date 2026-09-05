import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordRecurrenceScan } from "./recurrence-scan-capture.js";
import { captureGuardWarnings } from "./warning-evidence.js";
import { scoreFindings, writeTelemetry, type Finding } from "./suggestion-scorer.js";
import type { HarnessEvent } from "./types.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "data-lifecycles-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });
function rows(source: string): Array<Record<string, unknown>> {
    return readFileSync(join(cwd, ".interlinked", `${source}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
describe("evidence lifecycles", () => {
    it("records unchanged scan receipts without duplicating findings, then records absence", () => {
        const input = { cwd, roots: ["src"], extensions: [".ts"], includeCI: false, findings: [{ file: "a.ts", check_id: "check", line: 1, text: "finding" }] };
        recordRecurrenceScan(input); recordRecurrenceScan(input);
        recordRecurrenceScan({ ...input, findings: [] });
        expect(rows("recurrences")).toHaveLength(1);
        expect(rows("recurrence-scans").map((row) => row.kind)).toEqual(["scan", "scan", "not-observed-in-scan", "scan"]);
        expect(rows("recurrence-scans")[1]?.unchanged).toBe(true);
    });
    it("retains first/change text, counts repeats, and labels disappearance honestly", () => {
        const event: HarnessEvent = { hook_event: "PostToolUse", session_id: "s", agent_source: "codex", timestamp: "2026-09-05T10:00:00Z" };
        const decision = { decision: "allow", warnings: ["[interlinked:example] 1 warning"] } as const;
        captureGuardWarnings(cwd, event, { ...decision, warnings: [...decision.warnings] });
        const repeated = captureGuardWarnings(cwd, event, { ...decision, warnings: [...decision.warnings] });
        captureGuardWarnings(cwd, event, { decision: "allow", warnings: ["[interlinked:example] 2 warning"] });
        captureGuardWarnings(cwd, event, { decision: "allow", warnings: [] });
        expect(repeated?.[0]).toContain("occurrence 2");
        expect(rows("warning-occurrences").map((row) => row.kind)).toEqual(["first", "repeat", "changed", "not-reported"]);
    });
    it("links hidden candidate scores to later same-file scan outcomes", () => {
        const findings: Finding[] = [{ check: "silent-catch", line: 1, message: "problem", source: "quality" }];
        const scored = scoreFindings(findings, { filePath: "a.ts", inlineSuppressions: new Map(), fileSuppressions: new Set() });
        const options = { interlinkedDir: join(cwd, ".interlinked"), sessionId: "s", agentName: "a", filePath: "a.ts", threshold: 0.5 };
        writeTelemetry(findings, scored, options); writeTelemetry([], [], options);
        expect(rows("suggestion-telemetry")[0]).toMatchObject({ shown: false, score_status: "measured" });
        expect(rows("suggestion-outcomes")[0]).toMatchObject({ outcome: "not_observed", finding_id: rows("suggestion-telemetry")[0]?.finding_id });
    });
});
