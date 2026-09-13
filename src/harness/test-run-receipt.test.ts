import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readTestReceipt, writeTestReceipt, type TestExecution } from "./test-run-receipt.js";

it("accepts only a completed passing receipt for the exact key", () => {
    const root = mkdtempSync(join(tmpdir(), "test-receipt-"));
    const plan: TestExecution["plan"] = { version: 1, snapshot: "s", changedPaths: [], mode: "selected", tests: [], omitted: [], reasons: [], estimatedSerialMs: 0, reusable: true };
    try {
        writeTestReceipt(root, "abc", { plan, status: "passed", runId: "run", reused: false, durationMs: 12, reason: "", output: "" });
        expect(readTestReceipt(root, "abc")).toEqual({ key: "abc", runId: "run", durationMs: 12 });
        expect(readTestReceipt(root, "different")).toBeNull();
        writeFileSync(join(root, ".interlinked/test-runs/abc.json"), '{"version":1,"key":"abc","status":"failed","runId":"run","durationMs":12}');
        expect(readTestReceipt(root, "abc")).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
});
