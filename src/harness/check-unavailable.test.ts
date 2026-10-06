import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recordUnavailableCheck } from "./check-unavailable.js";

it("persists an execution error without inventing a source finding or blocking", () => {
    const cwd = mkdtempSync(join(tmpdir(), "check-unavailable-"));
    try {
        recordUnavailableCheck({ cwd, check: "throwing-detector", error: new Error("broken"), event: {
            hook_event: "PreToolUse", session_id: "s", agent_source: "codex", timestamp: "2026-10-04T00:00:00Z", tool_use_id: "call",
        } });
        const rows = readFileSync(join(cwd, ".interlinked/check-results.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        const row = rows.at(-1);
        expect(row.execution).toEqual([{ id: "throwing-detector", status: "error", reason: "broken" }]);
        expect(row.actual_decision).toBe("allow");
        expect(row.checks).toEqual([]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
});
