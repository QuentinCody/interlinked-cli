import { describe, expect, it } from "vitest";
import { classifyTest, failedByOwnCheck, failureKind, isNewTest, parseVitestReport } from "./classify.js";

describe("classifyTest — positive", () => {
    it("P1: passes now and fails BY ASSERTION on the pre-session code ⇒ fails-before-fix (it pins the change)", () => {
        expect(classifyTest({ status: "passed" }, { status: "failed", message: "AssertionError: expected 3 to be 4" })).toBe("fails-before-fix");
    });

    it("P2: passes on both sides ⇒ passes-before-fix (it does not reproduce what the session changed)", () => {
        expect(classifyTest({ status: "passed" }, { status: "passed" })).toBe("passes-before-fix");
    });
});

describe("classifyTest — negative (never a pin)", () => {
    it("N1: a crash or a load failure on the pre-session code is inconclusive, not a kill", () => {
        expect(classifyTest({ status: "passed" }, { status: "failed", message: "TypeError: Cannot read properties of undefined (reading 'path')" })).toBe("inconclusive");
        expect(classifyTest({ status: "passed" }, { status: "failed", message: "SyntaxError: The requested module './sum.js' does not provide an export named 'sum'" })).toBe("inconclusive");
        expect(classifyTest({ status: "passed" }, undefined)).toBe("inconclusive");
    });

    it("N2: a test that does not pass now is never judged", () => {
        expect(classifyTest({ status: "failed", message: "AssertionError" }, { status: "failed", message: "AssertionError" })).toBe("not-passing-now");
        expect(classifyTest(undefined, { status: "passed" })).toBe("not-passing-now");
        expect(classifyTest({ status: "skipped" }, { status: "failed", message: "AssertionError" })).toBe("not-passing-now");
    });
});

describe("failureKind / isNewTest / parseVitestReport", () => {
    it("P3: assertion vs crash vs other", () => {
        expect(failureKind("AssertionError: expected [] to deeply equal [ 1 ]")).toBe("assertion");
        expect(failureKind("Error: expected the receipt to be stale")).toBe("other");
        expect(failureKind("ReferenceError: state is not defined")).toBe("crash");
        expect(failureKind("Error: e2e: policy invalid")).toBe("other");
        expect(failureKind("")).toBe("other");
    });

    it("P4: a test is new when its own title is absent from the pre-session test file", () => {
        expect(isNewTest("it(\"adds positives\", …)", "adds negatives")).toBe(true);
        expect(isNewTest("it(\"adds positives\", …)", "adds positives")).toBe(false);
        expect(isNewTest(null, "anything")).toBe(true);
    });

    it("P5: the vitest JSON report gives per-test status and the first failure line, keyed by project-relative file", () => {
        const report = JSON.stringify({ testResults: [{ name: "/repo/src/sum.test.ts", assertionResults: [
            { fullName: "sum adds", title: "adds", status: "passed", failureMessages: [] },
            { fullName: "sum subtracts", title: "subtracts", status: "failed", failureMessages: ["AssertionError: expected 1 to be 2\n    at …"] },
        ] }] });
        expect(parseVitestReport(report, "/repo")).toEqual([
            { file: "src/sum.test.ts", name: "sum adds", title: "adds", status: "passed" },
            { file: "src/sum.test.ts", name: "sum subtracts", title: "subtracts", status: "failed", message: "AssertionError: expected 1 to be 2" },
        ]);
    });

    it("N3: a report that is not JSON is no evidence", () => {
        expect(parseVitestReport("not json", "/repo")).toEqual([]);
    });
});

// Stack shapes below are copied from a real vitest 4 JSON report (probe 2026-10-22, e47a-exec/probe-vitest-stack.mjs).
function failing(message: string, name = "/private/var/repo/src/sum.test.ts"): ReturnType<typeof parseVitestReport>[number] | undefined {
    const report = JSON.stringify({ testResults: [{ name, assertionResults: [{ fullName: "sum waits", title: "waits", status: "failed", failureMessages: [message] }] }] });
    return parseVitestReport(report, "/private/var/repo")[0];
}

describe("failedByOwnCheck — positive (the test's own check failed)", () => {
    it("P6: a plain Error whose first frame is the test file itself (a wait-until helper) is the test's own check", () => {
        const row = failing("Error: waitFor: predicate not satisfied within 5000ms\n    at Timeout._onTimeout (/private/var/repo/src/sum.test.ts:3:143)\n    at listOnTimeout (node:internal/timers:588:17)");
        expect(row?.thrownInTest).toBe(true);
        expect(failedByOwnCheck(row ?? { status: "missing" })).toBe(true);
        expect(classifyTest({ status: "passed" }, row)).toBe("fails-before-fix");
    });

    it("P7: an inline throw in the test body, reported with a file:// frame or under another absolute prefix, is the test's own check", () => {
        expect(failing("Error: should have thrown a RangeError\n    at file:///private/var/repo/src/sum.test.ts:9:58")?.thrownInTest).toBe(true);
        expect(failing("Error: should have thrown a RangeError\n    at /var/repo/src/sum.test.ts:9:58")?.thrownInTest).toBe(true);
        expect(failedByOwnCheck({ status: "failed", message: "AssertionError: expected 1 to be 2" })).toBe(true);
    });
});

describe("failedByOwnCheck — negative (inconclusive, never a kill)", () => {
    it("N4: a plain Error thrown from product code stays inconclusive even though the test file is the next frame", () => {
        const row = failing("Error: product said no\n    at boom (/private/var/repo/src/sum.ts:2:39)\n    at /private/var/repo/src/sum.test.ts:5:29");
        expect(row?.thrownInTest).toBeUndefined();
        expect(classifyTest({ status: "passed" }, row)).toBe("inconclusive");
        const expected = failing("Error: expected a valid configuration\n    at load (/private/var/repo/src/sum.ts:2:39)\n    at /private/var/repo/src/sum.test.ts:5:29");
        expect(classifyTest({ status: "passed" }, expected)).toBe("inconclusive");
    });

    it("N5: a crash thrown in the test file stays a crash; vitest's own timeout frames are the runner's", () => {
        const crash = failing("TypeError: Cannot read properties of undefined (reading 'b')\n    at /private/var/repo/src/sum.test.ts:6:41");
        expect(crash?.thrownInTest).toBe(true);
        expect(failedByOwnCheck(crash ?? { status: "missing" })).toBe(false);
        const timeout = failing("Error: STACK_TRACE_ERROR\n    at task (file:///repo/node_modules/@vitest/runner/dist/chunk-artifact.js:1784:27)");
        expect(timeout?.thrownInTest).toBeUndefined();
        expect(failedByOwnCheck(timeout ?? { status: "missing" })).toBe(false);
    });

    it("N6: a frame that only shares the file NAME, a message with no frame, and a passing test are not the test's own failure", () => {
        expect(failing("Error: no\n    at /private/var/repo/lib/sum.test.ts:1:1")?.thrownInTest).toBeUndefined();
        expect(failing("Error: waitFor: predicate not satisfied")?.thrownInTest).toBeUndefined();
        expect(failing("Error: no\n    at async Promise.all (index 0)\n    at /private/var/repo/src/sum.test.ts:3:1")?.thrownInTest).toBeUndefined();
        expect(failedByOwnCheck({ status: "passed", thrownInTest: true })).toBe(false);
    });
});
