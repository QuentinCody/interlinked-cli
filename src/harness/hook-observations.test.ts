import { afterEach, expect, it, vi } from "vitest";
import { recordHookObservations } from "./hook-observations.js";
import { appendCapturedData } from "../lib/data/capture.js";
import type { HarnessEvent } from "./types.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../lib/data/capture.js", () => ({ appendCapturedData: vi.fn(() => true) }));
afterEach(() => vi.clearAllMocks());
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const event: HarnessEvent = {
    hook_event: "PreToolUse", session_id: "session", tool_use_id: "call", agent_source: "claude",
    cwd: "/repo", timestamp: "2026-09-25T00:00:00Z",
};

it("retains scheduled work without asserting a pass or model delivery", () => {
    recordHookObservations(event, [{ kind: "scheduled", check: "typescript", file: "a.ts", message: "after write" }]);
    expect(appendCapturedData).toHaveBeenCalledWith(
        { cwd: "/repo", producer: "harness/hook-observations", session: "session" }, "check-executions",
        [{ schema: "hook-observation.v1", ts: event.timestamp, session_id: "session", tool_use_id: "call",
            hook_event: "PreToolUse", kind: "scheduled", check: "typescript", file: "a.ts", message: "after write", delivered: false }],
    );
});

it("does not record a dry-run or empty observation", () => {
    recordHookObservations({ ...event, dry_run: true }, [{ kind: "metric", check: "size", message: "1" }]);
    recordHookObservations(event, []);
    expect(appendCapturedData).not.toHaveBeenCalled();
});

it("writes actual observation evidence only under an explicitly isolated project", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hook-observation-"));
    roots.push(cwd);
    const actual = await vi.importActual<typeof import("../lib/data/capture.js")>("../lib/data/capture.js");
    vi.mocked(appendCapturedData).mockImplementationOnce(actual.appendCapturedData);
    recordHookObservations({ ...event, cwd }, [{ kind: "advisory", check: "hook-coverage", message: "pending", delivered: true }]);
    const row = JSON.parse(readFileSync(join(cwd, ".interlinked/check-executions.jsonl"), "utf8").trim());
    expect(row).toMatchObject({ session_id: "session", tool_use_id: "call", delivered: true, message: "pending" });
});
