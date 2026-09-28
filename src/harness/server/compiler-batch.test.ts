import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeServerRules, makeServerRuntime } from "./__tests__/fixtures.js";
import { makeEvent, makeSession } from "../__tests__/fixtures/evaluator.js";
import { queueBatchCompiler, runCompilerBoundary } from "./compiler-batch.js";
import { runCommandCheck } from "../quality-checks/tool-command-check.js";
import type { HarnessEvent } from "../types.js";

vi.mock("../quality-checks/tool-command-check.js", () => ({ runCommandCheck: vi.fn(async () => []) }));
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
    const cwd = mkdtempSync(join(tmpdir(), "compiler-batch-"));
    roots.push(cwd);
    const rules = makeServerRules({ quality_checks: { typescript: { enabled: true, command: "tsc --noEmit", severity: "error" } } });
    const ctx = makeServerRuntime({ cwd, rules });
    const event = makeEvent({ cwd, hook_event: "PostToolUse", write_attribution: "declared-target", tool_use_id: "first", tool_name: "Edit" });
    const file = join(cwd, "a.ts");
    return { ctx, event, file, session: makeSession() };
}

it("keeps per-edit checking until this Claude session demonstrates a native batch boundary", async () => {
    const { ctx, event, file, session } = fixture();
    expect(queueBatchCompiler(ctx, event, file)).toBe(false);
    await runCompilerBoundary(ctx, { ...event, hook_event: "PostToolBatch" }, session);
    expect(queueBatchCompiler(ctx, { ...event, agent_source: "codex" }, file)).toBe(false);
    expect(queueBatchCompiler(ctx, { ...event, session_id: "other" }, file)).toBe(false);
    expect(queueBatchCompiler(ctx, { ...event, write_attribution: "observed-workspace" }, file)).toBe(false);
    expect(queueBatchCompiler(ctx, event, file)).toBe(true);
});

it("coalesces four related edits into one compiler run after the final edit", async () => {
    const { ctx, event, file, session } = fixture();
    await runCompilerBoundary(ctx, { ...event, hook_event: "PostToolBatch" }, session);
    for (const id of ["options", "use-targetOf", "define-targetOf", "import-type"]) {
        expect(queueBatchCompiler(ctx, { ...event, tool_use_id: id }, file)).toBe(true);
    }
    expect(runCommandCheck).not.toHaveBeenCalled();
    const result = await runCompilerBoundary(ctx, { ...event, hook_event: "PostToolBatch" }, session);
    expect(runCommandCheck).toHaveBeenCalledTimes(1);
    expect(result?.decision).toBe("allow");
    expect(result?.checks_ran).toEqual(["typescript"]);
});

it("delivers final errors as batch context so Claude can repair them, and blocks Stop until repaired", async () => {
    const { ctx, event, file, session } = fixture();
    await runCompilerBoundary(ctx, { ...event, hook_event: "PostToolBatch" }, session);
    queueBatchCompiler(ctx, event, file);
    vi.mocked(runCommandCheck).mockResolvedValueOnce([{ name: "typescript", severity: "error", file,
        message: "typescript found newly observed issues", detail: "a.ts(3): TS2304: Cannot find name 'targetOf'." }]);
    const result = await runCompilerBoundary(ctx, { ...event, hook_event: "PostToolBatch" }, session);
    expect(result?.decision).toBe("allow");
    expect(result?.additional_context).toContain("targetOf");
    // A previous diagnostic must not become forgiven merely because the delta calls it pre-existing.
    vi.mocked(runCommandCheck).mockResolvedValueOnce([{ name: "typescript", severity: "warning", file,
        message: "pre-existing", novelty: "pre-existing", detail: "a.ts(4): TS2304: Cannot find name 'targetOf'." }]);
    const stop = await runCompilerBoundary(ctx, { ...event, hook_event: "Stop" }, session);
    expect(stop?.decision).toBe("block");
    expect((await runCompilerBoundary(ctx, { ...event, hook_event: "Stop" }, session))?.decision).toBe("allow");
});

it("recovers pending work after a daemon restart at Stop and before a commit", async () => {
    const { ctx, event, file, session } = fixture();
    await runCompilerBoundary(ctx, { ...event, hook_event: "PostToolBatch" }, session);
    queueBatchCompiler(ctx, event, file);
    const restarted = makeServerRuntime({ cwd: ctx.cwd, rules: ctx.rules });
    const commit: HarnessEvent = { ...event, hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m fix" } };
    await runCompilerBoundary(restarted, commit, session);
    expect(runCommandCheck).toHaveBeenCalledTimes(1);
    expect(queueBatchCompiler(restarted, event, file)).toBe(false);
});

it("completes a batch whose only finding is NOT APPLICABLE (a project without tsconfig): Stop is allowed, the warning stays visible, and typescript is recorded as SKIPPED — never as executed", async () => {
    const { ctx, event, file, session } = fixture();
    await runCompilerBoundary(ctx, { ...event, hook_event: "PostToolBatch" }, session);
    queueBatchCompiler(ctx, event, file);
    vi.mocked(runCommandCheck).mockResolvedValueOnce([{ name: "external_check_not_applicable", severity: "warning", file,
        message: "typescript does not apply", detail: "NOT APPLICABLE (not a deferral): no config file found (tsconfig.json)" }]);
    const stop = await runCompilerBoundary(ctx, { ...event, hook_event: "Stop" }, session);
    expect(stop?.decision).toBe("allow");
    expect(stop?.checks_ran).toBeUndefined(); // no compiler ran: the evidence must not say completed_no_reported_findings
    expect(stop?.checks_skipped).toEqual([{ check: "typescript", category: "config_disabled", reason: "not applicable: NOT APPLICABLE (not a deferral): no config file found (tsconfig.json)" }]);
    expect(stop?.check_results?.some(row => row.name === "external_check_not_applicable")).toBe(true);
    expect(await runCompilerBoundary(ctx, { ...event, hook_event: "Stop" }, session)).toBeNull(); // nothing left pending
});
it("retains unavailable checks without claiming a pass or allowing completion", async () => {
    const { ctx, event, file, session } = fixture();
    await runCompilerBoundary(ctx, { ...event, hook_event: "PostToolBatch" }, session);
    queueBatchCompiler(ctx, event, file);
    vi.mocked(runCommandCheck).mockResolvedValueOnce([{ name: "external_check_deferred", severity: "warning", file,
        message: "External check deferred (typescript)", detail: "compiler unavailable" }]);
    const stop = await runCompilerBoundary(ctx, { ...event, hook_event: "Stop" }, session);
    expect(stop?.decision).toBe("block");
    expect(stop?.checks_ran ?? []).toEqual([]);
});
