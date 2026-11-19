import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAUSE_REPORTER, causeKey, causeReporterSource, parseCauseSidecar } from "./cause-reporter.js";

interface ReporterLike { onTestCaseResult(testCase: unknown): void; onFinished(files: unknown[]): void; onTestRunEnd(): void }
let dir = "";
let Reporter: new () => ReporterLike;
const OUT = () => join(dir, "causes.json");

const assertion = { name: "AssertionError", message: "expected 51 to be less than or equal to 50\nextra line", stack: "AssertionError: expected 51 to be less than or equal to 50\n    at /repo/src/sum.test.ts:4:119" };
const report = (cause?: object) => ({ name: "Error", message: "Property failed after 1 tests", stack: "Error: Property failed after 1 tests\n    at buildError (fast-check.js:1:1)", ...(cause ? { cause } : {}) });
const suite = { name: "sum", suite: undefined };
const task = (name: string, errors: unknown[]) => ({ type: "test", name, suite, result: { state: errors.length ? "fail" : "pass", errors } });
const testCase = (name: string, errors: unknown[]) => ({ module: { moduleId: "/repo/src/sum.test.ts" }, task: task(name, errors), fullName: `sum > ${name}` });

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "interlinked-cause-reporter-"));
    writeFileSync(join(dir, CAUSE_REPORTER), causeReporterSource(OUT()));
    Reporter = ((await import(pathToFileURL(join(dir, CAUSE_REPORTER)).href)) as { default: new () => ReporterLike }).default;
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("cause reporter — positive (must record)", () => {
    it("P1: vitest ≥ 3 route — a failed case's first error cause is recorded as `<name>: <first line>` plus its stack, keyed like the JSON reporter", () => {
        const reporter = new Reporter();
        reporter.onTestCaseResult(testCase("wraps", [report(assertion)]));
        reporter.onTestCaseResult(testCase("bare", [report()]));
        reporter.onTestCaseResult(testCase("passes", []));
        reporter.onTestRunEnd();
        const rows = parseCauseSidecar(readFileSync(OUT(), "utf8"));
        expect(rows.get(causeKey("/repo/src/sum.test.ts", "sum wraps"))).toEqual({ message: "AssertionError: expected 51 to be less than or equal to 50", stack: assertion.stack });
        expect(rows.get(causeKey("/repo/src/sum.test.ts", "sum bare"))).toBeNull();
        expect(rows.has(causeKey("/repo/src/sum.test.ts", "sum passes"))).toBe(false);
        expect(rows.size).toBe(2);
    });

    it("P2: vitest 1–2 route — `onFinished(files)` walks the task tree to the same rows", () => {
        const reporter = new Reporter();
        const file = { type: "suite", filepath: "/repo/src/sum.test.ts", name: "src/sum.test.ts", tasks: [{ type: "suite", name: "sum", tasks: [task("wraps", [report(assertion)]), task("passes", [])] }] };
        reporter.onFinished([file]);
        const rows = parseCauseSidecar(readFileSync(OUT(), "utf8"));
        expect(rows.get(causeKey("/repo/src/sum.test.ts", "sum wraps"))?.message).toBe("AssertionError: expected 51 to be less than or equal to 50");
        expect(rows.size).toBe(1);
    });

    it("P3: a cause without a name falls back to its stack's first line", () => {
        const reporter = new Reporter();
        reporter.onTestCaseResult(testCase("unnamed", [report({ message: "x", stack: "Error: Property failed by returning false\n    at Property.run (fast-check.js:2:2)" })]));
        reporter.onTestRunEnd();
        expect(parseCauseSidecar(readFileSync(OUT(), "utf8")).get(causeKey("/repo/src/sum.test.ts", "sum unnamed"))?.message).toBe("Error: Property failed by returning false");
    });
});

describe("cause reporter — negative (must not record / must not throw)", () => {
    it("N1: a malformed test case does not throw, and the sidecar is still written", () => {
        const reporter = new Reporter();
        expect(() => reporter.onTestCaseResult({})).not.toThrow();
        expect(() => reporter.onTestCaseResult(null)).not.toThrow();
        reporter.onTestRunEnd();
        expect(parseCauseSidecar(readFileSync(OUT(), "utf8")).size).toBe(0);
    });

    it("N2: parseCauseSidecar yields no rows for non-JSON, a non-array, or a row with a malformed cause", () => {
        expect(parseCauseSidecar("not json").size).toBe(0);
        expect(parseCauseSidecar("{}").size).toBe(0);
        expect(parseCauseSidecar(JSON.stringify([{ file: "/f", name: "n", cause: { message: 1 } }, { file: 1, name: "n", cause: null }])).size).toBe(0);
        expect(parseCauseSidecar(JSON.stringify([{ file: "/f", name: "n", cause: null }])).get(causeKey("/f", "n"))).toBeNull();
    });
});
