import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildUnifiedHookEvent, recordAdapterExecution, resolveHookAdapter, resolveHookDataDir } from "./hook-entry-event.js";
import { readHookRuntimeReceipt } from "./lib/hook-runtime-receipt.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("records execution under the event project and leaves unconfigured directories untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-entry-event-"));
    roots.push(root);
    const adapter = resolveHookAdapter({ runner: "codex", env: {} });
    if (!adapter) throw new Error("Codex adapter missing");
    const event = buildUnifiedHookEvent(adapter, { session_id: "test", cwd: root, cli_version: "1.2.3", tool_name: "Read", tool_input: {} }, "PreToolUse");
    expect(event.capability?.runtime).toMatchObject({ provider: "codex", version: "1.2.3" });
    recordAdapterExecution(adapter, event, root);
    expect(existsSync(join(root, ".interlinked"))).toBe(false);
    expect(resolveHookDataDir(root, null)).toBeNull();
    mkdirSync(join(root, ".interlinked"));
    recordAdapterExecution(adapter, event, root);
    expect(readHookRuntimeReceipt(join(root, ".interlinked", "hook-runtime.json"))?.providers.codex?.native_event).toBe("PreToolUse");
    expect(resolveHookDataDir(root, null)).toBe(join(root, ".interlinked"));
    expect(resolveHookDataDir(root, join(root, "socket-dir", "harness.sock"))).toBe(join(root, "socket-dir"));
});
