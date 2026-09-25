import { describe, expect, it } from "vitest";
import { MAX_REPORT_BYTES, parseJUnitXml, parseStructuredJson, parseStructuredReport, ReportInvalid } from "./structured-report.js";

const JSON_OK = JSON.stringify({ version: 1, cases: [{ id: "orders/create", status: "passed", durationMs: 12 }, { id: "orders/invalid", status: "failed", message: "exit 0, expected 2" }, { id: "orders/todo", status: "todo" }] });
const JUNIT_OK = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="orders" tests="3" failures="1" skipped="1">
    <testcase classname="orders.create" name="persists the order" time="0.012"/>
    <testcase classname="orders.invalid" name="fails without a name"><failure message="exit 0 &amp; no error">trace</failure></testcase>
    <testcase classname="orders.todo" name="later"><skipped/></testcase>
    <system-out>ignored</system-out>
  </testsuite>
</testsuites>`;

describe("structured JSON protocol v1 — positive (must parse)", () => {
    it("P1: a version-1 document yields cases with id, status and optional duration/message, in document order", () => {
        const report = parseStructuredJson(JSON_OK);
        expect(report.format).toBe("json");
        expect(report.cases).toEqual([
            { id: "orders/create", status: "passed", durationMs: 12 },
            { id: "orders/invalid", status: "failed", message: "exit 0, expected 2" },
            { id: "orders/todo", status: "todo" },
        ]);
    });
    it("P2: parseStructuredReport dispatches on the declared format, including Playwright's reporter output", async () => {
        expect((await parseStructuredReport(JSON_OK, "json")).cases).toHaveLength(3);
        expect((await parseStructuredReport(JUNIT_OK, "junit")).cases).toHaveLength(3);
        const playwright = JSON.stringify({ suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [{ title: "works", tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed", retry: 0 }] }] }] }] });
        expect((await parseStructuredReport(playwright, "playwright")).cases).toEqual([{ id: "a.spec.ts › works [chromium]", status: "passed", attempts: 1 }]);
    });
});
describe("structured JSON protocol v1 — negative (refuse, never guess)", () => {
    const bad = (value: unknown) => () => parseStructuredJson(typeof value === "string" ? value : JSON.stringify(value));
    it("N1: another version, a missing cases list, an unknown top-level or case key are refused", () => {
        expect(bad({ version: 2, cases: [] })).toThrow(ReportInvalid);
        expect(bad({ version: 1 })).toThrow(/cases/);
        expect(bad({ version: 1, cases: [], extra: true })).toThrow(/unknown key/);
        expect(bad({ version: 1, cases: [{ id: "a", status: "passed", retries: 2 }] })).toThrow(/unknown key/);
    });
    it("N2: an unknown status, an empty id, a duplicate id, and a non-JSON or truncated document are refused with the position named", () => {
        expect(bad({ version: 1, cases: [{ id: "a", status: "green" }] })).toThrow(/cases\[0\].status/);
        expect(bad({ version: 1, cases: [{ id: "", status: "passed" }] })).toThrow(/cases\[0\].id/);
        expect(bad({ version: 1, cases: [{ id: "a", status: "passed" }, { id: "a", status: "passed" }] })).toThrow(/duplicate case id a/);
        expect(bad("{\"version\":1,\"cases\":[")).toThrow(ReportInvalid);
        expect(bad("[]")).toThrow(/object/);
    });
    it("N3: a document over the byte bound is refused before parsing", () => {
        const huge = `{"version":1,"cases":[${"{\"id\":\"x\",\"status\":\"passed\"},".repeat(400_000)}]}`;
        expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_REPORT_BYTES);
        expect(() => parseStructuredJson(huge)).toThrow(/exceeds/);
    });
});
describe("JUnit XML subset — positive (must parse)", () => {
    it("P1: testsuites/testsuite/testcase yields classname::name ids with failure, skipped and passed states and the failure message unescaped", () => {
        const report = parseJUnitXml(JUNIT_OK);
        expect(report.format).toBe("junit");
        expect(report.cases).toEqual([
            { id: "orders.create::persists the order", status: "passed", durationMs: 12 },
            { id: "orders.invalid::fails without a name", status: "failed", message: "exit 0 & no error" },
            { id: "orders.todo::later", status: "skipped" },
        ]);
    });
    it("P2: a bare testsuite root, an error element, a self-closing testcase and a missing classname (suite name used) are all accepted", () => {
        const report = parseJUnitXml(`<testsuite name="unit" tests="2"><testcase name="a"/><testcase name="b"><error message="boom"/></testcase></testsuite>`);
        expect(report.cases).toEqual([{ id: "unit::a", status: "passed" }, { id: "unit::b", status: "error", message: "boom" }]);
    });
});
describe("JUnit XML subset — negative (ambiguity is refused, never guessed)", () => {
    const bad = (xml: string) => () => parseJUnitXml(xml);
    it("N1: DOCTYPE, ENTITY declarations and non-standard entity references are refused without resolution", () => {
        expect(bad(`<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite name="s"><testcase name="&x;"/></testsuite>`)).toThrow(/DOCTYPE/);
        expect(bad(`<testsuite name="s"><testcase name="&custom;"/></testsuite>`)).toThrow(/entity/);
    });
    it("N2: a tests= count that disagrees with the testcase children, nested testsuites, a testcase outside a suite and a testcase without a name are ambiguous layouts", () => {
        expect(bad(`<testsuite name="s" tests="3"><testcase name="a"/></testsuite>`)).toThrow(/tests="3".*1 testcase/);
        expect(bad(`<testsuite name="outer"><testsuite name="inner"><testcase name="a"/></testsuite></testsuite>`)).toThrow(/nested testsuite/);
        expect(bad(`<testsuites><testcase name="a"/></testsuites>`)).toThrow(/outside a testsuite/);
        expect(bad(`<testsuite name="s"><testcase classname="c"/></testsuite>`)).toThrow(/name/);
    });
    it("N3: duplicate ids, a testcase that is both failed and skipped, no testsuite at all, malformed or truncated XML, and an over-bound document are refused", () => {
        expect(bad(`<testsuite name="s"><testcase name="a"/><testcase name="a"/></testsuite>`)).toThrow(/duplicate case id s::a/);
        expect(bad(`<testsuite name="s"><testcase name="a"><failure/><skipped/></testcase></testsuite>`)).toThrow(/both/);
        expect(bad(`<report/>`)).toThrow(/testsuite/);
        expect(bad(`<testsuite name="s"><testcase name="a">`)).toThrow(/unclosed/);
        expect(bad(`<testsuite name="s"></testcase></testsuite>`)).toThrow(/mismatched/);
        expect(bad(`<testsuite name="s">${"<testcase name=\"a\"/>".repeat(1)}${" ".repeat(MAX_REPORT_BYTES)}</testsuite>`)).toThrow(/exceeds/);
    });
});
