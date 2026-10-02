import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareSelection, failingFiles, planSelection, promotionCounts, readFullReports, selectedRunArgs, summaryMarkdown } from "./ci-select-compare.mjs";

const ROOT = "/work/repo";
const plan = (mode, tests, omitted, reasons = []) => ({ version: 1, mode, tests: tests.map(path => ({ path, reasons: [] })), omitted, reasons });
const report = (files) => ({ success: !files.some(([, status]) => status === "failed"), testResults: files.map(([name, status]) => ({ name: `${ROOT}/${name}`, status, assertionResults: [] })) });
const lanes = (expected, ...reports) => ({ lanesExpected: expected, lanesReported: reports.length, fullFailed: [...new Set(reports.flatMap(entry => failingFiles(entry, ROOT)))].sort() });

describe("planSelection — positive (must fire): the plan becomes the job's selection", () => {
    // test-contract: public-api — `tests plan --json` returns `mode`, `tests[].path`, `omitted[]`, `reasons[]`; the selection keeps the must-run and omitted sets and the distinct reason kinds
    it("P1: a selective plan keeps must_run and omitted, and dedupes reasons by kind", () => {
        const selection = planSelection(plan("selected", ["src/a.test.ts"], ["src/b.test.ts", "src/c.test.ts"], ["Test changed: src/a.test.ts"]), { head: "h", base: "b" });
        expect(selection).toMatchObject({ mode: "selected", selective: true, must_run: ["src/a.test.ts"], omitted: ["src/b.test.ts", "src/c.test.ts"], universe: 3, head: "h", base: "b" });
    });
    it("P2: a full plan is not selective, and its widening reasons are kept by kind", () => {
        const selection = planSelection(plan("full", ["src/a.test.ts", "src/b.test.ts"], [], ["Opaque shared setup or configuration", "Unknown or deleted input: x.ts", "Unknown or deleted input: y.ts"]), { head: "h", base: "b" });
        expect(selection).toMatchObject({ mode: "full", selective: false, omitted: [], universe: 2 });
        expect(selection.reason_kinds).toEqual(["Opaque shared setup or configuration", "Unknown or deleted input"]);
    });
});

describe("planSelection — negative (must not fire): no base or no plan is no selection", () => {
    it("N1: a missing base or a plan error is unavailable, never an empty selection", () => {
        expect(planSelection(null, { head: "h", base: null, issue: "A new ref has no e2e predecessor base" })).toMatchObject({ mode: "unavailable", selective: false, issue: "A new ref has no e2e predecessor base", must_run: [] });
        expect(planSelection({ error: "Test planning unavailable" }, { head: "h", base: "b" })).toMatchObject({ mode: "unavailable", issue: "Test planning unavailable" });
    });
});

describe("failingFiles — positive (must fire)", () => {
    // test-contract: public-api — vitest's JSON reporter lists each test FILE in `testResults[]` with an absolute `name` and a `status`
    it("P3: returns the repo-relative files whose status is failed", () => {
        expect(failingFiles(report([["src/a.test.ts", "failed"], ["src/b.test.ts", "passed"]]), ROOT)).toEqual(["src/a.test.ts"]);
    });
    it("P4: a file outside the workspace keeps its absolute name, so it is visible rather than dropped", () => {
        expect(failingFiles({ testResults: [{ name: "/elsewhere/x.test.ts", status: "failed" }] }, ROOT)).toEqual(["/elsewhere/x.test.ts"]);
    });
});

describe("failingFiles — negative (must not fire)", () => {
    it("N2: a malformed report is an error, never an empty failure list", () => {
        expect(() => failingFiles({}, ROOT)).toThrow(/testResults/);
        expect(() => failingFiles({ testResults: [{ status: "failed" }] }, ROOT)).toThrow(/name/);
    });
});

describe("compareSelection — positive (must fire): a full-run failure the selection omitted is a miss", () => {
    // test-contract: invariant — a SELECTION_MISS is a test file that failed in the full lanes but was in the plan's OMITTED set; promotion counts only selective runs with every lane reported and no miss
    it("P5: an omitted failing file is a miss", () => {
        const selection = planSelection(plan("selected", ["src/a.test.ts"], ["src/b.test.ts"]), { head: "h", base: "b" });
        const row = compareSelection(selection, { ...lanes(2, report([["src/b.test.ts", "failed"]]), report([])), selectedFailed: [] });
        expect(row).toMatchObject({ status: "miss", misses: ["src/b.test.ts"], counts_for_promotion: false });
    });
    it("P6: failures outside the plan universe and failures only the selected run saw are kept apart from misses", () => {
        const selection = planSelection(plan("selected", ["src/a.test.ts"], ["src/b.test.ts"]), { head: "h", base: "b" });
        const row = compareSelection(selection, { ...lanes(1, report([["src/e2e-only.test.ts", "failed"]])), selectedFailed: ["src/a.test.ts"] });
        expect(row).toMatchObject({ status: "clean", misses: [], outside_plan: ["src/e2e-only.test.ts"], selected_only: ["src/a.test.ts"], counts_for_promotion: true });
    });
});

describe("compareSelection — negative (must not fire): no evidence of a miss is not a clean run", () => {
    it("N3: a missing lane report is incomplete and does not count for promotion; a miss already seen is still a miss", () => {
        const selection = planSelection(plan("selected", ["src/a.test.ts"], ["src/b.test.ts"]), { head: "h", base: "b" });
        expect(compareSelection(selection, { ...lanes(4, report([])), selectedFailed: [] })).toMatchObject({ status: "incomplete", counts_for_promotion: false, lanes_reported: 1, lanes_expected: 4 });
        expect(compareSelection(selection, { ...lanes(4, report([["src/b.test.ts", "failed"]])), selectedFailed: null })).toMatchObject({ status: "miss", misses: ["src/b.test.ts"] });
        expect(compareSelection(selection, { ...lanes(1, report([])), selectedFailed: null })).toMatchObject({ status: "incomplete" });
    });
    it("N4: a widened plan cannot miss anything and does not count for promotion", () => {
        const selection = planSelection(plan("full", ["src/a.test.ts", "src/b.test.ts"], [], ["Opaque shared setup or configuration"]), { head: "h", base: "b" });
        expect(compareSelection(selection, { ...lanes(1, report([["src/b.test.ts", "failed"]])), selectedFailed: null })).toMatchObject({ status: "widened", misses: [], counts_for_promotion: false });
    });
    it("N5: an unavailable selection is incomplete", () => {
        expect(compareSelection(planSelection(null, { head: "h", base: null, issue: "no base" }), { ...lanes(1, report([])), selectedFailed: null })).toMatchObject({ status: "incomplete", counts_for_promotion: false });
    });
});

describe("readFullReports, summaryMarkdown and promotionCounts", () => {
    it("P7: reads every lane report in a directory, unions failures, and counts the lanes", () => {
        const directory = mkdtempSync(join(tmpdir(), "select-compare-"));
        try {
            writeFileSync(join(directory, "unit-0.json"), JSON.stringify(report([["src/a.test.ts", "failed"]])));
            writeFileSync(join(directory, "integration.json"), JSON.stringify(report([["src/b.integration.test.ts", "failed"], ["src/a.test.ts", "failed"]])));
            writeFileSync(join(directory, "notes.txt"), "ignored");
            expect(readFullReports(directory, ROOT)).toEqual({ lanesReported: 2, fullFailed: ["src/a.test.ts", "src/b.integration.test.ts"] });
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
    it("P8: the summary names the status, the counts and every miss", () => {
        const selection = planSelection(plan("selected", ["src/a.test.ts"], ["src/b.test.ts"]), { head: "h", base: "b" });
        const markdown = summaryMarkdown(compareSelection(selection, { ...lanes(1, report([["src/b.test.ts", "failed"]])), selectedFailed: [] }));
        expect(markdown).toContain("SELECTION_MISS");
        expect(markdown).toContain("src/b.test.ts");
        expect(markdown).toContain("1 must-run / 1 omitted of 2");
    });
    it("P9: the promotion tally counts only selective, complete runs and stops at any miss", () => {
        const rows = [{ status: "clean", counts_for_promotion: true }, { status: "widened", counts_for_promotion: false }, { status: "clean", counts_for_promotion: true }, { status: "incomplete", counts_for_promotion: false }];
        expect(promotionCounts(rows)).toEqual({ rows: 4, selective_clean: 2, misses: 0, widened: 1, incomplete: 1 });
        expect(promotionCounts([...rows, { status: "miss", counts_for_promotion: false }]).misses).toBe(1);
    });
});

describe("selectedRunArgs", () => {
    // test-contract: bug — `vitest run` with no file filters runs the WHOLE suite; an empty selection must be refused, never passed through (the 2026-10-01 dry run: a shell array that failed to fill made the "selected" run a full one)
    it("P13: names every selected file, one JSON report, and GitHub annotations only inside Actions", () => {
        expect(selectedRunArgs(["src/a.test.ts", "src/b.test.ts"], "select/selected.json", true)).toEqual(["vitest", "run", "--reporter=default", "--reporter=github-actions", "--reporter=json", "--outputFile.json=select/selected.json", "src/a.test.ts", "src/b.test.ts"]);
        expect(selectedRunArgs(["src/a.test.ts"], "r.json", false)).not.toContain("--reporter=github-actions");
    });
    it("N6: an empty selection is refused", () => {
        expect(() => selectedRunArgs([], "r.json", true)).toThrow(/without filters/);
    });
});

describe("CLI select", () => {
    // test-contract: invariant — a push that creates a ref has no predecessor base (`resolveCiBase` refuses it); `select` records that as an unavailable selection and tells the job not to run a selected subset, without invoking the planner
    it("P11: a new-ref push writes an unavailable selection and run=false", async () => {
        const { execFileSync } = await import("node:child_process");
        const directory = mkdtempSync(join(tmpdir(), "select-compare-select-"));
        try {
            const event = join(directory, "event.json"), output = join(directory, "github-output");
            writeFileSync(event, JSON.stringify({ before: "0".repeat(40) }));
            execFileSync("git", ["init", "--quiet"], { cwd: directory });
            const stdout = execFileSync(process.execPath, [join(import.meta.dirname, "ci-select-compare.mjs"), "select", "--out-dir", join(directory, "select"), "--cli", join(directory, "absent-cli.js")],
                { cwd: directory, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_SHA: "h" } });
            expect(stdout).toContain("unavailable");
            expect(JSON.parse(readFileSync(join(directory, "select", "selection.json"), "utf8"))).toMatchObject({ mode: "unavailable", selective: false, base: null, issue: "A new ref has no e2e predecessor base" });
            expect(readFileSync(join(directory, "select", "files.txt"), "utf8")).toBe("");
            expect(readFileSync(output, "utf8")).toBe("run=false\n");
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
});

describe("CLI compare without a selection", () => {
    it("P12: a missing selection artifact is an incomplete row, not a crash", async () => {
        const { execFileSync } = await import("node:child_process");
        const directory = mkdtempSync(join(tmpdir(), "select-compare-nosel-"));
        try {
            execFileSync(process.execPath, [join(import.meta.dirname, "ci-select-compare.mjs"), "compare", "--selection", join(directory, "absent.json"), "--full-reports", join(directory, "absent-dir"), "--expected-lanes", "4", "--out", join(directory, "row.json")],
                { cwd: directory, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GITHUB_SHA: "h" } });
            expect(JSON.parse(readFileSync(join(directory, "row.json"), "utf8"))).toMatchObject({ status: "incomplete", issue: "Selection artifact missing", lanes_reported: 0, lanes_expected: 4 });
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
});

describe("CLI", () => {
    it("P10: `compare` writes the row and appends the summary without failing on a miss", async () => {
        const { execFileSync } = await import("node:child_process");
        const directory = mkdtempSync(join(tmpdir(), "select-compare-cli-"));
        try {
            const reports = join(directory, "reports");
            await import("node:fs").then(fs => fs.mkdirSync(reports));
            writeFileSync(join(reports, "unit-0.json"), JSON.stringify(report([["src/b.test.ts", "failed"]])));
            writeFileSync(join(directory, "selection.json"), JSON.stringify(planSelection(plan("selected", ["src/a.test.ts"], ["src/b.test.ts"]), { head: "h", base: "b" })));
            const summary = join(directory, "summary.md");
            const args = ["compare", "--selection", join(directory, "selection.json"), "--full-reports", reports, "--expected-lanes", "1", "--out", join(directory, "row.json")];
            // SELECT_COMPARE_ROOT stands in for the CI workspace the fixture reports' absolute names live under.
            const out = execFileSync(process.execPath, [join(import.meta.dirname, "ci-select-compare.mjs"), ...args],
                { cwd: directory, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GITHUB_STEP_SUMMARY: summary, SELECT_COMPARE_ROOT: ROOT } });
            expect(out).toContain("SELECTION_MISS");
            expect(JSON.parse(readFileSync(join(directory, "row.json"), "utf8"))).toMatchObject({ status: "miss", misses: ["src/b.test.ts"] });
            expect(readFileSync(summary, "utf8")).toContain("src/b.test.ts");
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
});
