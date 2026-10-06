import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { appendCheckObservation, makeCheckObservation, RAW_FILE_CHECK_CONFIGURATION } from "./check-observation-store.js";
import { readFindingOutcomes } from "./check-observation-reader.js";

it("retains an exact input observation and reads outcomes without an emission claim", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "observations-"));
    const event = { hook_event: "Stop", session_id: "s", agent_source: "codex", timestamp: "2026-10-04T00:00:00Z" };
    try {
        const row = makeCheckObservation({ event, file: "a.ts", content: "x()", scope: "full", configuration: RAW_FILE_CHECK_CONFIGURATION,
            executions: [{ check: "nan_comparison", status: "completed", findings: [{ line: 1, text: "x()" }], emitted: null, duration_ms: 1 }] });
        appendCheckObservation(cwd, event, row);
        const report = await readFindingOutcomes(cwd);
        expect(report.observations).toBe(1);
        expect(report.checks[0]).toMatchObject({ unique_findings: 1, emissions: 0, delivery_unknown: 1 });
        const before = readFileSync(join(cwd, ".interlinked/check-results.jsonl"), "utf8");
        appendCheckObservation(cwd, { ...event, dry_run: true }, row);
        expect(readFileSync(join(cwd, ".interlinked/check-results.jsonl"), "utf8")).toBe(before);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
});
