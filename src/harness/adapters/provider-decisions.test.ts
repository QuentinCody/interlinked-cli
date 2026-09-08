import { describe, expect, it } from "vitest";
import { createCopilotCliAdapter } from "./copilot-cli.js";
import { createGeminiCliAdapter } from "./gemini-cli.js";

describe("provider decision contracts", () => {
    const copilot = createCopilotCliAdapter();
    const gemini = createGeminiCliAdapter();

    it("classifies Copilot object arguments and preserves its native result", () => {
        const event = copilot.parseHookInput({ toolName: "bash", toolArgs: { command: "git push" }, toolResult: { textResultForLlm: "done" } }, "postToolUse");
        expect(event.action).toMatchObject({ tool_class: "side-effect", tool_input: { command: "git push" }, tool_response: { textResultForLlm: "done" } });
    });

    it("uses Copilot permission decisions and abstains on allow", () => {
        const event = copilot.parseHookInput({}, "permissionRequest");
        const denied = copilot.encodeDecision({ decision: "block", reason: "reserved" }, event);
        expect(JSON.parse(denied.stdout!)).toEqual({ behavior: "deny", message: "reserved" });
        expect(copilot.encodeDecision({ decision: "allow" }, event).stdout).toBeUndefined();
    });

    it("reports a post-tool refusal as context without claiming to undo execution", () => {
        const event = copilot.parseHookInput({}, "postToolUse");
        const result = copilot.encodeDecision({ decision: "block", reason: "new error" }, event);
        expect(JSON.parse(result.stdout!)).toEqual({ additionalContext: "new error" });
        expect(result.translation).toMatchObject({ status: "degraded", requested: ["deny"], encoded: ["context"] });
    });

    it("does not emit a permission decision for a Copilot observer", () => {
        const result = copilot.encodeDecision({ decision: "block", reason: "notice" }, copilot.parseHookInput({}, "sessionEnd"));
        expect(result.stdout).toBeUndefined();
        expect(result.stderr).toContain("notice");
        expect(result.translation?.status).toBe("unsupported");
    });

    it("uses Gemini deny for an unsupported ask", () => {
        const result = gemini.encodeDecision({ decision: "ask", reason: "confirm" }, gemini.parseHookInput({}, "BeforeTool"));
        expect(JSON.parse(result.stdout!)).toEqual({ decision: "deny", reason: "confirm" });
        expect(result.exit_code).toBe(0);
        expect(result.translation).toMatchObject({ status: "degraded", requested: ["ask"], encoded: ["deny"] });
    });

    it("rewrites input only on the native tool gate", () => {
        const input = { command: "git status" };
        const copilotOut = copilot.encodeDecision({ decision: "allow", updated_input: input }, copilot.parseHookInput({}, "preToolUse"));
        expect(JSON.parse(copilotOut.stdout!)).toEqual({ modifiedArgs: input });
        const geminiOut = gemini.encodeDecision({ decision: "allow", updated_input: input }, gemini.parseHookInput({}, "BeforeTool"));
        expect(JSON.parse(geminiOut.stdout!)).toEqual({ hookSpecificOutput: { hookEventName: "BeforeTool", tool_input: input } });
        const observer = gemini.encodeDecision({ decision: "block", reason: "notice" }, gemini.parseHookInput({}, "SessionEnd"));
        expect(JSON.parse(observer.stdout!)).toEqual({});
        expect(observer.translation?.status).toBe("unsupported");
    });

    it("renders Gemini command hooks inside native definition groups", () => {
        const fragment = gemini.renderSettingsFragment("/bin/interlinked", "project").fragment as { hooks: Record<string, unknown> };
        expect(fragment.hooks.BeforeTool).toEqual([{ hooks: [{ type: "command", command: expect.any(String) }] }]);
    });
});
