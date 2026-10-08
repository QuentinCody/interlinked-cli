import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./resource-memory.js", () => ({ readResourceMemory: () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }) }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), availableParallelism: () => 8, loadavg: () => [0, 0, 0] }));
vi.mock("./test-runtime.js", () => ({ captureTestRuntime: vi.fn() }));
vi.mock("./coverage-shards/discovery.js", () => ({ captureVitestEnvironment: () => ({ environment: {}, environmentHash: "env" }) }));
vi.mock("./test-run-receipt.js", async importOriginal => ({ ...await importOriginal<typeof import("./test-run-receipt.js")>(), readTestReceipt: vi.fn(), writeTestReceipt: vi.fn() }));
vi.mock("./check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
vi.mock("./test-run-report.js", () => ({ testReportIssue: () => null }));
import { executeTestPlan, testWorkerBudget } from "./test-execution.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import { captureTestRuntime } from "./test-runtime.js";
import { readTestReceipt } from "./test-run-receipt.js";
import { nonNull } from "../lib/non-null.js";
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

describe("memory headroom on the vitest stage row", () => {
    // test-contract: public-api — the executor's vitest row carries the child tree's peak RSS, the admitted budget and the child's heap limit
    it("records peak_rss_bytes, rss_budget_bytes and heap_limit_mb for a fresh run", async () => {
        const root = fixture();
        // The launcher resolves `vitest/node` from the checkout it runs in; a stub package keeps the fixture hermetic.
        const stub = join(root, "node_modules", "vitest");
        mkdirSync(stub, { recursive: true });
        writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "vitest", exports: { "./node": "./node.js" } }));
        writeFileSync(join(stub, "node.js"), "");
        vi.mocked(captureTestRuntime).mockResolvedValue({ hash: "h" });
        vi.mocked(readTestReceipt).mockReturnValue(null);
        vi.mocked(runProcessAsync).mockResolvedValue({ code: 1, killed: false, timedOut: false, stdout: "", stderr: "", peakRssBytes: 777_000_000 });
        await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, stage: "push", receiptStore: join(root, "store") });
        const [row] = stageRows(root);
        expect(row).toMatchObject({ check: "vitest:selected", peak_rss_bytes: 777_000_000, heap_limit_mb: 1536 });
        expect(row?.rss_budget_bytes).toBeGreaterThan(0);
        const options = vi.mocked(runProcessAsync).mock.calls[0]?.[2];
        expect(options?.resourceBudget?.maxRssBytes).toBe(row?.rss_budget_bytes);
    });

    // test-contract: invariant — a receipt hit launches no child, so its row carries no memory facts
    it("writes no memory fields on a reused result", async () => {
        const root = fixture();
        vi.mocked(captureTestRuntime).mockResolvedValue({ hash: "h" });
        vi.mocked(readTestReceipt).mockReturnValue(priorReceipt);
        await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, stage: "edit" });
        const [row] = stageRows(root);
        for (const field of ["peak_rss_bytes", "rss_budget_bytes", "heap_limit_mb"]) expect(row).not.toHaveProperty(field);
    });
});

describe("coverage source binding is published only for a run whose inputs were re-validated", () => {
    /** A stub vitest package, a source file and a child that "measures" it into the run's coverage directory. */
    function coverageRun(root: string): void {
        const stub = join(root, "node_modules", "vitest");
        mkdirSync(stub, { recursive: true });
        writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "vitest", exports: { "./node": "./node.js" } }));
        writeFileSync(join(stub, "node.js"), "");
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
        vi.mocked(readTestReceipt).mockReturnValue(null);
        vi.mocked(runProcessAsync).mockImplementation(async (_command, args) => {
            const source = (args as string[]).find(arg => arg.includes("reportsDirectory")) ?? "";
            const directory = /"reportsDirectory":("[^"]*")/.exec(source)?.[1];
            if (directory) {
                mkdirSync(JSON.parse(directory), { recursive: true });
                writeFileSync(join(JSON.parse(directory), "coverage-summary.json"), JSON.stringify({ [join(root, "src", "a.ts")]: { lines: { pct: 100 } } }));
            }
            return { code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
        });
    }
    const SNAPSHOT: ReadonlyMap<string, string> = new Map([["src/a.ts", "a".repeat(64)]]);
    const hasSources =(result: { artifacts?: Record<string, unknown> }) => Object.keys(result.artifacts ?? {}).includes("coverage_sources");

    // test-contract: invariant — a run whose runtime could not be validated never publishes a source binding
    it("P6: omits sources.json when the plan carries a runtime issue", async () => {
        const root = fixture();
        coverageRun(root);
        vi.mocked(captureTestRuntime).mockResolvedValue({ hash: "h" });
        const result = await executeTestPlan({ ...selectedPlan, runtimeIssue: "snapshot unavailable" }, { root, deadline: Date.now() + 5000, receiptStore: join(root, "store"), coverage: { reporters: [] } });
        expect(result.status).toBe("passed");
        expect(hasSources(result)).toBe(false);
    });

    // test-contract: invariant — an unreusable (opaque reporter) run publishes the binding only when the runtime is identical after the run
    it("P6: omits sources.json when the runtime changed during an opaque-reporter run", async () => {
        const root = fixture();
        coverageRun(root);
        vi.mocked(captureTestRuntime).mockResolvedValueOnce({ hash: "h" }).mockResolvedValue({ hash: "changed" });
        const result = await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, receiptStore: join(root, "store"), coverage: { reporters: [join(root, "missing-reporter.mjs")] } });
        expect(result.status).toBe("passed");
        expect(hasSources(result)).toBe(false);
    });

    it("N6: publishes sources.json when the runtime is identical before and after an opaque-reporter run", async () => {
        const root = fixture();
        coverageRun(root);
        vi.mocked(captureTestRuntime).mockResolvedValue({ hash: "h", files: SNAPSHOT });
        const result = await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, receiptStore: join(root, "store"), coverage: { reporters: [join(root, "missing-reporter.mjs")] } });
        expect(result.status).toBe("passed");
        expect(hasSources(result)).toBe(true);
    });

    it("N6: publishes sources.json for a validated fresh run", async () => {
        const root = fixture();
        coverageRun(root);
        vi.mocked(captureTestRuntime).mockResolvedValue({ hash: "h", files: SNAPSHOT });
        const result = await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, receiptStore: join(root, "store"), coverage: { reporters: [] } });
        expect(result.status).toBe("passed");
        expect(hasSources(result)).toBe(true);
    });

    // test-contract: invariant — the binding carries the validated post-run snapshot's hashes; live bytes written after the snapshot are never bound, and a file the snapshot lacks is omitted
    it("P4: binds the snapshot hash of a measured file, not the bytes now on disk", async () => {
        const root = fixture(), store = join(root, "store");
        coverageRun(root);
        vi.mocked(captureTestRuntime).mockResolvedValue({ hash: "h", files: SNAPSHOT });
        writeFileSync(join(root, "src", "a.ts"), "export const a = 2; // changed after the snapshot");
        const result = await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, receiptStore: store, coverage: { reporters: [] } });
        const sources = JSON.parse(readFileSync(join(store, nonNull(result.artifacts?.coverage_sources).path), "utf8"));
        expect(sources.files["src/a.ts"].sha256).toBe(SNAPSHOT.get("src/a.ts"));
    });

    it("P4: omits sources.json when the validated snapshot carries no file hashes", async () => {
        const root = fixture();
        coverageRun(root);
        vi.mocked(captureTestRuntime).mockResolvedValue({ hash: "h" });
        const result = await executeTestPlan(selectedPlan, { root, deadline: Date.now() + 5000, receiptStore: join(root, "store"), coverage: { reporters: [] } });
        expect(result.status).toBe("passed");
        expect(hasSources(result)).toBe(false);
    });
});

it("does not turn an empty selection into a passing test run", async () => {
    const result = await executeTestPlan({ version: 1, snapshot: "x", changedPaths: [], tests: [], omitted: [], mode: "selected", reasons: [], estimatedSerialMs: 0, reusable: true }, { root: "/unused", deadline: Date.now() + 1000 });
    expect(result.status).toBe("empty");
    expect(result.reused).toBe(false);
});
