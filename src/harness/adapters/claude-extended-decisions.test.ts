import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./claude-code.js";

const adapter = createClaudeCodeAdapter();
describe("Claude additional hook boundaries", () => {
    it("does not claim to refuse provider-managed policy application", () => {
        const event = adapter.parseHookInput({ source: "policy_settings" }, "ConfigChange");
        const result = adapter.encodeDecision({ decision: "block", reason: "changed" }, event);
        expect(result.stdout).toBeUndefined();
        expect(result.translation).toMatchObject({ status: "unsupported", encoded: [] });
    });
    it.each(["SessionStart", "CwdChanged", "FileChanged"])("returns the complete dynamic watch list at %s", name => {
        const result = adapter.encodeDecision({ decision: "allow", watch_paths: ["/repo/package.json"] }, adapter.parseHookInput({}, name));
        expect(JSON.parse(result.stdout!)).toMatchObject({ watchPaths: ["/repo/package.json"] });
    });

    it("cannot claim that a FileChanged refusal blocked the filesystem write", () => {
        const result = adapter.encodeDecision({ decision: "block", reason: "changed" }, adapter.parseHookInput({}, "FileChanged"));
        expect(result.stdout).toBeUndefined();
        expect(result.translation).toMatchObject({ status: "unsupported", requested: ["deny"], encoded: [] });
    });

    it("uses a batch-loop cancellation, not a per-tool permission denial", () => {
        const result = adapter.encodeDecision({ decision: "block", reason: "checks pending" }, adapter.parseHookInput({}, "PostToolBatch"));
        expect(JSON.parse(result.stdout!)).toEqual({ decision: "block", reason: "checks pending" });
        expect(result.translation?.encoded).toEqual(["cancel"]);
    });

    it("preserves a deterministic pre-tool input rewrite", () => {
        const result = adapter.encodeDecision({ decision: "allow", updated_input: { command: "git status" } }, adapter.parseHookInput({}, "PreToolUse"));
        expect(JSON.parse(result.stdout!)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "git status" } } });
    });
});
