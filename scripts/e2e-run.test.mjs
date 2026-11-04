import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ preflight: vi.fn(), spawn: vi.fn() }));
vi.mock("./e2e-preflight.mjs", () => ({ preflightE2e: mocked.preflight }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
vi.mock("./e2e-coverage-merge.mjs", () => ({ mergeChildCoverage: vi.fn(), mergeStageRow: vi.fn() }));
import { runE2eCoverage } from "./e2e-run.mjs";

const roots = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("E2E execution prerequisite ordering", () => {
    it("does not invalidate evidence through a report symlink", async () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-run-report-link-"));
        roots.push(root);
        mkdirSync(join(root, "coverage-e2e"));
        const outside = join(root, "unrelated.json");
        writeFileSync(outside, "sentinel");
        symlinkSync(outside, join(root, "coverage-e2e/run.json"));
        await expect(runE2eCoverage(root)).rejects.toThrow("regular file");
        expect(readFileSync(outside, "utf8")).toBe("sentinel");
        expect(mocked.spawn).not.toHaveBeenCalled();
        expect(mocked.preflight).not.toHaveBeenCalled();
    });

    it("starts no child when preflight rejects and leaves no passing run record", async () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-run-preflight-"));
        roots.push(root);
        mocked.preflight.mockRejectedValueOnce(new Error("UNRESOLVED identity"));
        await expect(runE2eCoverage(root)).rejects.toThrow("UNRESOLVED identity");
        expect(mocked.spawn).not.toHaveBeenCalled();
        expect(JSON.parse(readFileSync(join(root, "coverage-e2e/run.json"), "utf8"))).toEqual({ schema: 1, lane: "e2e", passed: false });
        expect(mocked.preflight).toHaveBeenCalledWith(root, { requireBaseline: false });
    });
});
