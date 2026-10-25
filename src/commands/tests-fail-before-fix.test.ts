import { describe, expect, it } from "vitest";
import type { FailBeforeFixReport } from "../harness/fail-before-fix/index.js";
import { failBeforeFixExitCode, renderFailBeforeFix } from "./tests-fail-before-fix.js";

const OK: FailBeforeFixReport = {
    status: "ok", session: "S", base: "0123456789abcdef0123", reasons: [],
    files: [{ path: "src/sum.test.ts", role: "test", state: "reverted" }, { path: "src/sum.ts", role: "product", state: "reverted" }],
    tests: [
        { file: "src/sum.test.ts", name: "adds two numbers", isNew: true, subjectChanged: true, verdict: "fails-before-fix", before: "AssertionError: expected -1 to be 5" },
        { file: "src/sum.test.ts", name: "returns a number", isNew: true, subjectChanged: true, verdict: "passes-before-fix" },
        { file: "src/other.test.ts", name: "pins old behavior", isNew: true, subjectChanged: false, verdict: "passes-before-fix" },
        { file: "src/sum.test.ts", name: "keeps zero", isNew: false, subjectChanged: true, verdict: "passes-before-fix" },
    ],
};

describe("renderFailBeforeFix — positive", () => {
    it("P1: names the session, the base, the counts, and every NEW test that passes on the pre-session code", () => {
        expect(renderFailBeforeFix(OK)).toBe([
            "fail-before-fix: ok — session S, replayed from HEAD 0123456789ab",
            "  files: 2 replayed (1 product, 1 test), 0 unavailable",
            "  new tests: 1 fail on the pre-session code (they pin the change), 2 pass there, 0 inconclusive",
            "    passes before the change although the session changed its subject: src/sum.test.ts › returns a number",
            "    1 new test(s) whose subject did not change pass there too (they strengthen existing behavior)",
            "  existing tests: 1 pass on the pre-session code, 0 fail there, 0 inconclusive",
        ].join("\n"));
    });

    it("P1b: edits recovered from the transcript timeline are counted under the file line", () => {
        expect(renderFailBeforeFix({ ...OK, recovered: 2 }).split("\n").slice(1, 3)).toEqual([
            "  files: 2 replayed (1 product, 1 test), 0 unavailable",
            "  2 replayed edit(s) came from the transcript timeline: the harness log has no row for them",
        ]);
    });

    it("P2: exit 0 for evidence; with --strict, exit 1 when a new test passes on the pre-session code", () => {
        expect(failBeforeFixExitCode(OK, false)).toBe(0);
        expect(failBeforeFixExitCode(OK, true)).toBe(1);
        expect(failBeforeFixExitCode({ ...OK, tests: OK.tests.filter(row => row.verdict === "fails-before-fix") }, true)).toBe(0);
        expect(failBeforeFixExitCode({ ...OK, tests: OK.tests.filter(row => !row.subjectChanged) }, true)).toBe(0); // strengthening only
    });
});

describe("renderFailBeforeFix — negative", () => {
    it("N1: unavailable and unknown sessions exit 2 with their reasons; no tests is not an error", () => {
        const unavailable: FailBeforeFixReport = { ...OK, status: "unavailable", tests: [], reasons: ["src/sum.ts: the logged edits do not reproduce the current bytes (a change outside the log)"] };
        expect(renderFailBeforeFix(unavailable)).toMatch(/^fail-before-fix: unavailable — session S[\s\S]*src\/sum\.ts: the logged edits do not reproduce/);
        expect(failBeforeFixExitCode(unavailable, false)).toBe(2);
        expect(failBeforeFixExitCode({ ...OK, status: "no-session", tests: [] }, false)).toBe(2);
        expect(failBeforeFixExitCode({ ...OK, status: "no-tests", tests: [] }, true)).toBe(0);
    });
});
