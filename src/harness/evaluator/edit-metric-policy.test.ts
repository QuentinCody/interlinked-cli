import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyEditMetricPolicy } from "./edit-metric-policy.js";
import { evaluatePreChecksTail, evaluatePreChecksSelfKillEnv } from "./pre-tool-phases.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(mode?: string): string {
    const root = mkdtempSync(join(tmpdir(), "edit-metric-policy-"));
    roots.push(root);
    if (mode) {
        mkdirSync(join(root, ".interlinked"));
        writeFileSync(join(root, ".interlinked/config.json"), JSON.stringify({ version: 1, harness: { edit_metrics: { mode } } }));
    }
    return root;
}

it("treats a threshold crossing as advice without mutating the original measurement", () => {
    const measured: HarnessDecision = { decision: "block", reason: "BLOCKED: complexity\n  • f: CC17 > 16", rule_id: "cyclomatic-cap" };
    const warnings: string[] = [];
    expect(applyEditMetricPolicy(measured, project(), warnings)).toBeNull();
    expect(warnings[0]).toContain("Advisory");
    expect(warnings[0]).toContain("CC17 > 16");
    expect(warnings[0]).not.toContain("BLOCKED");
    expect(measured.decision).toBe("block");
    expect(applyEditMetricPolicy(measured, project("enforced"), [])).toBe(measured);
    expect(applyEditMetricPolicy(measured, project("invalid"), [])).toBe(measured);
});

it("allows an ordinary complex edit, preserves explicit enforcement, and leaves security blocking", () => {
    const content = `function validate(x: number) { ${Array.from({ length: 30 }, (_, n) => `if (x === ${n}) return ${n};`).join(" ")} return -1; }`;
    for (const mode of [undefined, "advisory", "enforced"]) {
        const cwd = project(mode);
        const event: HarnessEvent = { hook_event: "PreToolUse", session_id: "policy", agent_source: "codex", timestamp: "2026-10-06T00:00:00Z", cwd, tool_name: "Write" };
        const warnings: string[] = [];
        const result = evaluatePreChecksTail(event, undefined, undefined, "Write", { file_path: join(cwd, "a.ts"), content }, warnings);
        expect(result?.decision ?? "allow").toBe(mode === "enforced" ? "block" : "allow");
        if (mode !== "enforced") expect(warnings.join("\n")).toContain("edit-metrics");
        const security = evaluatePreChecksSelfKillEnv(event, "Bash", { command: `kill ${process.pid}` }, []);
        expect(security?.decision).toBe("block");
        expect(security?.rule_id).toBe("self-kill-protection");
    }
});
