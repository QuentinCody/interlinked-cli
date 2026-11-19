import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureNativeToolData, nativeFileRecords, nativeVerificationRecord } from "./data-capture-native.js";
import { checkExecutionEvidence } from "./check-execution-evidence.js";
import { captureTimelineUsage } from "./data-capture-usage.js";
import type { HarnessEvent } from "./types.js";
import { createClaudeCodeAdapter } from "./adapters/claude-code.js";
import { toLegacyHarnessEvent } from "./legacy-client.js";
import { liftOutcomeEvidence } from "./outcome-evidence.js";

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
    // Claude Code 2.1.325 delivers a failed Bash call ONLY as PostToolUseFailure
    // (no tool_response). Native payload → adapter → daemon wire → lift → ledger.
    it("records a failed Claude test command as fail with the exit code from the failure text", () => {
        const native = { session_id: "claude-fail", cwd, tool_name: "Bash", tool_use_id: "toolu_fail_1",
            tool_input: { command: "npx vitest run src/a.test.ts" }, error: "Exit code 3\nFAIL src/a.test.ts", is_interrupt: false };
        const wire = toLegacyHarnessEvent(createClaudeCodeAdapter().parseHookInput(native, "PostToolUseFailure"));
        liftOutcomeEvidence(wire);
        expect(wire).toMatchObject({ hook_event: "PostToolUseFailure", tool_outcome: "error", exit_code: 3, stderr: "Exit code 3\nFAIL src/a.test.ts" });
        captureNativeToolData(cwd, wire);
        expect(rows("tests")[0]).toMatchObject({ kind: "test", outcome: "fail", basis: "exit-code", exit_code: 3, tool_use_id: "toolu_fail_1" });
    });
    it("records a failure that states no exit code as fail with the code left unknown", () => {
        const native = { session_id: "claude-fail", cwd, tool_name: "Bash", tool_use_id: "toolu_fail_2",
            tool_input: { command: "npx vitest run src/a.test.ts" }, error: "Command timed out after 2m 0s", is_interrupt: false };
        const wire = toLegacyHarnessEvent(createClaudeCodeAdapter().parseHookInput(native, "PostToolUseFailure"));
        liftOutcomeEvidence(wire);
        captureNativeToolData(cwd, wire);
        expect(rows("tests")[0]).toMatchObject({ outcome: "fail", basis: "provider", exit_code: null, exit_attributable: true });
    });
    it("records an interrupted failure event as interrupted, not as fail", () => {
        const native = { session_id: "claude-fail", cwd, tool_name: "Bash", tool_use_id: "toolu_fail_3",
            tool_input: { command: "npx vitest run src/a.test.ts" }, error: "Exit code 130", is_interrupt: true };
        const wire = toLegacyHarnessEvent(createClaudeCodeAdapter().parseHookInput(native, "PostToolUseFailure"));
        liftOutcomeEvidence(wire);
        captureNativeToolData(cwd, wire);
        expect(rows("tests")[0]).toMatchObject({ outcome: "interrupted", exit_code: null });
    });
    // `vitest run … | tail` exits with tail's status. The ledger must not turn
    // that 0 into a test pass: the runner's own summary decides, else unknown.
    it("does not record a pass when a pipe or a later command hides the runner's exit status", () => {
        const red = " Test Files  1 failed (1)\n      Tests  2 failed | 5 passed (7)\n";
        const green = " Test Files  1 passed (1)\n      Tests  7 passed (7)\n";
        const piped = { tool_input: { command: "npx vitest run src/a.test.ts 2>&1 | tail -5" }, tool_outcome: "success" as const, exit_code: 0 };
        expect(nativeVerificationRecord(event({ ...piped, stdout: red })))
            .toMatchObject({ kind: "test", outcome: "fail", basis: "runner-summary", exit_code: 0, exit_attributable: false });
        expect(nativeVerificationRecord(event({ ...piped, stdout: green })))
            .toMatchObject({ outcome: "pass", basis: "runner-summary", exit_code: 0, exit_attributable: false });
        expect(nativeVerificationRecord(event({ ...piped, stdout: "3\n" })))
            .toMatchObject({ outcome: "unknown", basis: "exit-status-not-attributable", exit_code: 0, exit_attributable: false });
        expect(nativeVerificationRecord(event({ tool_input: { command: "npm test; echo done" }, tool_outcome: "success" })))
            .toMatchObject({ outcome: "unknown", basis: "exit-status-not-attributable", exit_code: null });
        expect(nativeVerificationRecord(event({ tool_input: { command: "npx tsc --noEmit | tail -3" }, tool_outcome: "success" })))
            .toMatchObject({ kind: "typecheck", outcome: "unknown", basis: "exit-status-not-attributable" });
    });
    // `vitest … | grep -c FAIL` exits 1 when grep finds nothing, i.e. when the tests PASS.
    it("does not record a fail from a hidden non-zero exit status either", () => {
        const piped = { tool_input: { command: "npx vitest run src/a.test.ts | grep -c FAIL" }, hook_event: "PostToolUseFailure", tool_outcome: "error" as const, exit_code: 1 };
        expect(nativeVerificationRecord(event({ ...piped, stderr: "Exit code 1\n0" })))
            .toMatchObject({ outcome: "unknown", basis: "exit-status-not-attributable", exit_code: 1, exit_attributable: false });
    });
    it("keeps the shell exit status as the verdict when it belongs to the runner", () => {
        const green = " Test Files  1 passed (1)\n      Tests  7 passed (7)\n";
        expect(nativeVerificationRecord(event({ tool_input: { command: "npx vitest run --coverage" }, exit_code: 1, stdout: green })))
            .toMatchObject({ outcome: "fail", basis: "exit-code", exit_code: 1, exit_attributable: true });
        expect(nativeVerificationRecord(event({ tool_input: { command: "set -o pipefail; npx vitest run | tail -5" }, exit_code: 0 })))
            .toMatchObject({ outcome: "pass", basis: "exit-code", exit_attributable: true });
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
