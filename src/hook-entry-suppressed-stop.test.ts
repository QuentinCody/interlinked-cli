import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runHookEntry } from "./hook-entry.js";

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hook-suppressed-"));
    mkdirSync(join(root, ".interlinked"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each(["Stop", "SubagentStop"])("records %s reentry suppression without contacting an unavailable daemon", async (nativeEventName) => {
    const socketPath = join(root, ".interlinked", "absent.sock");
    const result = await runHookEntry({
        nativeEventName,
        nativeJson: { cwd: root, session_id: "suppressed-session", stop_hook_active: true },
        runner: "claude-code",
        cwd: root,
        socketPath,
        env: { INTERLINKED_NO_SELF_HEAL: "1" },
    });
    expect(result).toEqual({ exit_code: 0, fell_back: false });
    const receipts = readFileSync(join(root, ".interlinked", "hook-transport.jsonl"), "utf8").trim().split("\n");
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0] ?? "")).toMatchObject({
        session_id: "suppressed-session", native_event: nativeEventName, outcome: "suppressed", socket_path: socketPath, hook_pid: process.pid,
    });
});
