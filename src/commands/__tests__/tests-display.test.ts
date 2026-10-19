import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadTestPlan } from "../../harness/test-plan-inputs.js";
import type { TestPlan } from "../../harness/test-plan.js";
import { pendingTests } from "../../harness/test-requests.js";
import { scheduleTests } from "../../harness/test-scheduler.js";
import { testsCommand } from "../tests.js";

vi.mock("../../harness/test-plan-inputs.js", () => ({ loadTestPlan: vi.fn(), changedTestInputs: () => ["a.ts"] }));
vi.mock("../../harness/test-requests.js", () => ({ pendingTests: vi.fn() }));
vi.mock("../../harness/test-scheduler.js", () => ({ scheduleTests: vi.fn() }));
vi.mock("../../harness/test-run-observation.js", () => ({ readTestRunObservation: () => null }));

let root: string;
let plan: TestPlan;
let printed: string[];
const originalExitCode = process.exitCode;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tests-display-")));
    plan = { version: 1, snapshot: "s", changedPaths: ["a.ts"], mode: "full", reusable: false,
        tests: Array.from({ length: 50 }, (_, index) => ({ path: `test-${index}.test.ts`, reasons: ["Full reconciliation requested"], durationMs: null })),
        reasons: ["Full reconciliation requested"], omitted: [], estimatedSerialMs: null };
    printed = [];
    vi.spyOn(console, "log").mockImplementation((value: string) => { printed.push(value); });
    vi.mocked(pendingTests).mockReturnValue({ ids: ["pending"], paths: plan.tests.map(test => test.path), full: true, requirements: {} });
    vi.mocked(loadTestPlan).mockResolvedValue(plan);
    process.exitCode = 0;
});

afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
});

// test-contract: public-api — display elision must not narrow the plan sent to execution or the machine-readable evidence.
it("keeps the complete JSON plan and allows full human detail without executing tests", async () => {
    await testsCommand("plan", [], { cwd: root, json: true });
    expect(JSON.parse(printed.pop()!)).toEqual(plan);
    await testsCommand("plan", [], { cwd: root });
    expect(printed.pop()).not.toContain("test-49.test.ts");
    await testsCommand("plan", [], { cwd: root, details: true });
    expect(printed.pop()).toContain("test-49.test.ts: Full reconciliation requested");
    expect(scheduleTests).not.toHaveBeenCalled();
});

it("shows full-suite pending work even when there are no named input paths", async () => {
    vi.mocked(pendingTests).mockReturnValue({ ids: ["full"], paths: [], full: true, requirements: {} });
    await testsCommand("status", [], { cwd: root });
    expect(printed.join("\n")).toContain("1 pending requests; 0 pending inputs; full suite requested: yes");
    expect(printed.join("\n")).toContain("Last observation: none");
});

it("bounds status presentation while keeping full pending inputs in JSON and details", async () => {
    await testsCommand("status", [], { cwd: root });
    expect(printed.pop()).toContain("38 additional pending inputs hidden");
    await testsCommand("status", [], { cwd: root, details: true });
    expect(printed.pop()).toContain("test-49.test.ts");
    await testsCommand("status", [], { cwd: root, json: true });
    expect(JSON.parse(printed.pop()!).paths).toHaveLength(50);
});

it.each([false, true])("retains failure diagnostics and exit status when details=%s", async details => {
    const diagnostic = `Assertion failed\n${"failure evidence\n".repeat(1000)}expected 2, received 1`;
    vi.mocked(scheduleTests).mockResolvedValue({ plan, status: "failed", runId: "failed-run", durationMs: 10, reused: false,
        reason: "Runner reported a test failure", output: diagnostic });
    await testsCommand("run", ["a.ts"], { cwd: root, details });
    const text = printed.join("\n");
    expect(text).toContain(diagnostic);
    expect(text).toContain("Runner reported a test failure");
    expect(text).toContain("no passing result certified");
    expect(text.includes("test-49.test.ts")).toBe(details);
    expect(process.exitCode).toBe(1);
    expect(scheduleTests).toHaveBeenCalledWith(expect.objectContaining({ paths: ["a.ts"], staticSelection: false }));
});

it("keeps a deferred execution and all plan entries in JSON, with exit 75", async () => {
    const result = { plan, status: "deferred" as const, runId: "deferred-run", durationMs: 0, reused: false, reason: "Capacity unavailable", output: "" };
    vi.mocked(scheduleTests).mockResolvedValue(result);
    await testsCommand("run", [], { cwd: root, json: true, details: true });
    expect(JSON.parse(printed.pop()!)).toEqual({ ...result, exported: [] });
    expect(process.exitCode).toBe(75);
});
