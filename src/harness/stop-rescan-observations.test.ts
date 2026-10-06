import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { makeCheckObservation, RAW_FILE_CHECK_CONFIGURATION } from "./check-observation-store.js";
import { readFindingOutcomes } from "./check-observation-reader.js";
import { retainStopObservations } from "./stop-rescan-observations.js";
import { digestStopRescan, type RescanFindingLike } from "./stop-rescan-report.js";

it("counts only intended details, retains capped and deferred findings, and does not count a repeat digest", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "stop-evidence-"));
    const findings: RescanFindingLike[] = Array.from({ length: 6 }, (_, i) => ({ file: "a.ts", checkId: "nan_comparison",
        line: i + 1, text: "bad" + i, deferred: i === 5, deferReason: i === 5 ? "accepted debt" : null }));
    try {
        for (let call = 0; call < 2; call++) {
            const event = { hook_event: "Stop", agent_source: "harness", session_id: "s", tool_use_id: String(call), timestamp: "2026-10-04T00:00:00Z" };
            const row = makeCheckObservation({ event, file: "a.ts", content: "bad", scope: "full", configuration: RAW_FILE_CHECK_CONFIGURATION,
                executions: [{ check: "nan_comparison", status: "completed", findings: findings.map(f => ({ line: f.line, text: f.text })), emitted: null, duration_ms: 1 }] });
            const report = digestStopRescan({ cwd, sessionId: "s", findings });
            expect(report.intendedFindings).toHaveLength(call === 0 ? 4 : 0);
            retainStopObservations({ cwd, rows: [row], findings, intended: report.intendedFindings, dryRun: false });
        }
        const report = await readFindingOutcomes(cwd);
        expect(report.invalid_rows).toBe(0);
        expect(report.checks[0]).toMatchObject({ unique_findings: 6, emissions: 4, present: 6, rechecked_clean: 0, acknowledged: 1 });
        expect(report.state.find(f => f.disposition)?.disposition).toMatchObject({ reason: "accepted debt", session: "s" });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
});
