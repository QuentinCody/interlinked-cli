import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mapCoworkFileEvent, mapCoworkPath } from "./workspace.js";
import { parseCoworkEvent } from "./native.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "cowork-mapping-")); roots.push(root);
    const hostRoot = join(root, "host"); mkdirSync(hostRoot);
    return { id: "test", hostRoot, runtimeRoot: "/native/workspace" };
}
describe("Cowork workspace boundary", () => {
    it("maps a new file without requiring it to exist", () => {
        const workspace = fixture();
        expect(mapCoworkPath(workspace, "/native/workspace/new/report.txt")).toBe(join(realpathSync(workspace.hostRoot), "new/report.txt"));
    });
    it("rejects traversal and sibling-prefix confusion", () => {
        const workspace = fixture();
        expect(() => mapCoworkPath(workspace, "/native/workspace/../secret")).toThrow("outside");
        expect(() => mapCoworkPath(workspace, "/native/workspace-other/file")).toThrow("outside");
    });
    it("rejects existing and dangling symlink escapes", () => {
        const workspace = fixture();
        symlinkSync(tmpdir(), join(workspace.hostRoot, "escape"));
        symlinkSync(join(workspace.hostRoot, "absent"), join(workspace.hostRoot, "dangling"));
        expect(() => mapCoworkPath(workspace, "/native/workspace/escape/file")).toThrow("symlink");
        expect(() => mapCoworkPath(workspace, "/native/workspace/dangling")).toThrow("symlink");
    });
    it("refuses to represent VM shell commands as host shell commands", () => {
        const event = parseCoworkEvent({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "mcp__remote-devices__device_bash", tool_input: { command: "pwd" } });
        expect(() => mapCoworkFileEvent(fixture(), event)).toThrow("explicit native");
    });
});
