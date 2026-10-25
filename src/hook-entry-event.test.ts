import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// 2026-10-22: the payload census wrote `<cwd>/.interlinked/payload-keys.json` for whatever folder the session had
// `cd`-ed into; the new folder then became that subtree's "project" and every hook call below it skipped the daemon.
it("records an unconsumed payload key under the project root, never in the session's subfolder or an unguarded folder", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-entry-event-"));
    roots.push(root);
    mkdirSync(join(root, ".interlinked"));
    writeFileSync(join(root, ".interlinked", "config.json"), "{}");
    const sub = join(root, "scratch", "probe");
    mkdirSync(sub, { recursive: true });
    const adapter = resolveHookAdapter({ runner: "codex", env: {} });
    if (!adapter) throw new Error("Codex adapter missing");
    const payload = { session_id: "test", tool_name: "Read", tool_input: {}, brand_new_runner_field: 1 };
    buildUnifiedHookEvent(adapter, { ...payload, cwd: sub }, "PreToolUse");
    expect(existsSync(join(sub, ".interlinked"))).toBe(false);
    expect(readFileSync(join(root, ".interlinked", "payload-keys.json"), "utf8")).toContain("brand_new_runner_field");
    const unguarded = mkdtempSync(join(tmpdir(), "hook-entry-unguarded-"));
    roots.push(unguarded);
    buildUnifiedHookEvent(adapter, { ...payload, cwd: unguarded }, "PreToolUse");
    expect(existsSync(join(unguarded, ".interlinked"))).toBe(false);
});
