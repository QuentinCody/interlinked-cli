import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { copyVitestRuntime } from "./coverage-index/__tests__/fixtures/vitest-runtime.js";
import { scheduleTests } from "./test-scheduler.js";
import { loadTestPlan } from "./test-plan-inputs.js";
import { executeTestPlan } from "./test-execution.js";
import { readTestRunObservation } from "./test-run-observation.js";

// Exercise runner behavior under a controlled one-worker resource plan.
vi.mock("./resource-memory.js", () => ({ readResourceMemory: () => ({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 }) }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), loadavg: () => [0, 0, 0] }));

it("runs edited tests, reuses exact passing inputs, and invalidates an edited assertion", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "planned-tests-")));
    try {
        copyVitestRuntime(root);
        writeFileSync(join(root, "package.json"), '{"type":"module"}');
        writeFileSync(join(root, "vitest.config.ts"), 'export default {test:{include:["*.test.ts"]}};');
        writeFileSync(join(root, "a.ts"), "export const a = 1;");
        writeFileSync(join(root, "a.test.ts"), 'import {test,expect} from "vitest"; import {a} from "./a"; test("a",()=>expect(a).toBe(1));');
        writeFileSync(join(root, "b.test.ts"), 'import {test,expect} from "vitest"; test("b",()=>expect(2+2).toBe(4));');
        const options = { root, paths: ["a.test.ts"], timeoutMs: 60_000, maxWorkers: 1 };
        const first = await scheduleTests(options);
        expect(first.status, first.reason + first.output).toBe("passed");
        expect(first.plan.tests.map(test => test.path)).toEqual(["a.test.ts"]);
        const reused = await scheduleTests(options);
        expect(reused.reused, reused.reason + reused.output).toBe(true);
        expect(reused.runId).toBe(first.runId);
        const path = join(root, "a.test.ts");
        writeFileSync(path, readFileSync(path, "utf8").replace("toBe(1)", "toBe(9)"));
        const changed = await scheduleTests(options);
        expect(changed.status, changed.reason + changed.output).toBe("failed");
        expect(changed.reused).toBe(false);
        const failedAgain = await scheduleTests(options);
        expect(failedAgain.runId).not.toBe(changed.runId);
        expect(failedAgain.status).toBe("failed");
        expect(readTestRunObservation(root)?.status).toBe("failed");
        const plan = await loadTestPlan(root, ["a.test.ts"], 60_000);
        writeFileSync(join(root, ".env"), "MODE=changed-since-planning");
        const stale = await executeTestPlan(plan, { root, deadline: Date.now() + 60_000 });
        expect(stale.status).toBe("stale");
        expect(stale.reason).toBe("Runtime changed since planning");
    } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
