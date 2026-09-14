import { expect, it, vi } from "vitest";
vi.mock("./resource-memory.js", () => ({ readResourceMemory: () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }) }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), availableParallelism: () => 8, loadavg: () => [0, 0, 0] }));
import { executeTestPlan, testWorkerBudget } from "./test-execution.js";

it("bounds foreground workers by memory and the requested cap", () => {
    expect(testWorkerBudget(8)).toBe(3);
    expect(testWorkerBudget(1)).toBe(1);
});
it("does not turn an empty selection into a passing test run", async () => {
    const result = await executeTestPlan({ version: 1, snapshot: "x", changedPaths: [], tests: [], omitted: [], mode: "selected", reasons: [], estimatedSerialMs: 0, reusable: true }, { root: "/unused", deadline: Date.now() + 1000 });
    expect(result.status).toBe("empty");
    expect(result.reused).toBe(false);
});
