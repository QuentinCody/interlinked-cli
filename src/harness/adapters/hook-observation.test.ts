import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./claude-code.js";
import { createCodexAdapter } from "./codex.js";

describe("normalized hook observations", () => {
    it("keeps a filesystem notification separate from a tool write and its writer unknown", () => {
        const event = createClaudeCodeAdapter().parseHookInput({ file_path: "/repo/package.json", event: "change", session_id: "observer" }, "FileChanged");
        expect(event.phase).toBe("file-change");
        expect(event.action.kind).toBe("other");
        expect(event.observation).toEqual({ kind: "filesystem", path: "/repo/package.json", operation: "change", writer: "unknown", timing: "after" });
        expect(event.tool_use_id).toBeUndefined();
    });

    it("does not invent filesystem support for an unrecognized provider event", () => {
        const event = createCodexAdapter().parseHookInput({ file_path: "/repo/package.json", event: "change" }, "FileChanged");
        expect(event.phase).toBe("other");
        expect(event.observation).toBeUndefined();
    });

    it("preserves native batch call identities without manufacturing a turn or execution proof", () => {
        const event = createClaudeCodeAdapter().parseHookInput({ tool_calls: [{ tool_use_id: "a", tool_name: "Read", tool_response: "1 text" }, { tool_name: "Write" }] }, "PostToolBatch");
        expect(event.observation).toEqual({ kind: "tool_batch", boundary: "before_model", calls: [{ tool_use_id: "a", tool_name: "Read" }, { tool_name: "Write" }] });
        expect(event.turn_id).toBeUndefined();
        expect(event.outcome).toBeUndefined();
    });
});
