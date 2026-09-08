import { nonNull } from "../../lib/non-null.js";
import { describe, expect, it } from "vitest";
import { createCursorAdapter } from "./cursor.js";

const adapter = createCursorAdapter();

describe("Cursor mutation contracts", () => {
    // test-contract: user-scoped installation uses the documented home hooks path.
    it("renders the user hooks path", () => {
        expect(adapter.renderSettingsFragment("/bin/hook", "user").path).toBe("~/.cursor/hooks.json");
    });

    // test-contract: a gated allow with no warning emits only the permission payload.
    it("omits stderr when gated allow has no warnings", () => {
        const event = adapter.parseHookInput({}, "beforeShellExecution");
        const output = adapter.encodeDecision({ decision: "allow" }, event);
        expect(output.stderr).toBeUndefined();
        expect(JSON.parse(nonNull(output.stdout))).toEqual({ permission: "allow" });
    });

    // test-contract: warnings remain observable on gated allow output.
    it("preserves warnings on gated allow", () => {
        const event = adapter.parseHookInput({}, "beforeShellExecution");
        const output = adapter.encodeDecision({ decision: "allow", warnings: ["warning"] }, event);
        expect(output.stderr).toBe("warning");
        expect(JSON.parse(nonNull(output.stdout))).toEqual({ permission: "allow" });
    });

    // test-contract: allow advisory text is exposed as agent_message on gated events.
    it("adds additional context to a gated allow", () => {
        const event = adapter.parseHookInput({}, "preToolUse");
        const output = adapter.encodeDecision({ decision: "allow", additional_context: "note" }, event);
        expect(JSON.parse(nonNull(output.stdout))).toEqual({
            permission: "allow",
            agent_message: "note",
        });
    });

    // test-contract: non-gated allow does not produce stdout JSON.
    it("uses stderr-only output for non-gated allow", () => {
        const event = adapter.parseHookInput({}, "afterFileEdit");
        const output = adapter.encodeDecision({ decision: "allow" }, event);
        expect(output.stdout).toBeUndefined();
        expect(output.stderr).toBeUndefined();
    });

    // test-contract: non-gated allow preserves warnings in stderr.
    it("preserves warnings for non-gated allow", () => {
        const event = adapter.parseHookInput({}, "afterFileEdit");
        const output = adapter.encodeDecision({ decision: "allow", warnings: ["notice"] }, event);
        expect(output.stdout).toBeUndefined();
        expect(output.stderr).toBe("notice");
    });

    // test-contract: arrays are rejected as hook objects and do not become raw event payloads.
    it("treats an array payload as empty", () => {
        const event = adapter.parseHookInput([], "sessionStart");
        expect(event.raw).toEqual({});
        expect(event.session_id).toBe("unknown");
    });

    // test-contract: non-string session and cwd fields use their documented fallbacks.
    it("rejects non-string identity fields", () => {
        const event = adapter.parseHookInput({ session_id: 7, cwd: 9 }, "sessionStart");
        expect(event.session_id).toBe("unknown");
        expect(event.context.cwd).toBe(process.cwd());
    });

    // test-contract: JSON output omits stderr when warnings are absent.
    it("omits stderr on a block response without warnings", () => {
        const event = adapter.parseHookInput({}, "beforeShellExecution");
        const output = adapter.encodeDecision({ decision: "block", reason: "blocked" }, event);
        expect(output.stderr).toBeUndefined();
        expect(JSON.parse(nonNull(output.stdout))).toEqual({
            permission: "deny",
            agent_message: "blocked",
            user_message: "blocked",
        });
    });
});
