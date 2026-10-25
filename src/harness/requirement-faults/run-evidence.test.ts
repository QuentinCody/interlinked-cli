import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runVitest } from "../fail-before-fix/index.js";
import type { RequirementFault } from "./corpus.js";
import { runFaults } from "./run.js";

vi.mock("../fail-before-fix/index.js", () => ({ runVitest: vi.fn() }));
const roots: string[] = [];
const fault: RequirementFault = { id: "subtract", requirement: { id: "adds" }, path: "src/sum.ts", find: "a + b", replace: "a - b", rationale: "wrong arithmetic", tests: ["src/sum.test.ts"], origin: "authored" };
const passed = { file: "src/sum.test.ts", name: "adds", title: "adds", status: "passed" };
beforeEach(() => { vi.mocked(runVitest).mockReset(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fault-evidence-")));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/sum.ts"), "a + b");
    writeFileSync(join(root, "src/sum.test.ts"), "test");
    execFileSync("git", ["init", "--quiet", root]);
    return root;
}

describe("fault run evidence boundaries", () => {
    it("does not launch a runner when no faults were selected", async () => {
        vi.mocked(runVitest).mockResolvedValue([]);
        expect(await runFaults({ root: project(), faults: [], budgetMs: 1000 })).toMatchObject({ faults: [], requirements: [] });
        expect(runVitest).not.toHaveBeenCalled();
    });
    it.each([{ baseline: [] }, { baseline: [{ ...passed, status: "failed" }] }, { baseline: [{ ...passed, status: "pending" }] }])("keeps an unmeasured baseline out of the kill fraction: %j", async ({ baseline }) => {
        vi.mocked(runVitest).mockResolvedValue(baseline);
        const report = await runFaults({ root: project(), faults: [fault], budgetMs: 1000 });
        expect(report.faults[0]).toMatchObject({ status: "inconclusive", killedBy: [] });
        expect(report.requirements[0]?.fraction).toBeNull();
        expect(runVitest).toHaveBeenCalledTimes(1);
    });
    it("refuses a fault through an absolute symlink without changing its live target", async () => {
        const root = project();
        symlinkSync(join(root, "src/sum.ts"), join(root, "src/link.ts"));
        vi.mocked(runVitest).mockResolvedValueOnce([passed]).mockImplementation(async () => {
            expect(readFileSync(join(root, "src/sum.ts"), "utf8")).toBe("a + b");
            return [passed];
        });
        const report = await runFaults({ root, faults: [{ ...fault, path: "src/link.ts" }], budgetMs: 1000 });
        expect(report.faults[0]).toMatchObject({ status: "invalid", reason: expect.stringMatching(/symlink/) });
        expect(runVitest).toHaveBeenCalledTimes(1);
    });
});
