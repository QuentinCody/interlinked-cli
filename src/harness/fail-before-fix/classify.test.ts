import { describe, expect, it } from "vitest";
import { causeKey } from "./cause-reporter.js";
import { classifyTest, describeFailure, failedByOwnCheck, failureKind, isNewTest, judgedFailure, parseVitestReport, TIMEOUT_REASON } from "./classify.js";

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

describe("parseVitestReport — vitest 3/4 timeout placeholder (kill-proof review round 4, M9)", () => {
    it("P1: `Error: STACK_TRACE_ERROR` becomes a readable timeout reason and is still not the test's own check", () => {
        const row = failing("Error: STACK_TRACE_ERROR\n    at task (file:///repo/node_modules/@vitest/runner/dist/chunk-artifact.js:1784:27)\n    at /private/var/repo/src/sum.test.ts:2:1");
        expect(row?.message).toBe(TIMEOUT_REASON);
        expect(row?.message).toMatch(/^test timed out \(vitest testTimeout/);
        expect(failedByOwnCheck(row ?? { status: "missing" })).toBe(false);
    });
    it("N1: vitest 2's own wording and every other first line pass through unchanged", () => {
        expect(failing("Error: Test timed out in 100ms.\n    at Timeout.<anonymous> (file:///repo/node_modules/@vitest/runner/dist/index.js:44:18)")?.message).toBe("Error: Test timed out in 100ms.");
        expect(failing("Error: STACK_TRACE_ERROR happened\n    at x (/repo/a.ts:1:1)")?.message).toBe("Error: STACK_TRACE_ERROR happened");
    });
});

// Property-test shapes below are copied from a real vitest 4 + fast-check 4.7 JSON report and cause sidecar
// (probe 2026-11-05, scratchpad/probe): the outer report is byte-identical whatever the predicate threw.
const FC = "/private/var/repo/node_modules/fast-check/lib/fast-check.js";
const RUNNER = "file:///private/var/repo/node_modules/@vitest/runner/dist/chunk-artifact.js";
const SYNC_REPORT = [
    "Error: Property failed after 1 tests", "{ seed: -233936872, path: \"0:3:1\", endOnFailure: true }", "Counterexample: [51]", "Shrunk 2 time(s)", "",
    "Hint: Enable verbose mode in order to have the list of all failing values encountered during the run",
    `    at buildError (file://${FC}:2434:16)`, `    at throwIfFailed (file://${FC}:2441:8)`, `    at reportRunDetails (file://${FC}:2457:14)`, `    at Module.assert (file://${FC}:2514:7)`,
    "    at /private/var/repo/src/sum.test.ts:4:33", `    at ${RUNNER}:302:11`, "    at new Promise (<anonymous>)", `    at runWithCancel (${RUNNER}:2323:10)`,
].join("\n");
const ASYNC_REPORT = [
    "Error: Property failed after 1 tests", "{ seed: 242610830, path: \"0:2:1:1\", endOnFailure: true }", "Counterexample: [51]", "Shrunk 3 time(s)",
    `    at buildError (file://${FC}:2434:16)`, `    at asyncThrowIfFailed (file://${FC}:2446:8)`, "    at processTicksAndRejections (node:internal/process/task_queues:103:5)",
].join("\n");
const ASSERTION_CAUSE = { message: "AssertionError: expected 51 to be less than or equal to 50", stack: `AssertionError: expected 51 to be less than or equal to 50\n    at /private/var/repo/src/sum.test.ts:4:119\n    at Property.predicate (file://${FC}:1329:99)\n    at Property.run (file://${FC}:1298:24)` };
const TYPEERROR_CAUSE = { message: "TypeError: Cannot read properties of undefined (reading 'x')", stack: `TypeError: Cannot read properties of undefined (reading 'x')\n    at crashy (/private/var/repo/src/sum.ts:2:94)\n    at /private/var/repo/src/sum.test.ts:5:82\n    at Property.predicate (file://${FC}:1329:99)` };
const PRODUCT_CAUSE = { message: "Error: product said no", stack: `Error: product said no\n    at assertsBad (/private/var/repo/src/sum.ts:3:66)\n    at /private/var/repo/src/sum.test.ts:6:104\n    at Property.predicate (file://${FC}:1329:99)` };
const TEST_THROW_CAUSE = { message: "Error: should have clamped", stack: `Error: should have clamped\n    at /private/var/repo/src/sum.test.ts:9:136\n    at Property.predicate (file://${FC}:1329:99)` };
const RETURNED_FALSE_CAUSE = { message: "Error: Property failed by returning false", stack: `Error: Property failed by returning false\n    at Property.run (file://${FC}:1299:66)\n    at runIt (file://${FC}:2477:24)` };

function failingWith(message: string, cause: { message: string; stack: string } | null | undefined): ReturnType<typeof parseVitestReport>[number] | undefined {
    const name = "/private/var/repo/src/sum.test.ts";
    const report = JSON.stringify({ testResults: [{ name, assertionResults: [{ fullName: "sum holds", title: "holds", status: "failed", failureMessages: [message] }] }] });
    const causes = cause === undefined ? undefined : new Map([[causeKey(name, "sum holds"), cause]]);
    return parseVitestReport(report, "/private/var/repo", causes)[0];
}

describe("failedByOwnCheck — property tests, positive (the report wraps the test's own check)", () => {
    it("P8: a fast-check report wrapping an `expect` assertion, the test file deeper in the outer stack, is the test's own check", () => {
        const row = failingWith(SYNC_REPORT, ASSERTION_CAUSE);
        expect(row?.thrownInTest).toBeUndefined();
        expect(row?.message).toBe("Error: Property failed after 1 tests");
        expect(row?.property).toEqual({ reportedInTest: true, wrapped: { message: ASSERTION_CAUSE.message, thrownInTest: true } });
        expect(failedByOwnCheck(row ?? { status: "missing" })).toBe(true);
        expect(classifyTest({ status: "passed" }, row)).toBe("fails-before-fix");
        expect(describeFailure(row ?? { status: "failed" })).toBe(`Error: Property failed after 1 tests (wrapping ${ASSERTION_CAUSE.message})`);
        expect(judgedFailure(row ?? { status: "failed" })).toEqual({ message: ASSERTION_CAUSE.message, thrownInTest: true });
    });

    it("P9: an async property whose outer stack never touches the test file is credited through its cause chain", () => {
        const row = failingWith(ASYNC_REPORT, ASSERTION_CAUSE);
        expect(row?.property?.reportedInTest).toBe(false);
        expect(failedByOwnCheck(row ?? { status: "missing" })).toBe(true);
    });

    it("P10: a predicate that RETURNED FALSE is the test's own verdict when the report's stack reaches the test file", () => {
        const row = failingWith(SYNC_REPORT, RETURNED_FALSE_CAUSE);
        expect(row?.property).toEqual({ reportedInTest: true, returnedFalse: true });
        expect(failedByOwnCheck(row ?? { status: "missing" })).toBe(true);
        expect(describeFailure(row ?? { status: "failed" })).toContain("(the predicate returned false)");
    });

    it("P11: a plain error thrown by the property body itself (first frame past the runner is the test file) is the test's own check", () => {
        const row = failingWith(SYNC_REPORT, TEST_THROW_CAUSE);
        expect(row?.property?.wrapped).toEqual({ message: "Error: should have clamped", thrownInTest: true });
        expect(failedByOwnCheck(row ?? { status: "missing" })).toBe(true);
    });

    it("P12: fast-check 3 put the wrapped error in the message (`Got …`); no sidecar is needed to judge it", () => {
        const v3 = (inner: string) => `Error: Property failed after 4 tests\n{ seed: 1, path: "3:0", endOnFailure: true }\nCounterexample: [51]\nShrunk 1 time(s)\nGot ${inner}\n    at buildError (file://${FC}:2434:16)\n    at /private/var/repo/src/sum.test.ts:4:33`;
        const assertion = failingWith(v3(`AssertionError: expected 51 to be less than or equal to 50\n    at /private/var/repo/src/sum.test.ts:4:119\n    at Property.predicate (file://${FC}:1329:99)`), undefined);
        expect(assertion?.property?.wrapped?.message).toBe("AssertionError: expected 51 to be less than or equal to 50");
        expect(failedByOwnCheck(assertion ?? { status: "missing" })).toBe(true);
        const product = failingWith(v3(`error: product said no\n    at assertsBad (/private/var/repo/src/sum.ts:3:66)\n    at /private/var/repo/src/sum.test.ts:6:104`), undefined);
        expect(product?.property?.wrapped).toEqual({ message: "Error: product said no", thrownInTest: false });
        expect(classifyTest({ status: "passed" }, product)).toBe("inconclusive");
    });

    it("P13: an error that left one of vitest's own helpers (`vi.waitUntil`) with the test file within the first 5 frames is the test's own check", () => {
        const row = failing(`Error: Timed out in waitUntil!\n    at Object.waitUntil (file:///private/var/repo/node_modules/vitest/dist/chunks/test.DNmyFkvJ.js:3410:44)\n    at /private/var/repo/src/sum.test.ts:4:53\n    at ${RUNNER}:302:11`);
        expect(row?.thrownInTest).toBeUndefined();
        expect(row?.throughVitestHelper).toBe(true);
        expect(failedByOwnCheck(row ?? { status: "missing" })).toBe(true);
    });
});

describe("failedByOwnCheck — property tests, negative (inconclusive, never a kill)", () => {
    it("N7: a fast-check report wrapping a product TypeError, or a plain error thrown by product code, stays inconclusive", () => {
        const crash = failingWith(SYNC_REPORT, TYPEERROR_CAUSE);
        expect(crash?.property?.wrapped).toEqual({ message: TYPEERROR_CAUSE.message, thrownInTest: false });
        expect(failedByOwnCheck(crash ?? { status: "missing" })).toBe(false);
        expect(classifyTest({ status: "passed" }, crash)).toBe("inconclusive");
        expect(describeFailure(crash ?? { status: "failed" })).toBe(`Error: Property failed after 1 tests (wrapping ${TYPEERROR_CAUSE.message})`);
        const product = failingWith(SYNC_REPORT, PRODUCT_CAUSE);
        expect(product?.property?.wrapped).toEqual({ message: "Error: product said no", thrownInTest: false });
        expect(classifyTest({ status: "passed" }, product)).toBe("inconclusive");
    });

    it("N8: a property report whose wrapped error was not captured (no sidecar row, or a row with no cause) proves nothing", () => {
        const missing = failingWith(SYNC_REPORT, undefined);
        expect(missing?.property).toEqual({ reportedInTest: true });
        expect(failedByOwnCheck(missing ?? { status: "missing" })).toBe(false);
        expect(describeFailure(missing ?? { status: "failed" })).toBe("Error: Property failed after 1 tests (the error the property wrapped was not captured)");
        expect(failedByOwnCheck(failingWith(SYNC_REPORT, null) ?? { status: "missing" })).toBe(false);
    });

    it("N9: an async predicate that returned false names the test file nowhere — not credited", () => {
        const row = failingWith(ASYNC_REPORT, RETURNED_FALSE_CAUSE);
        expect(row?.property).toEqual({ reportedInTest: false, returnedFalse: true });
        expect(failedByOwnCheck(row ?? { status: "missing" })).toBe(false);
    });

    it("N10: the runner's own timeout (`@vitest/runner` first, test file at frame 5) and a helper with the test file beyond frame 5 are not the test's check", () => {
        const timeout = failing(`Error: STACK_TRACE_ERROR\n    at task (${RUNNER}:1784:27)\n    at Object.<anonymous> (${RUNNER}:1817:16)\n    at Object.<anonymous> (${RUNNER}:1563:28)\n    at chain (${RUNNER}:599:14)\n    at /private/var/repo/src/sum.test.ts:5:1\n    at processTicksAndRejections (node:internal/process/task_queues:103:5)`);
        expect(timeout?.throughVitestHelper).toBeUndefined();
        expect(failedByOwnCheck(timeout ?? { status: "missing" })).toBe(false);
        const helper = "file:///private/var/repo/node_modules/vitest/dist/chunks/test.DNmyFkvJ.js";
        const deep = failing(`Error: Timed out in waitUntil!\n    at a (${helper}:1:1)\n    at b (${helper}:2:1)\n    at c (${helper}:3:1)\n    at d (${helper}:4:1)\n    at e (${helper}:5:1)\n    at /private/var/repo/src/sum.test.ts:4:53`);
        expect(deep?.throughVitestHelper).toBeUndefined();
        expect(failedByOwnCheck(deep ?? { status: "missing" })).toBe(false);
        expect(failingWith(SYNC_REPORT, ASSERTION_CAUSE)?.status === "failed" && failedByOwnCheck({ ...(failingWith(SYNC_REPORT, ASSERTION_CAUSE) ?? { status: "failed" }), status: "passed" })).toBe(false);
    });
});
