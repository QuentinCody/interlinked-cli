import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./hook-entry-transport.js", () => ({ discoverSocket: () => null, callHookDaemon: transport.call }));

const realProcess = process;
const entry = fileURLToPath(new URL("./hook-entry.ts", import.meta.url));
let root = "";
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hook-cli-boundary-"));
    mkdirSync(join(root, ".interlinked"));
    vi.resetModules();
    transport.call.mockReset().mockResolvedValue({ ok: true, decision: { decision: "allow" } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

/** Exercise the actual bootstrap in the instrumented worker. Only process I/O
 * and daemon transport are replaced; subprocess tests retain real OS coverage. */
async function invoke(args: string[], input: string | Readable, env: NodeJS.ProcessEnv = {}) {
    const stdout = vi.fn(), stderr = vi.fn(), exit = vi.fn();
    const runtime = Object.create(realProcess);
    Object.defineProperties(runtime, {
        argv: { value: [realProcess.execPath, entry, ...args] },
        env: { value: { PATH: realProcess.env.PATH, VITEST: "true", ...env } },
        cwd: { value: () => root },
        stdin: { value: typeof input === "string" ? Readable.from([input]) : input },
        stdout: { value: { write: stdout } }, stderr: { value: { write: stderr } }, exit: { value: exit },
    });
    vi.stubGlobal("process", runtime);
    await import("./hook-entry.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    return { stdout, stderr, exit };
}

describe("hook CLI process boundary", () => {
    it("uses explicit flags ahead of environment values and emits the native daemon decision", async () => {
        transport.call.mockResolvedValue({ ok: true, decision: { decision: "block", reason: "protected target" } });
        const result = await invoke(["--runner", "claude-code", "--event", "PreToolUse", "--socket", join(root, ".interlinked", "harness.sock")],
            JSON.stringify({ cwd: root, session_id: "cli", tool_name: "Read", tool_input: {} }), { INTERLINKED_RUNNER: "unknown", INTERLINKED_EVENT: "Stop" });
        expect(JSON.parse(result.stdout.mock.calls[0]?.[0]).hookSpecificOutput.permissionDecision).toBe("deny");
        expect(result.exit).toHaveBeenCalledWith(0);
        expect(transport.call.mock.calls[0]?.[0].method).toBe("hook.pre_tool_use");
    });

    it("supports equals flags and emits no output for an ordinary allow", async () => {
        const result = await invoke(["--runner=claude-code", "--event=PreToolUse", `--socket=${join(root, ".interlinked", "harness.sock")}`], "{}");
        expect(result.exit).toHaveBeenCalledWith(0);
        expect(result.stdout).not.toHaveBeenCalled();
        expect(result.stderr).not.toHaveBeenCalled();
    });

    it.each(["", "{invalid"])("tolerates absent or malformed input with environment defaults: %j", async input => {
        const result = await invoke([], input, { INTERLINKED_RUNNER: "claude-code", INTERLINKED_SOCKET: join(root, ".interlinked", "harness.sock") });
        expect(result.exit).toHaveBeenCalledWith(0);
        expect(transport.call.mock.calls[0]?.[0].event.phase).toBe("pre-tool");
    });

    it("finishes after a stdin read error instead of leaving the runner waiting", async () => {
        const input = new Readable({ read() { this.destroy(new Error("stdin unavailable")); } });
        const result = await invoke([], input);
        expect(result.stderr.mock.calls.flat().join(" ")).toContain("no runner detected");
        expect(result.exit).toHaveBeenCalledWith(0);
    });

    it.each([new Error("transport failed"), "transport failed"])("reports unexpected runtime failures and exits nonzero", async error => {
        transport.call.mockRejectedValue(error);
        const result = await invoke(["--runner=claude-code", `--socket=${join(root, ".interlinked", "harness.sock")}`], "{}");
        expect(result.exit).toHaveBeenCalledWith(1);
        expect(result.stderr.mock.calls.flat().join(" ")).toContain("hook runtime failed: transport failed");
    });

    it.each([undefined, "/missing-hook-cli-review-entry"])("is safe to import when argv does not identify an existing executable: %s", async invoked => {
        const runtime = Object.create(realProcess), exit = vi.fn();
        Object.defineProperties(runtime, { argv: { value: invoked ? [realProcess.execPath, invoked] : [realProcess.execPath] }, exit: { value: exit } });
        vi.stubGlobal("process", runtime);
        const entryModule = await import("./hook-entry.js");
        expect(typeof entryModule.runHookEntry).toBe("function");
        expect(exit).not.toHaveBeenCalled();
        expect(transport.call).not.toHaveBeenCalled();
    });
});
