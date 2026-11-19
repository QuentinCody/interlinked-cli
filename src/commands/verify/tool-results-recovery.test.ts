import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withVerifyTimings } from "./check-timing.js";
import { runCodeQualityChecks } from "./tool-results.js";
import { runPerFileChecks } from "./file-checks.js";
import { getProjectCheckEvidence } from "../../harness/checks/project-check-evidence.js";
import { parseExports } from "../../harness/project-graph.js";
vi.mock("./file-checks.js", () => ({ runPerFileChecks: vi.fn() }));
vi.mock("../../harness/project-graph.js", async (original) => {
    const graph = await original<typeof import("../../harness/project-graph.js")>();
    return { ...graph, parseExports: vi.fn(graph.parseExports) };
});
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
            unavailable_inputs: [{ file: "deep.txt", reason: "RangeError: Maximum call stack size exceeded" }] }));
    } finally { process.exitCode = previous; }
});

it.each([
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
        expect(rows).toContainEqual(expect.objectContaining({ check, status, skipped: 0, excluded: 1,
            excluded_inputs: [{ file: "input.txt", reason: _kind }] }));
        expect(process.exitCode).toBe(status === "partial" ? 75 : previous);
    } finally { process.exitCode = previous; }
});

it("shares complete evidence within one invocation and refreshes it for the next invocation", () => {
    const root = mkdtempSync(join(tmpdir(), "verify-evidence-lifetime-")); roots.push(root);
    const file = join(root, "source.ts");
    writeFileSync(file, "export const before = true;");
    const seen: string[] = [];
    vi.mocked(runPerFileChecks).mockImplementation(({ content }) => {
        const evidence = getProjectCheckEvidence(root);
        expect(evidence?.readFile(file)).toBe(content);
        expect(evidence?.listFiles()).toEqual(["source.ts"]);
        seen.push(content);
    });
    runCodeQualityChecks([file], root);
    expect(getProjectCheckEvidence(root)).toBeUndefined();
    writeFileSync(file, "export const after = true;");
    runCodeQualityChecks([file], root);
    expect(seen).toEqual(["export const before = true;", "export const after = true;"]);
    expect(getProjectCheckEvidence(root)).toBeUndefined();
});

it.each(["generated.ts", "generated.d.ts"])("marks %s as an excluded target before ordinary sibling checks while preserving its body as context", generatedName => {
    const root = mkdtempSync(join(tmpdir(), "verify-generated-context-")); roots.push(root);
    const file = join(root, "source.ts"), generated = join(root, generatedName);
    const generatedContent = "// @generated\nexport const generated = true;";
    writeFileSync(file, "export const source = true;"); writeFileSync(generated, generatedContent);
    const observed: Array<{ excluded: boolean | undefined; content: string | undefined }> = [];
    vi.mocked(runPerFileChecks).mockImplementation(() => {
        const evidence = getProjectCheckEvidence(root);
        observed.push({ excluded: evidence?.isExcluded(generated), content: evidence?.readFile(generated) });
    });
    runCodeQualityChecks([file, generated], root);
    expect(runPerFileChecks).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ file }));
    expect(observed).toEqual([{ excluded: true, content: generatedContent }]);
});

it.each([256 * 1024 + 1, 1_000_001])("passes the complete %i-byte source to detectors", async (size) => {
    const root = mkdtempSync(join(tmpdir(), "verify-whole-input-")); roots.push(root);
    const file = join(root, "large.ts");
    const content = `${" ".repeat(size)}\nexport function endOfFile(value: any) { return value; }\n`;
    writeFileSync(file, content);
    const previous = process.exitCode;
    try {
        await withVerifyTimings(root, () => runCodeQualityChecks([file], root));
        expect(runPerFileChecks).toHaveBeenCalledWith(expect.objectContaining({ file, content }));
        expect(process.exitCode).toBe(previous);
    } finally { process.exitCode = previous; }
});

it("records a missing source as incomplete and continues through a readable sibling", async () => {
    const root = mkdtempSync(join(tmpdir(), "verify-read-failure-")); roots.push(root);
    const missing = join(root, "missing.ts"), good = join(root, "good.ts");
    writeFileSync(good, "export const good = true;");
    const previous = process.exitCode;
    try {
        await withVerifyTimings(root, () => runCodeQualityChecks([missing, good], root));
        expect(runPerFileChecks).toHaveBeenCalledOnce();
        expect(runPerFileChecks).toHaveBeenCalledWith(expect.objectContaining({ file: good }));
        expect(process.exitCode).toBe(75);
        const rows = readFileSync(join(root, ".interlinked/verify-runs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(rows).toContainEqual(expect.objectContaining({ check: "file_read_unavailable", status: "partial",
            unavailable_inputs: [{ file: "missing.ts", reason: expect.stringContaining("ENOENT") }] }));
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

it("records export parser failures without aborting per-file checks or readable sibling exports", async () => {
    const root = mkdtempSync(join(tmpdir(), "verify-export-parser-")); roots.push(root);
    const bad = join(root, "bad.ts"), good = join(root, "good.ts");
    writeFileSync(bad, "export const bad = true;"); writeFileSync(good, "export const good = true;");
    vi.mocked(parseExports).mockImplementationOnce(() => { throw new SyntaxError("Export parser unavailable"); });
    const observedExports: Array<[string, string[]]> = [];
    vi.mocked(runPerFileChecks).mockImplementation(({ file, moduleExportsCache }) => {
        if (file === good) observedExports.push(...moduleExportsCache.entries());
    });
    const previous = process.exitCode;
    try {
        await withVerifyTimings(root, () => runCodeQualityChecks([bad, good], root));
        expect(runPerFileChecks).toHaveBeenCalledTimes(2);
        expect(observedExports).toEqual([[good, ["good"]]]);
        expect(process.exitCode).toBe(75);
        const rows = readFileSync(join(root, ".interlinked/verify-runs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(rows).toContainEqual(expect.objectContaining({ check: "module_exports_unavailable", status: "partial",
            unavailable_inputs: [{ file: "bad.ts", reason: "SyntaxError: Export parser unavailable" }] }));
    } finally { process.exitCode = previous; }
});
