import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withVerifyTimings } from "./check-timing.js";
import { runCodeQualityChecks } from "./tool-results.js";
import { runPerFileChecks } from "./file-checks.js";
vi.mock("./file-checks.js", () => ({ runPerFileChecks: vi.fn() }));
vi.mock("../../harness/verify-parity.js", () => ({ runVerifyParityChecks: () => ({ crossFileSwitchDiscriminant: [], singleImplementationInterface: [], filesWithoutTest: [] }) }));
const roots: string[] = [];
beforeEach(() => { vi.mocked(runPerFileChecks).mockReset(); });
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

it.each([
    ["oversized", "x".repeat(256 * 1024 + 1), "inline_input_size", "partial"],
    ["codegen-data", "// @codegen-data\nexport const values = [];", "input_excluded:codegen-data", "complete"],
    ["generated", "// @generated\nexport const generated = 1;", "input_excluded:generated", "complete"],
])("excludes %s input from per-file detectors and records the reason", async (_kind, content, check, status) => {
    const root = mkdtempSync(join(tmpdir(), "verify-input-exclusion-")); roots.push(root);
    const file = join(root, "input.txt"); writeFileSync(file, content);
    const previous = process.exitCode;
    try {
        await withVerifyTimings(root, () => runCodeQualityChecks([file], root));
        expect(runPerFileChecks).not.toHaveBeenCalled();
        const rows = readFileSync(join(root, ".interlinked/verify-runs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(rows).toContainEqual(expect.objectContaining({ check, status }));
        expect(process.exitCode).toBe(status === "partial" ? 75 : previous);
    } finally { process.exitCode = previous; }
});

it("records a non-Error detector failure and still scans the next file", async () => {
    const root = mkdtempSync(join(tmpdir(), "verify-unknown-failure-")); roots.push(root);
    const bad = join(root, "bad.txt"), good = join(root, "good.txt");
    writeFileSync(bad, "bad input"); writeFileSync(good, "good input");
    vi.mocked(runPerFileChecks).mockImplementation(({ file }) => { if (file === bad) throw "decoder unavailable"; });
    const previous = process.exitCode;
    try {
        await withVerifyTimings(root, () => runCodeQualityChecks([bad, good], root));
        expect(vi.mocked(runPerFileChecks).mock.calls.map(call => call[0].file)).toEqual([bad, good]);
        const rows = readFileSync(join(root, ".interlinked/verify-runs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(rows).toContainEqual(expect.objectContaining({ check: "file_checks_unavailable", status: "partial",
            unavailable_inputs: [{ file: "bad.txt", reason: "Unknown check error" }] }));
    } finally { process.exitCode = previous; }
});
