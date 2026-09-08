import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamImportedLint } from "./lint-import.js";

const { run } = vi.hoisted(() => ({ run: vi.fn().mockResolvedValue([]) }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("../../harness/check-engine/tool-runners/lint-import.js", () => ({ runImportedLintAsync: run }));
beforeEach(() => { run.mockClear(); });

describe("human verify lint cadence", () => {
    it.each([{ allChecks: false, cadence: "hook" }, { allChecks: true, cadence: "all" }])("routes allChecks=$allChecks to $cadence profiles", async ({ allChecks, cadence }) => {
        await streamImportedLint({ cwd: "/repo", opts: { allChecks }, skipChecks: new Set(), allFlaggedFiles: new Set() });
        expect(run).toHaveBeenCalledWith({ scope: { projectRoot: "/repo", mode: "project", lintCadence: cadence }, timeoutMs: 30_000 });
    });
    it("honors explicit skips without starting a batch", async () => {
        await streamImportedLint({ cwd: "/repo", opts: { allChecks: true }, skipChecks: new Set(["lint_import"]), allFlaggedFiles: new Set() });
        expect(run).not.toHaveBeenCalled();
    });
});
