import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeServerRuntime, makeServerRules } from "./__tests__/fixtures.js";
import { prepareSourceChecks } from "./post-tool-source-scope.js";
import { createChangeSetExternalBatch } from "../quality-checks/change-set-external.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

vi.mock("../quality-checks/change-set-external.js", () => ({ createChangeSetExternalBatch: vi.fn() }));
vi.mock("../../lib/data/capture.js", () => ({ appendCapturedData: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

it("removes an install population before source batching and retains security findings", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-pipeline-")); roots.push(root);
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, ".venv"));
    writeFileSync(join(root, ".venv/pyvenv.cfg"), "home = /usr/bin");
    const dependencies = Array.from({ length: 40 }, (_, index) => `.venv/pkg${index}.py`);
    for (const path of dependencies) writeFileSync(join(root, path), "pass\n");
    const resultsForFile = vi.fn(async () => [{ name: "gitleaks", file: "dependency.py", severity: "error" as const, message: "secret detected" }]);
    vi.mocked(createChangeSetExternalBatch).mockReturnValue({ resultsForFile, evidenceForFile: vi.fn(async () => ({ checks: ["gitleaks"], scopes: [], unavailable: [] })) });
    const ctx = makeServerRuntime({ cwd: root, rules: makeServerRules({ quality_checks: { gitleaks: {}, dependency_audit: {}, affected_tests: {} } }) });
    const event: HarnessEvent = { hook_event: "PostToolUse", agent_source: "codex", session_id: "scope-test", timestamp: "2026-09-15T00:00:00Z", tool_name: "Bash", tool_input: { command: "pip install approved-package" } };
    const decision: HarnessDecision = { decision: "allow" };
    expect(await prepareSourceChecks(ctx, event, [...dependencies, "app.py"], decision)).toEqual(["app.py"]);
    expect(Object.keys(vi.mocked(createChangeSetExternalBatch).mock.calls[0]![0].checks)).toEqual(["gitleaks", "dependency_audit"]);
    expect(resultsForFile).toHaveBeenCalledTimes(40);
    expect(decision.warnings?.join("\n")).toContain("secret detected");
    expect(decision.decision).toBe("block");
    expect(decision.check_results?.[0]?.name).toBe("gitleaks");
});

it("prioritizes tracked work over scratch copies and records a budget gap", async () => {
    vi.mocked(createChangeSetExternalBatch).mockReturnValue({ resultsForFile: vi.fn(async () => []), evidenceForFile: vi.fn(async () => ({ checks: [], scopes: [], unavailable: [] })) });
    const root = mkdtempSync(join(tmpdir(), "source-budget-")); roots.push(root);
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "app.py"), "pass\n");
    execFileSync("git", ["add", "app.py"], { cwd: root });
    const copies = Array.from({ length: 70 }, (_, index) => `copy${index}.py`);
    for (const path of copies) writeFileSync(join(root, path), "pass\n");
    const ctx = makeServerRuntime({ cwd: root });
    const event: HarnessEvent = { hook_event: "PostToolUse", agent_source: "codex", session_id: "scope-test", timestamp: "2026-09-15T00:00:00Z", tool_name: "Bash", tool_input: { command: "generate files" } };
    const decision: HarnessDecision = { decision: "allow" };
    const paths = await prepareSourceChecks(ctx, event, [...copies, "app.py"], decision);
    expect(paths).toHaveLength(64);
    expect(paths[0]).toBe("app.py");
    expect(decision.check_results?.[0]?.name).toBe("external_check_deferred");
    expect(decision.warnings?.join(" ")).toContain("7 input(s)");
});
