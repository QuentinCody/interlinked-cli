// Unit E2: Playwright's JSON reporter normalized to structured cases (plan
// §10.2 "Playwright + managed application", PE-27). Case identity is the
// file, the title path and the project variant; the FIRST attempt decides
// (a retry that passes never hides the first failure); skipped and
// expected-failure cases never pass; anything ambiguous makes the report
// unreadable rather than guessed.
import { describe, expect, it } from "vitest";
import { parsePlaywrightJson } from "./playwright-report.js";

const result = (status: string, retry = 0, extra: Record<string, unknown> = {}) => ({ status, retry, startTime: `2026-01-01T00:00:0${retry}.000Z`, duration: 1500, ...extra });
const report = (tests: Array<Record<string, unknown>>, title = "creates an order") => JSON.stringify({
    config: { workers: 1 },
    suites: [{ title: "orders.spec.ts", file: "orders.spec.ts", specs: [], suites: [{ title: "orders", file: "orders.spec.ts", specs: [{ title, file: "orders.spec.ts", tests }] }] }],
});

describe("parsePlaywrightJson — positive (must normalize)", () => {
    it("P1: a passing test becomes one case identified by file › titles [project], with its first attempt's start and duration", () => {
        const parsed = parsePlaywrightJson(report([{ projectName: "chromium", status: "expected", results: [result("passed")] }]));
        expect(parsed.format).toBe("playwright");
        expect(parsed.cases).toEqual([{ id: "orders.spec.ts › orders › creates an order [chromium]", status: "passed", durationMs: 1500, startedAt: "2026-01-01T00:00:00.000Z", attempts: 1 }]);
    });
    it("P2: two project variants of one spec are two cases; a spec without a project name has no variant suffix", () => {
        const parsed = parsePlaywrightJson(report([{ projectName: "chromium", status: "expected", results: [result("passed")] }, { projectName: "webkit", status: "expected", results: [result("passed")] }]));
        expect(parsed.cases.map(row => row.id)).toEqual(["orders.spec.ts › orders › creates an order [chromium]", "orders.spec.ts › orders › creates an order [webkit]"]);
        expect(parsePlaywrightJson(report([{ status: "expected", results: [result("passed")] }])).cases[0]!.id).toBe("orders.spec.ts › orders › creates an order");
    });
});
describe("parsePlaywrightJson — negative (never a pass it did not earn)", () => {
    it("N1 (PE-27): a first attempt that failed and a retry that passed is FAILED with the retry recorded; Playwright's 'flaky' status never passes", () => {
        const parsed = parsePlaywrightJson(report([{ projectName: "chromium", status: "flaky", results: [result("failed", 0, { error: { message: "expected 200, got 404" } }), result("passed", 1)] }]));
        expect(parsed.cases[0]).toMatchObject({ status: "failed", attempts: 2 });
        expect(parsed.cases[0]!.message).toMatch(/expected 200, got 404/);
        expect(parsed.cases[0]!.message).toMatch(/passed on retry 1; the first attempt counts/);
    });
    it("N2: skipped, timed-out/interrupted and expected-failure (test.fail / fixme) cases never pass", () => {
        expect(parsePlaywrightJson(report([{ status: "skipped", results: [result("skipped")] }])).cases[0]!.status).toBe("skipped");
        expect(parsePlaywrightJson(report([{ status: "skipped", results: [] }])).cases[0]!.status).toBe("skipped");
        expect(parsePlaywrightJson(report([{ status: "unexpected", results: [result("timedOut")] }])).cases[0]!.status).toBe("failed");
        expect(parsePlaywrightJson(report([{ status: "unexpected", results: [result("interrupted")] }])).cases[0]!.status).toBe("failed");
        expect(parsePlaywrightJson(report([{ status: "expected", annotations: [{ type: "fail" }], results: [result("failed")] }])).cases[0]!.status).toBe("todo");
        expect(parsePlaywrightJson(report([{ status: "skipped", annotations: [{ type: "fixme" }], results: [] }])).cases[0]!.status).toBe("todo");
    });
    it("N3: an unknown result status, a duplicate case identity, a non-object report and a missing suites list make the whole report unreadable", () => {
        expect(() => parsePlaywrightJson(report([{ status: "expected", results: [result("maybe")] }]))).toThrow(/result status "maybe"/);
        expect(() => parsePlaywrightJson(report([{ projectName: "chromium", status: "expected", results: [result("passed")] }, { projectName: "chromium", status: "expected", results: [result("passed")] }]))).toThrow(/duplicate case id/);
        expect(() => parsePlaywrightJson("[]")).toThrow(/must be a JSON object/);
        expect(() => parsePlaywrightJson("{}")).toThrow(/report\.suites must be a list/);
        expect(() => parsePlaywrightJson("not json")).toThrow(/not valid JSON/);
    });
});
