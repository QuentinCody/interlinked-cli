import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { wait, attempt, release, measure } = vi.hoisted(() => ({ wait: vi.fn(), attempt: vi.fn(), release: vi.fn(), measure: vi.fn() }));
vi.mock("../../project-heavy-process-lock.js", () => ({ acquireProjectHeavyProcessLease: wait, tryAcquireProjectHeavyProcessLease: attempt }));
vi.mock("../../../lib/lint-import/runner.js", () => ({ measureImportedLint: measure }));
vi.mock("../../../lib/lint-import/baseline.js", () => ({ retireLintDebt: vi.fn(), newLintFindings: vi.fn() }));
import { runImportedLintAsync } from "./lint-import.js";
import { CheckEngine } from "../index.js";

let root: string, nested: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lint-recovery-"));
    nested = join(root, "python");
    mkdirSync(nested);
    mkdirSync(join(root, ".interlinked"));
    writeFileSync(join(root, ".flake8"), "[flake8]\n");
    writeFileSync(join(root, ".interlinked", "lint-import.json"), JSON.stringify({ version: 1,
        entries: [{ tool: "flake8", scope: ".", sources: [".flake8"] }], digests: { ".flake8": "0".repeat(64) } }));
    wait.mockReset().mockResolvedValue(release);
    attempt.mockReset().mockReturnValue(null);
    release.mockClear();
    measure.mockReset().mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("nested imported lint admission", () => {
    it("carries background admission from the real engine to the nested runner", async () => {
        const report = await new CheckEngine(nested).runChecksAsync(
            { projectRoot: nested, mode: "project" },
            { tools: ["lint-import"], admissionAlreadyHeld: true, waitForCapacity: true, timeoutMs: 1000 },
        );
        expect(report.skipped).toEqual([]);
        expect(report.toolsRun.map(tool => tool.id)).toEqual(["lint-import"]);
        expect(wait).toHaveBeenCalledTimes(1);
        expect(attempt).not.toHaveBeenCalled();
        expect(measure).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("waits for the policy project's lease during recovery and spends only the remaining deadline", async () => {
        let now = 100;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        wait.mockImplementation(async () => { now = 140; return release; });
        await expect(runImportedLintAsync({ scope: { projectRoot: nested, mode: "project" }, timeoutMs: 100, waitForCapacity: true })).resolves.toEqual([]);
        expect(wait).toHaveBeenCalledWith(root, 200, expect.any(AbortSignal));
        expect(attempt).not.toHaveBeenCalled();
        expect(measure).toHaveBeenCalledWith(root, expect.anything(), { timeoutMs: 60, cadence: "hook" });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("leaves foreground contention unavailable without queueing", async () => {
        await expect(runImportedLintAsync({ scope: { projectRoot: nested, mode: "project" }, timeoutMs: 100 })).rejects.toThrow("capacity is busy");
        expect(attempt).toHaveBeenCalledWith(root);
        expect(wait).not.toHaveBeenCalled();
        expect(measure).not.toHaveBeenCalled();
    });

    it("retains no-verdict when the background admission deadline expires", async () => {
        wait.mockResolvedValue(null);
        await expect(runImportedLintAsync({ scope: { projectRoot: nested, mode: "project" }, timeoutMs: 100, waitForCapacity: true })).rejects.toThrow("capacity is busy");
        expect(measure).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
    });

    it("releases admitted capacity when analysis fails", async () => {
        measure.mockRejectedValue(new Error("analysis failed"));
        await expect(runImportedLintAsync({ scope: { projectRoot: nested, mode: "project" }, timeoutMs: 100, waitForCapacity: true })).rejects.toThrow("analysis failed");
        expect(release).toHaveBeenCalledTimes(1);
    });
});
