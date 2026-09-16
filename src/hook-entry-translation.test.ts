import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAdapter } from "./harness/adapters/index.js";
import { encodeHookResult, measureHookTranslation, recordSuppressedStop } from "./hook-entry-translation.js";
import type { RunnerId } from "./harness/unified-event.js";

describe("native control translation evidence", () => {
    it.each(["codex", "claude-code"] as const)("%s records advisory Stop without invented continuation", id => {
        const adapter = getAdapter(id)!;
        const event = adapter.parseHookInput({}, "Stop");
        const decision = { decision: "allow" as const, warnings: ["pending evidence"] };
        expect(measureHookTranslation(adapter.encodeDecision(decision, event), decision, event)).toMatchObject({ requested: ["context"], encoded: [], status: "unsupported" });
    });
    it("retains a re-entry receipt without evaluating or capturing tool contents", () => {
        const directory = mkdtempSync(join(tmpdir(), "hook-reentry-"));
        try {
            recordSuppressedStop(directory, "codex", "Stop");
            expect(JSON.parse(readFileSync(join(directory, "hook-reentry.jsonl"), "utf8"))).toMatchObject({ provider: "codex", outcome: "suppressed-reentry", daemon_evaluated: false });
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
    it.each<[RunnerId, string, string[]]>([
        ["claude-code", "PreToolUse", ["deny"]], ["claude-code", "PostToolBatch", ["cancel"]],
        ["claude-code", "ConfigChange", ["deny"]],
        ["claude-code", "FileChanged", []], ["claude-code", "PostCompact", []],
        ["copilot-cli", "postToolUse", ["context"]], ["gemini-cli", "AfterTool", ["replace_result"]],
        ["antigravity", "PostToolUse", []], ["windsurf", "post_cascade_response", []],
    ])("%s/%s reports what the native response can express", (id, name, encoded) => {
        const adapter = getAdapter(id)!;
        const event = adapter.parseHookInput({}, name);
        const decision = { decision: "block", reason: "review" } as const;
        expect(measureHookTranslation(adapter.encodeDecision(decision, event), decision, event).encoded).toEqual(encoded);
    });
    it.each(["antigravity", "windsurf"] as const)("%s refuses a required rewrite it cannot express", id => {
        const adapter = getAdapter(id)!;
        const event = adapter.parseHookInput({}, id === "windsurf" ? "pre_run_command" : "PreToolUse");
        const decision = { decision: "allow", updated_input: { command: "safe" } } as const;
        const result = adapter.encodeDecision(decision, event);
        expect(measureHookTranslation(result, decision, event)).toMatchObject({ status: "degraded", requested: ["rewrite_input"], encoded: ["deny"] });
        if (id === "windsurf") expect(result.exit_code).toBe(2);
        else expect(JSON.parse(result.stdout!)).toMatchObject({ decision: "deny" });
    });
    it("persists translation metadata without claiming native enforcement or storing tool content", () => {
        const dataDir = mkdtempSync(join(tmpdir(), "hook-translation-"));
        try {
            const adapter = getAdapter("codex")!;
            const event = adapter.parseHookInput({ tool_name: "Bash", tool_input: { command: "sensitive-fixture" } }, "PreToolUse");
            const output = encodeHookResult({ adapter, event, decision: { decision: "allow", updated_input: { command: "safe" } }, dataDir, fellBack: false });
            expect(JSON.parse(output.stdout!)).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "safe" } } });
            const text = readFileSync(join(dataDir, "hook-translations.jsonl"), "utf8");
            expect(JSON.parse(text)).toMatchObject({ enforcement: "unmeasured", translation: { status: "encoded", encoded: ["rewrite_input"] } });
            expect(text).not.toContain("sensitive-fixture");
        } finally { rmSync(dataDir, { recursive: true, force: true }); }
    });
});
