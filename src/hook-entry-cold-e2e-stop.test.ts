// Unit F6: with the daemon unreachable, a Stop in a repository that declares a
// project e2e policy says the obligations were NOT CHECKED — silence is never
// a pass. No policy ⇒ no line; a tool call (not Stop) ⇒ no line.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCompilerBatch } from "./harness/server/compiler-batch-store.js";

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./hook-entry-transport.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("./hook-entry-transport.js")>(), discoverSocket: () => null, callHookDaemon: transport.call,
}));

let root = "";
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hook-cold-e2e-stop-"));
    mkdirSync(join(root, ".interlinked"));
    vi.resetModules();
    transport.call.mockReset().mockResolvedValue({ ok: false, error: "daemon unreachable" });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

async function stopWithColdDaemon(nativeEventName: string, nativeJson: Record<string, unknown>) {
    const { runHookEntry } = await import("./hook-entry.js");
    return runHookEntry({ runner: "claude-code", nativeEventName, nativeJson, socketPath: join(root, ".interlinked", "missing.sock"), env: { PATH: process.env.PATH ?? "", VITEST: "true" }, cwd: root });
}

describe("cold Stop — positive", () => {
    it("enforces guard reconciliation during a real cold edit", async () => {
        writeFileSync(join(root, "a.ts"), "function f(){if(ready)return result;}");
        const result = await stopWithColdDaemon("PreToolUse", { cwd: root, session_id: "s1", tool_name: "Write",
            tool_input: { file_path: join(root, "a.ts"), content: "function f(){if(ready)log();return result;}" } });
        expect(result.stdout).toContain('"permissionDecision":"deny"');
        expect(result.stdout).toContain("guard");
    });
    it("provides an actionable fallback if a prediction refusal has no detail", async () => {
        const gates = await import("./hook-entry-cold-gates.js");
        vi.spyOn(gates, "coldGuardPredictionDecision").mockReturnValue({ decision: "block" });
        const result = await stopWithColdDaemon("PreToolUse", { cwd: root, session_id: "s1", tool_name: "Read", tool_input: { file_path: join(root, "a.ts") } });
        expect(result.stdout).toContain("Guard reconciliation required");
    });
    it("refuses completion when durable compiler evidence is corrupt", async () => {
        writeCompilerBatch(root, { hook_event: "PostToolUse", agent_source: "claude", session_id: "s1", timestamp: "2026-09-25T00:00:00Z" },
            { revision: "", paths: [join(root, "a.ts")], calls: ["edit"], blocking: [] });
        const dir = join(root, ".interlinked", "compiler-batches");
        for (const name of readdirSync(dir)) writeFileSync(join(dir, name), "{");
        const result = await stopWithColdDaemon("Stop", { cwd: root, session_id: "s1" });
        expect(result.stdout).toContain('"decision":"block"');
        expect(result.stdout).toContain("pending compiler batch is unreadable");
    });
    it("retains enforcement of a pending compiler batch while the daemon is unreachable", async () => {
        writeCompilerBatch(root, { hook_event: "PostToolUse", agent_source: "claude", session_id: "s1", timestamp: "2026-09-25T00:00:00Z" },
            { revision: "", paths: [join(root, "a.ts")], calls: ["edit"], blocking: [] });
        const result = await stopWithColdDaemon("Stop", { cwd: root, session_id: "s1" });
        expect(result.stdout).toContain('"decision":"block"');
        expect(result.stdout).toContain("pending compiler batch");
        const commit = await stopWithColdDaemon("PreToolUse", { cwd: root, session_id: "s1", tool_name: "Bash", tool_input: { command: "git commit -m fix" } });
        expect(commit.stdout).toContain('"permissionDecision":"deny"');
    });
    it("P1: a policy exists and the daemon is down ⇒ the Stop reports NOT CHECKED with the check command, exit 0 (warn-only)", async () => {
        writeFileSync(join(root, ".interlinked", "e2e-policy.json"), "{}");
        const result = await stopWithColdDaemon("Stop", { cwd: root, session_id: "s1" });
        expect(result.fell_back).toBe(true);
        expect(result.stderr ?? "").toMatch(/project e2e obligations NOT CHECKED at this Stop/);
        expect(result.stderr ?? "").toMatch(/interlinked tests e2e check/);
        expect(result.exit_code).toBe(0);
    });
});
describe("cold Stop — negative", () => {
    it("N1: no policy ⇒ no e2e line", async () => {
        const result = await stopWithColdDaemon("Stop", { cwd: root, session_id: "s1" });
        expect(result.fell_back).toBe(true);
        expect(result.stderr ?? "").not.toMatch(/project e2e obligations/);
    });
    it("N2: a read tool call with the policy present ⇒ no e2e line (the notice is Stop-only)", async () => {
        writeFileSync(join(root, ".interlinked", "e2e-policy.json"), "{}");
        const result = await stopWithColdDaemon("PreToolUse", { cwd: root, session_id: "s1", tool_name: "Read", tool_input: { file_path: join(root, "a.txt") } });
        expect(result.stderr ?? "").not.toMatch(/project e2e obligations/);
    });
});
