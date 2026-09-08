import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { installHooks, readManifest, manifestPath, uninstallHooks } from "../installer.js";
import { toLegacyHarnessEvent } from "../legacy-client.js";
import { createAdditionalClientAdapter } from "./additional-clients.js";
import { buildHookCommand } from "./hook-command.js";

const ids = ["factory-droid", "windsurf", "antigravity", "crush"] as const;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string { const root = mkdtempSync(join(tmpdir(), "extra-hooks-")); roots.push(root); return root; }

describe("documented experimental client contracts", () => {
    it("does not reinterpret Antigravity positional edits as a global string replacement", () => {
        const adapter = createAdditionalClientAdapter("antigravity");
        const event = adapter.parseHookInput({ conversationId: "s", workspacePaths: ["/repo"], toolCall: { name: "replace_file_content", args: { TargetFile: "/repo/a.ts", StartLine: 8, EndLine: 8, TargetContent: "before", ReplacementContent: "after" } } }, "PreToolUse");
        expect(toLegacyHarnessEvent(event).tool_name).toBe("replace_file_content");
        expect(adapter.encodeDecision({ decision: "allow" }, event).stderr).toContain("NOT MEASURED");
    });
    it.each(ids)("installs and removes %s without deleting user settings", id => {
        const root = fixture();
        const adapter = createAdditionalClientAdapter(id);
        const settings = join(root, adapter.capabilities.project_hook_path);
        mkdirSync(dirname(settings), { recursive: true });
        writeFileSync(settings, JSON.stringify({ userMarker: "preserve" }));
        const result = installHooks({ cwd: root, binaryPath: "/usr/local/lib/interlinked/hook-entry.js", runners: [id], scope: "project" });
        expect(result.entries).toHaveLength(1);
        expect(readManifest(manifestPath(root))[0]?.runner).toBe(id);
        expect(uninstallHooks({ cwd: root, runners: [id] }).remaining).toEqual([]);
        expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ userMarker: "preserve" });
        expect(adapter.detectFromEnv({})).toBe(false);
    });
    it.each([
        ["factory-droid", "PreToolUse", { session_id: "s", cwd: "/repo", tool_name: "Execute", tool_input: { command: "echo safe" } }],
        ["windsurf", "pre_run_command", { trajectory_id: "s", execution_id: "turn", tool_info: { command_line: "echo safe", cwd: "/repo" } }],
        ["antigravity", "PreToolUse", { conversationId: "s", workspacePaths: ["/repo"], toolCall: { name: "run_command", args: { CommandLine: "echo safe", Cwd: "/repo" } } }],
        ["crush", "PreToolUse", { session_id: "s", cwd: "/repo", tool_name: "bash", tool_input: { command: "echo safe" } }],
    ] as const)("normalizes %s shell inputs without changing provider identity", (id, name, raw) => {
        const event = createAdditionalClientAdapter(id).parseHookInput(raw, name);
        expect(event.raw).toEqual(raw);
        expect(toLegacyHarnessEvent(event)).toMatchObject({ agent_source: id, session_id: "s", tool_name: "Bash", tool_input: expect.objectContaining({ command: "echo safe" }) });
    });
    it("uses force_ask for Antigravity and leaves completed tool results alone", () => {
        const adapter = createAdditionalClientAdapter("antigravity");
        const pre = adapter.parseHookInput({}, "PreToolUse");
        expect(JSON.parse(adapter.encodeDecision({ decision: "ask", reason: "review" }, pre).stdout ?? "")).toEqual({ decision: "force_ask", reason: "review" });
        const post = adapter.parseHookInput({}, "PostToolUse");
        expect(JSON.parse(adapter.encodeDecision({ decision: "block", reason: "already ran" }, post).stdout ?? "")).toEqual({});
    });
    it("executes a missing-runtime fallback with Antigravity's native deny JSON", () => {
        const root = fixture();
        const command = buildHookCommand(join(root, "missing.js"), "antigravity", "PreToolUse", "fail_closed");
        const result = spawnSync("sh", ["-c", command], { cwd: root, input: "{}", encoding: "utf8", timeout: 5000 });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ decision: "deny" });
    });
});
