import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeHookTransportReceipt, type HookTransportReceipt } from "./hook-transport-receipt.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string {
    const root = mkdtempSync(join(tmpdir(), "il-receipt-"));
    roots.push(root);
    return root;
}
const receipt: HookTransportReceipt = {
    schema: 1, event_id: "event-1", session_id: "session-1", native_event: "PreToolUse",
    hook_pid: 123, socket_path: "/fixture/.interlinked/harness.sock", protocol: "raw", outcome: "daemon",
};

describe("hook transport evidence", () => {
    it("appends distinct outcomes without replacing previous evidence", () => {
        const root = directory();
        writeHookTransportReceipt(root, receipt);
        writeHookTransportReceipt(root, { ...receipt, event_id: "event-2", outcome: "cold" });
        expect(readFileSync(join(root, "hook-transport.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)))
            .toEqual([receipt, { ...receipt, event_id: "event-2", outcome: "cold" }]);
    });
    it("does not throw when diagnostics cannot be written", () => {
        const file = join(directory(), "not-a-directory");
        writeFileSync(file, "occupied");
        expect(() => writeHookTransportReceipt(file, receipt)).not.toThrow();
        expect(() => writeHookTransportReceipt(null, receipt)).not.toThrow();
        expect(readFileSync(file, "utf8")).toBe("occupied");
    });
});
