import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withVerifyTimings } from "./check-timing.js";
import { runCodeQualityChecks } from "./tool-results.js";
import { runPerFileChecks } from "./file-checks.js";
vi.mock("./file-checks.js", () => ({ runPerFileChecks: vi.fn() }));
vi.mock("../../harness/verify-parity.js", () => ({ runVerifyParityChecks: () => ({ crossFileSwitchDiscriminant: [], singleImplementationInterface: [], filesWithoutTest: [] }) }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
it("continues after a parser stack overflow and records the exact incomplete file instead of a clean verdict", async () => {
    const root = mkdtempSync(join(tmpdir(), "verify-parse-recovery-")); roots.push(root);
    const bad = join(root, "deep.txt"), good = join(root, "good.txt");
    writeFileSync(bad, "deep input"); writeFileSync(good, "plain input");
    vi.mocked(runPerFileChecks).mockImplementation(({ file }) => { if (file === bad) throw new RangeError("Maximum call stack size exceeded"); });
    const previous = process.exitCode;
    try {
        await withVerifyTimings(root, () => runCodeQualityChecks([bad, good], root));
        expect(vi.mocked(runPerFileChecks).mock.calls.map(call => call[0].file)).toEqual([bad, good]);
        expect(process.exitCode).toBe(75);
        const rows = readFileSync(join(root, ".interlinked/verify-runs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(rows).toContainEqual(expect.objectContaining({ check: "file_checks_unavailable", status: "partial", skipped: 1,
            unavailable_inputs: [{ file: "deep.txt", reason: "RangeError" }] }));
    } finally { process.exitCode = previous; }
});
