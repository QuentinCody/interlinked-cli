import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureNativeToolData, nativeFileRecords, nativeVerificationRecord } from "./data-capture-native.js";
import { checkExecutionEvidence } from "./check-execution-evidence.js";
import { captureTimelineUsage } from "./data-capture-usage.js";
import type { HarnessEvent } from "./types.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "native-data-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });
function event(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
    return { hook_event: "PostToolUse", agent_source: "codex", session_id: "test-session", timestamp: "2026-09-05T10:00:00Z",
        tool_name: "Bash", tool_input: { command: "npm test" }, ...overrides };
}
function rows(name: string): Array<Record<string, unknown>> {
    return readFileSync(join(cwd, ".interlinked", `${name}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
describe("native data capture", () => {
	it("records provider outcomes and measured duration without inferring success from missing data", () => {
		expect(nativeVerificationRecord(event({ tool_outcome: "error", tool_response: { duration_ms: 12 } })))
			.toMatchObject({ outcome: "fail", basis: "provider", duration_ms: 12, duration_status: "provider-reported" });
		expect(nativeVerificationRecord(event({ tool_outcome: "success", tool_response: { elapsed_ms: -1 } })))
			.toMatchObject({ outcome: "pass", basis: "provider", duration_ms: null, duration_status: "not-reported" });
		expect(nativeVerificationRecord(event({ tool_input: {} }))).toBeNull();
		expect(nativeVerificationRecord(event({ tool_input: { command: "ls" } }))).toBeNull();
	});
	it("keeps provider-declared paths distinct from observed effects and deduplicates them", () => {
		expect(nativeFileRecords(event({ files_modified: ["a.ts", "a.ts", "b.ts"] }))).toMatchObject([
			{ file: "a.ts", evidence: "provider-declared", attribution: "declared-target", shadow: false, observation_complete: false },
			{ file: "b.ts", evidence: "provider-declared", attribution: "declared-target", shadow: false, observation_complete: false },
		]);
	});
    it("uses explicit outcomes and retains unknown instead of treating stderr as failure", () => {
        expect(nativeVerificationRecord(event({ exit_code: 0, stderr: "npm warning" }))).toMatchObject({ outcome: "pass", basis: "exit-code" });
        expect(nativeVerificationRecord(event())).toMatchObject({ outcome: "unknown" });
        expect(nativeVerificationRecord(event({ tool_outcome: "interrupted", exit_code: 0 }))).toMatchObject({ outcome: "interrupted" });
    });
    it("records every observed shell/MCP file effect with hashes and scope", () => {
        const files = [{ path: "a.ts", kind: "modified", before_sha256: "a", after_sha256: "b" }, { path: "b.ts", kind: "created", before_sha256: null, after_sha256: "c" }] as const;
        const ev = event({ change_set: { source: "filesystem-observation", complete: false, before_captured_at: "before", after_captured_at: "after", files: [...files] } });
        expect(nativeFileRecords(ev)).toHaveLength(2);
        captureNativeToolData(cwd, ev);
        expect(rows("files-touched")[1]).toMatchObject({ file: "b.ts", evidence: "filesystem-observation", observation_complete: false });
        expect(rows("capture-receipts")).toHaveLength(2);
    });
    it("preserves absent usage and emits a stable provider message identity", () => {
        captureTimelineUsage(cwd, [{ schema: "timeline.v1", ts: "2026-09-05", session: "s", uuid: "u", seq: 0, category: "agent_message", role: "assistant", provider: "codex", usage: { input: 12, output: 3 } }]);
        expect(rows("costs")[0]).toMatchObject({ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: null, usage_semantics: "provider-message-delta" });
    });
    it("separates completed, deferred and disabled checks", () => {
        expect(checkExecutionEvidence({ decision: "allow", checks_ran: ["typescript"], checks_skipped: [
            { check: "lint", category: "resource_busy", reason: "busy" }, { check: "audit", category: "config_disabled", reason: "disabled" }],
        })).toEqual([{ id: "typescript", status: "completed_no_reported_findings" }, { id: "lint", status: "deferred", reason: "busy" }, { id: "audit", status: "skipped", reason: "disabled" }]);
    });
});
