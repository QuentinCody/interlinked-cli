// Mutation-kill tests for fail-before-fix/classify.ts — 2026-11-05 dogfood campaign
// (docs/reviews/kill-proof-dogfood.md): the failure-kind grammar and the frame rule
// the kill-proof verdict stands on.
import { describe, expect, it } from "vitest";
import { failureKind, parseVitestReport } from "./classify.js";

function failing(message: string, name = "/repo/src/sum.test.ts", root = "/repo"): ReturnType<typeof parseVitestReport>[number] | undefined {
    const report = JSON.stringify({ testResults: [{ name, assertionResults: [{ fullName: "sum waits", title: "waits", status: "failed", failureMessages: [message] }] }] });
    return parseVitestReport(report, root)[0];
}

describe("failureKind — the grammar is anchored", () => {
    // test-contract: boundary - only a message that STARTS with AssertionError is an assertion; one that mentions it is some other error
    it("a message that merely mentions AssertionError is not an assertion", () => {
        expect(failureKind("Error: expected AssertionError to be thrown")).toBe("other");
        expect(failureKind("AssertionError: expected 1 to be 2")).toBe("assertion");
    });
    // test-contract: public-api - "is not iterable" is a crash signature whatever error class carries it
    it("an is-not-iterable error is a crash", () => {
        expect(failureKind("Error: undefined is not iterable (cannot read property Symbol(Symbol.iterator))")).toBe("crash");
    });
});

describe("parseVitestReport — the first failure line and the thrown-in-test frame", () => {
    // test-contract: boundary - the test file matches a frame at a PATH boundary; another file whose name merely ends with the test's name is not the test
    it("a frame in a sibling file whose name ends with the test's name is not thrown in the test", () => {
        const row = failing("Error: no\n    at /repo/notsum.test.ts:3:5", "/repo/sum.test.ts");
        expect(row?.file).toBe("sum.test.ts");
        expect(row?.thrownInTest).toBeUndefined();
        expect(failing("Error: no\n    at /repo/sum.test.ts:3:5", "/repo/sum.test.ts")?.thrownInTest).toBe(true);
    });
    // test-contract: public-api - the recorded message is the first NON-BLANK line of the failure text
    it("a failure text with a leading newline records its first real line", () => {
        expect(failing("\nAssertionError: expected 1 to be 2\n    at /repo/src/sum.test.ts:3:5")?.message).toBe("AssertionError: expected 1 to be 2");
    });
});
