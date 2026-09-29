import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./resource-memory.js", () => ({ readResourceMemory: () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }) }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), availableParallelism: () => 8, loadavg: () => [0, 0, 0] }));
vi.mock("./test-runtime.js", () => ({ captureTestRuntime: vi.fn() }));
vi.mock("./coverage-shards/discovery.js", () => ({ captureVitestEnvironment: () => ({ environment: {}, environmentHash: "env" }) }));
vi.mock("./test-run-receipt.js", async importOriginal => ({ ...await importOriginal<typeof import("./test-run-receipt.js")>(), readTestReceipt: vi.fn(), writeTestReceipt: vi.fn() }));
import { executeTestPlan, testWorkerBudget } from "./test-execution.js";
import { captureTestRuntime } from "./test-runtime.js";
import { readTestReceipt } from "./test-run-receipt.js";
import type { TestPlan } from "./test-plan.js";
import type { TestRuntime } from "./test-runtime.js";

const roots: string[] = [];
beforeEach(() => { vi.stubEnv("INTERLINKED_STAGES_LEDGER", ""); });
afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "test-execution-"));
    roots.push(root);
    return root;
}
function stageRows(root: string): Array<Record<string, unknown>> {
    const path = join(root, ".interlinked", "verification-stages.jsonl");
    // SAFETY: the fixture's ledger is written only by recordVerificationStage, one JSON object per line.
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
}
const selectedPlan: TestPlan = { version: 1, snapshot: "x", changedPaths: ["a.ts"], tests: [{ path: "a.test.ts", reasons: ["Test changed: a.ts"], durationMs: null }], omitted: [], mode: "selected", reasons: [], estimatedSerialMs: 0, reusable: true, runtimeHash: "h" };
const VALIDATION_MS = 30;
const priorReceipt = { key: "k", runId: "prior-run", durationMs: 1, identity: "k", platform: "test", toolchain: { node: "22", vitest: null, typescript: null }, stages: { exec_ms: 1, post_ms: 0 } };
/** Runtime validation that takes a measurable time before answering. */
function slowRuntime(answer: TestRuntime): void {
    const answerLater = (resolve: (value: TestRuntime) => void) => { global.setTimeout(() => resolve(answer), VALIDATION_MS); };
    vi.mocked(captureTestRuntime).mockImplementation(() => new Promise<TestRuntime>(answerLater));
}

it("bounds foreground workers by memory and the requested cap", () => {
    expect(testWorkerBudget(8)).toBe(3);
    expect(testWorkerBudget(1)).toBe(1);
});
describe("validation phase is measured on every validated path", () => {
    // test-contract: invariant — a receipt hit retains the producing checkout for artifact relocation while locating its files in the requested store.
    it("restores the artifact producer root from a receipt", async () => {
        const root = fixture(), store = join(root, "store");
        vi.mocked(captureTestRuntime).mockResolvedValue({ hash: "h" });
        const artifacts = { coverage_summary: { path: "prior-run/coverage/coverage-summary.json", sha256: "a".repeat(64) } };
        vi.mocked(readTestReceipt).mockReturnValue({ ...priorReceipt, artifacts, artifactRoot: "/original-checkout" });
        const result = await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, receiptStore: store });
        expect(result).toMatchObject({ status: "passed", reused: true, artifacts, artifactStore: store, artifactRoot: "/original-checkout" });
    });

    // test-contract: public-api — a receipt hit still pays runtime validation, and the row shows it as validate_ms beside lookup_ms
    it("records validate_ms and lookup_ms on a receipt hit with no exec_ms", async () => {
        const root = fixture();
        slowRuntime({ hash: "h" });
        vi.mocked(readTestReceipt).mockReturnValue(priorReceipt);
        const result = await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, stage: "edit" });
        expect(result).toMatchObject({ status: "passed", reused: true, runId: "prior-run" });
        const [row] = stageRows(root);
        expect(row).toMatchObject({ stage: "edit", check: "vitest:selected", status: "passed", reused: true, run_id: "prior-run" });
        expect(row?.validate_ms).toBeGreaterThanOrEqual(VALIDATION_MS - 5);
        expect(typeof row?.lookup_ms).toBe("number");
        expect(row?.exec_ms).toBeUndefined();
        expect(row?.reuse_denied_reason).toBeUndefined();
        expect(typeof row?.identity).toBe("string");
    });

    // test-contract: public-api — an early stale return after slow validation still reports the validation time it paid
    it("records validate_ms on an early stale return", async () => {
        const root = fixture();
        slowRuntime({ issue: "runtime unavailable" });
        const result = await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, stage: "edit" });
        expect(result.status).toBe("stale");
        expect(readTestReceipt).not.toHaveBeenCalled();
        const [row] = stageRows(root);
        expect(row).toMatchObject({ status: "stale", reused: false, reuse_denied_reason: "stale-inputs", identity: null });
        expect(row?.validate_ms).toBeGreaterThanOrEqual(VALIDATION_MS - 5);
        expect(row?.lookup_ms).toBeUndefined();
    });

    // test-contract: invariant — a dry run validates but writes no row
    it("writes no row for a dry run", async () => {
        const root = fixture();
        slowRuntime({ hash: "h" });
        vi.mocked(readTestReceipt).mockReturnValue(priorReceipt);
        await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, stage: "edit", dryRun: true });
        expect(stageRows(root)).toEqual([]);
    });
});

it("does not turn an empty selection into a passing test run", async () => {
    const result = await executeTestPlan({ version: 1, snapshot: "x", changedPaths: [], tests: [], omitted: [], mode: "selected", reasons: [], estimatedSerialMs: 0, reusable: true }, { root: "/unused", deadline: Date.now() + 1000 });
    expect(result.status).toBe("empty");
    expect(result.reused).toBe(false);
});
