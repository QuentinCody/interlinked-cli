import { describe, expect, it } from "vitest";
import { DEVICE_BASH, encodeCoworkVerdict, evaluateCoworkInput, parseCoworkEvent } from "./native.js";
import { DEFAULT_COWORK_POLICY, parseCoworkPolicy } from "./policy.js";

const event = (tool: string, input: Record<string, unknown>) => parseCoworkEvent({ hook_event_name: "PreToolUse", session_id: "native-session", cwd: "/workspace", tool_name: tool, tool_input: input });

describe("Cowork portable policy", () => {
    it.each(["Bash", DEVICE_BASH])("vetoes destructive commands on %s", tool => {
        const decision = evaluateCoworkInput(event(tool, { command: "rm -rf /" }), DEFAULT_COWORK_POLICY);
        expect(decision.decision).toBe("deny");
        expect(encodeCoworkVerdict("PreToolUse", decision)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    });
    it("checks target paths without treating content mentioning a denied path as a write there", () => {
        const policy = { ...DEFAULT_COWORK_POLICY, deniedPaths: ["/workspace/denied.txt"] };
        expect(evaluateCoworkInput(event("Write", { file_path: "report.txt", content: "/workspace/denied.txt" }), policy).decision).toBe("allow");
        expect(evaluateCoworkInput(event("Write", { file_path: "sub/../denied.txt", content: "test" }), policy).decision).toBe("deny");
    });
    it("does not claim unknown connector semantics are checked", () => {
        expect(evaluateCoworkInput(event("mcp__mail__send", {}), DEFAULT_COWORK_POLICY).unmeasured).toContain("tool_semantics:mcp__mail__send");
    });
    it("allows explicit policy to veto a connector", () => {
        expect(evaluateCoworkInput(event("mcp__mail__send", {}), { ...DEFAULT_COWORK_POLICY, deniedTools: ["mcp__mail__send"] }).decision).toBe("deny");
    });
    it("rejects malformed configuration and native identity", () => {
        expect(() => parseCoworkPolicy({ ...DEFAULT_COWORK_POLICY, bridge: { url: "http://example.com", tokenEnv: "TOKEN", workspace: "w" } })).toThrow("HTTPS");
        expect(() => parseCoworkPolicy({ ...DEFAULT_COWORK_POLICY, token: "secret" })).toThrow("Unknown");
        expect(() => parseCoworkEvent({ hook_event_name: "PreToolUse" })).toThrow("identity");
    });
    it("does not turn a Stop warning into a continuation loop", () => {
        expect(encodeCoworkVerdict("Stop", { decision: "observe", checks: [], unmeasured: ["tests"] })).toBeNull();
    });
    it.each(["deny", "ask"] as const)("preserves context alongside %s without applying a rewrite", decision => {
        expect(encodeCoworkVerdict("PreToolUse", { decision, checks: [], unmeasured: [], context: "Review guidance", reason: "Policy reason", updatedInput: { file_path: "/rewritten" } })).toEqual({
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: "Policy reason", additionalContext: "Review guidance" },
        });
    });
    it("preserves context alongside an input rewrite without granting permission", () => {
        expect(encodeCoworkVerdict("PreToolUse", { decision: "allow", checks: [], unmeasured: [], context: "Review guidance", updatedInput: { file_path: "/rewritten" } })).toEqual({
            hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { file_path: "/rewritten" }, additionalContext: "Review guidance" },
        });
    });
});
