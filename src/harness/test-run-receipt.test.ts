import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readTestReceipt, writeTestReceipt, type TestExecution } from "./test-run-receipt.js";

it("accepts only a completed passing receipt for the exact key", () => {
    const root = mkdtempSync(join(tmpdir(), "test-receipt-"));
    const plan: TestExecution["plan"] = { version: 1, snapshot: "s", changedPaths: [], mode: "selected", tests: [], omitted: [], reasons: [], estimatedSerialMs: 0, reusable: true };
    const details = { identity: "abc", platform: "darwin-arm64-25.0.0", toolchain: { node: "22.22.0", vitest: "4.1.11", typescript: null }, stages: { exec_ms: 10, post_ms: 2 } };
    try {
        writeTestReceipt(root, "abc", { plan, status: "passed", runId: "run", reused: false, durationMs: 12, reason: "", output: "" }, details);
        expect(readTestReceipt(root, "abc")).toEqual({ key: "abc", runId: "run", durationMs: 12, ...details });
        expect(readTestReceipt(root, "different")).toBeNull();
        writeFileSync(join(root, ".interlinked/test-runs/abc.json"), JSON.stringify({ version: 2, key: "abc", status: "failed", runId: "run", durationMs: 12, ...details }));
        expect(readTestReceipt(root, "abc")).toBeNull();
        // test-contract: invariant — reusable artifacts retain their producing checkout without relying on an optional scope reporter; legacy artifacts without that root cannot be relocated safely.
        const artifacts = { coverage_summary: { path: "run/coverage/coverage-summary.json", sha256: "a".repeat(64) } };
        const artifactReceipt = { version: 2, key: "abc", status: "passed", runId: "run", durationMs: 12, ...details, artifacts };
        writeFileSync(join(root, ".interlinked/test-runs/abc.json"), JSON.stringify(artifactReceipt));
        expect(readTestReceipt(root, "abc")).toBeNull();
        writeFileSync(join(root, ".interlinked/test-runs/abc.json"), JSON.stringify({ ...artifactReceipt, artifactRoot: root }));
        expect(readTestReceipt(root, "abc")).toMatchObject({ artifacts, artifactRoot: root });
        // test-contract: invariant — a v1 receipt (no identity, platform, toolchain or stages) is no receipt under v2
        writeFileSync(join(root, ".interlinked/test-runs/abc.json"), '{"version":1,"key":"abc","status":"passed","runId":"run","durationMs":12}');
        expect(readTestReceipt(root, "abc")).toBeNull();
        // test-contract: invariant — a v2 receipt with a malformed toolchain or stages block is rejected, not partially trusted
        writeFileSync(join(root, ".interlinked/test-runs/abc.json"), JSON.stringify({ version: 2, key: "abc", status: "passed", runId: "run", durationMs: 12, ...details, toolchain: { node: 22 } }));
        expect(readTestReceipt(root, "abc")).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
});
