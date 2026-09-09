import { describe, expect, it } from "vitest";
import { createCoworkAdapter } from "./cowork.js";
import { toLegacyHarnessEvent } from "../legacy-client.js";
import { isRpcHookEvent } from "../daemon-request-parser.js";
import { getAdapter } from "./index.js";

describe("Cowork adapter", () => {
    const adapter = createCoworkAdapter();
    const event = adapter.parseHookInput({ session_id: "native", cwd: "/workspace", tool_use_id: "c", tool_name: "Write", tool_input: { file_path: "/workspace/a", content: "test" } }, "PreToolUse");
    it("preserves Cowork identity through the native and legacy contracts", () => {
        expect(event.runner).toBe("cowork");
        expect(isRpcHookEvent(event)).toBe(true);
        expect(toLegacyHarnessEvent(event).agent_source).toBe("cowork");
        expect(getAdapter("cowork")?.id).toBe("cowork");
    });
    it("encodes the independently measured native ask control", () => {
        const result = adapter.encodeDecision({ decision: "ask", reason: "Review required" }, event);
        expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
        expect(result.translation).toMatchObject({ status: "encoded", requested: ["ask"], encoded: ["ask"] });
    });
    it("encodes a native input rewrite without granting extra permission", () => {
        const result = adapter.encodeDecision({ decision: "allow", updated_input: { file_path: "/workspace/after", content: "test" } }, event);
        const output = JSON.parse(result.stdout ?? "{}").hookSpecificOutput;
        expect(output.updatedInput.file_path).toBe("/workspace/after");
        expect(output.permissionDecision).toBeUndefined();
        expect(result.translation).toMatchObject({ status: "encoded", encoded: ["rewrite_input"] });
    });
    it("routes installation to the plugin packager", () => {
        expect(() => adapter.renderSettingsFragment("/cli", "project")).toThrow("cowork package");
    });
    it("declares and reports context translation on allowed pre-tool calls", () => {
        const result = adapter.encodeDecision({ decision: "allow", warnings: ["Host warning"], additional_context: "Host guidance" }, event);
        expect(JSON.parse(result.stdout ?? "{}")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "Host warning\nHost guidance" } });
        expect(result.translation).toEqual({ status: "encoded", requested: ["context"], encoded: ["context"] });
        expect(adapter.capabilities.events.find(row => row.name === "PreToolUse")).toMatchObject({ model_context: true, controls: expect.arrayContaining(["context"]) });
    });
});
