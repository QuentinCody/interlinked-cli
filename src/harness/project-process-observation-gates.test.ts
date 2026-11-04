import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import { readResourceBudget } from "./resource-budget.js";
import { tryAcquireForegroundCapacity } from "./test-capacity.js";
import { checkProjectTypecheckCleanAsync } from "./project-typecheck-gate.js";
import { runBoundedTestProcess } from "./quality-checks/test-process-gate.js";

vi.mock("./check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
vi.mock("./resource-budget.js", () => ({ readResourceBudget: vi.fn() }));
vi.mock("./test-capacity.js", () => ({ tryAcquireForegroundCapacity: vi.fn(), acquireTestCapacity: vi.fn() }));
vi.mock("./project-compiler-gate.js", () => ({
    runWithProjectCompilerLease: async <T>(_cwd: string, run: () => Promise<T>) => run(),
    tryAcquireProjectCompilerLease: vi.fn(),
}));

let root: string;
const release = vi.fn();
const budget = { reserveBytes: 1024 ** 3, maxRssBytes: 2 * 1024 ** 3 };
beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("INTERLINKED_SKIP_PROJECT_TYPECHECK", undefined);
    vi.stubEnv("NODE_OPTIONS", undefined);
    root = mkdtempSync(join(tmpdir(), "process-observation-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }));
    vi.mocked(tryAcquireForegroundCapacity).mockReturnValue({ release });
    vi.mocked(readResourceBudget).mockReturnValue(budget);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

// test-contract: public-api — no host slot means no compiler verdict or process launch, but the caller still receives the admission observation.
it("observes a compiler admission refusal without launching the compiler", async () => {
    vi.mocked(tryAcquireForegroundCapacity).mockReturnValue(null);
    const observe = vi.fn();
    const findings = await checkProjectTypecheckCleanAsync(root, { observe });
    expect(findings).toEqual([expect.objectContaining({ name: "project_typecheck_deferred", message: expect.stringContaining("Host check capacity busy") })]);
    expect(runProcessAsync).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledExactlyOnceWith({ waitMs: expect.any(Number), execMs: 0 });
    expect(release).not.toHaveBeenCalled();
});

// test-contract: public-api — resource-interrupted processes yield no clean/failing verdict; both gates preserve the measured cause and release capacity.
it.each(["compiler", "test"] as const)("preserves resource interruption evidence from the %s process", async kind => {
    vi.mocked(runProcessAsync).mockResolvedValue({ code: null, stdout: "", stderr: "", timedOut: false,
        killed: true, peakRssBytes: 3 * 1024 ** 3, resourceReason: "process tree exceeded RSS budget" });
    const observe = vi.fn();
    if (kind === "compiler") {
        await expect(checkProjectTypecheckCleanAsync(root, { observe })).resolves.toEqual([
            expect.objectContaining({ name: "project_typecheck_timed_out", severity: "warning" }),
        ]);
    } else {
        await expect(runBoundedTestProcess({ command: "node", args: [], cwd: root, timeoutMs: 1000,
            admissionAlreadyHeld: true, observe })).resolves.toEqual({ kind: "deferred", reason: "interrupted" });
    }
    expect(observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ resourceBudget: budget,
        peakRssBytes: 3 * 1024 ** 3, resourceReason: "process tree exceeded RSS budget", execMs: expect.any(Number) }));
    expect(release).toHaveBeenCalledTimes(1);
});
