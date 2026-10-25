import { describe, expect, it } from "vitest";
import { MAX_REPORT_BYTES, parseJUnitXml, parseStructuredJson, ReportInvalid } from "./structured-report.js";

// Mutation-hardening companion to structured-report.test.ts. Basis for the
// behaviours pinned here: the module header (structured-report.ts:4-9: both
// parsers are bounded, constructing and ambiguity-refusing), the JUnit grammar
// comment (:68-71) and the user-facing refusal messages that state the bounds
// (:34 "at most 512 bytes", :61 "exceeds 50000 entries", :172 "exceeds 50000 testcases").

const caseRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "passed", ...extra });
const jsonDoc = (cases: unknown[]) => JSON.stringify({ version: 1, cases });
const suite = (body: string, attrs = `name="s"`) => `<testsuite ${attrs}>${body}</testsuite>`;
const junitCase = (xml: string) => parseJUnitXml(xml).cases[0]!;

describe("structured JSON v1 — hardening", () => {
    it("accepts the status \"error\" (StructuredStatus lists it, :15)", () => {
        expect(parseStructuredJson(jsonDoc([{ id: "a", status: "error" }])).cases).toEqual([{ id: "a", status: "error" }]);
    });
    it("accepts a zero duration; the refusal text says only negative numbers are refused (:48)", () => {
        expect(parseStructuredJson(jsonDoc([caseRow("a", { durationMs: 0 })])).cases[0]!.durationMs).toBe(0);
    });
    it("refuses a duration that is not finite (1e999 parses to Infinity)", () => {
        expect(() => parseStructuredJson(`{"version":1,"cases":[{"id":"a","status":"passed","durationMs":1e999}]}`)).toThrow(ReportInvalid);
    });
    it("bounds a very long message by truncating it to a prefix of the original", () => {
        const long = "x".repeat(100_000) + "END";
        const message = parseStructuredJson(jsonDoc([caseRow("a", { message: long })])).cases[0]!.message!;
        expect(message.length).toBeLessThan(long.length);
        expect(long.startsWith(message)).toBe(true);
        expect(message.length).toBeGreaterThan(0);
    });
    it("refuses a non-string message with ReportInvalid, not a raw TypeError", () => {
        expect(() => parseStructuredJson(jsonDoc([caseRow("a", { message: 5 })]))).toThrow(ReportInvalid);
        expect(() => parseStructuredJson(jsonDoc([caseRow("a", { message: 5 })]))).toThrow(/message/);
    });
    it("accepts exactly 50000 cases and refuses 50001 (:61 states the bound)", () => {
        const rows = (n: number) => Array.from({ length: n }, (_, i) => `{"id":"c${i}","status":"passed"}`).join(",");
        expect(parseStructuredJson(`{"version":1,"cases":[${rows(50_000)}]}`).cases).toHaveLength(50_000);
        expect(() => parseStructuredJson(`{"version":1,"cases":[${rows(50_001)}]}`)).toThrow(/exceeds 50000/);
    });
    it("refuses a case that is not an object, naming the position, without a raw TypeError", () => {
        expect(() => parseStructuredJson(jsonDoc([1]))).toThrow(/cases\[0\] must be an object/);
        expect(() => parseStructuredJson(jsonDoc([null]))).toThrow(ReportInvalid);
        expect(() => parseStructuredJson(jsonDoc([null]))).toThrow(/must be an object/);
    });
    it("refuses a top-level JSON null with ReportInvalid", () => {
        expect(() => parseStructuredJson("null")).toThrow(ReportInvalid);
        expect(() => parseStructuredJson("null")).toThrow(/object/);
    });
    it("accepts an id of exactly 512 bytes and refuses 513 (:34 'at most 512 bytes')", () => {
        expect(parseStructuredJson(jsonDoc([caseRow("a".repeat(512))])).cases).toHaveLength(1);
        expect(() => parseStructuredJson(jsonDoc([caseRow("a".repeat(513))]))).toThrow(/at most 512 bytes/);
    });
    it("measures the id bound in bytes, not characters: 300 two-byte characters are refused", () => {
        expect(() => parseStructuredJson(jsonDoc([caseRow("é".repeat(300))]))).toThrow(/at most 512 bytes/);
    });
    it("refuses an id that contains a NUL character", () => {
        expect(() => parseStructuredJson(jsonDoc([caseRow("a\u0000b")]))).toThrow(/cases\[0\]\.id/);
    });
    it("accepts a document of exactly MAX_REPORT_BYTES bytes (only larger documents 'exceed')", () => {
        const base = `{"version":1,"cases":[]}`;
        const padded = base + " ".repeat(MAX_REPORT_BYTES - Buffer.byteLength(base));
        expect(Buffer.byteLength(padded)).toBe(MAX_REPORT_BYTES);
        expect(parseStructuredJson(padded).cases).toEqual([]);
    });
});

describe("JUnit XML subset — hardening", () => {
    it("decodes the five standard entities each to its own character", () => {
        const c = junitCase(suite(`<testcase name="&lt;&gt;&quot;&apos;&amp;"/>`));
        expect(c.id).toBe(`s::<>"'&`);
    });
    it("decodes decimal and hexadecimal numeric entities by their own radix", () => {
        expect(junitCase(suite(`<testcase name="&#65;&#x42;"/>`)).id).toBe("s::AB");
    });
    it("refuses an entity reference that lacks its terminating semicolon", () => {
        expect(() => parseJUnitXml(suite(`<testcase name="a&amp b"/>`))).toThrow(/entity/);
    });
    it("refuses an ENTITY declaration on its own, naming ENTITY (no DOCTYPE needed)", () => {
        expect(() => parseJUnitXml(`<!ENTITY x "y">${suite(`<testcase name="a"/>`)}`)).toThrow(/ENTITY/);
    });
    it("refuses an ENTITY declaration even when it is hidden inside a comment", () => {
        expect(() => parseJUnitXml(`<!-- <!ENTITY x "y"> -->${suite(`<testcase name="a"/>`)}`)).toThrow(/ENTITY declarations are not accepted/);
    });
    it("ignores markup that sits inside a comment", () => {
        const report = parseJUnitXml(suite(`<!-- <testcase name="ghost"/> --><testcase name="a"/>`, `name="s" tests="1"`));
        expect(report.cases.map(c => c.id)).toEqual(["s::a"]);
    });
    it("ignores markup that sits inside a CDATA section of system-out", () => {
        const report = parseJUnitXml(suite(`<system-out><![CDATA[<testcase name="ghost"/>]]></system-out><testcase name="a"/>`, `name="s" tests="1"`));
        expect(report.cases.map(c => c.id)).toEqual(["s::a"]);
    });
    it("reads single-quoted attribute values", () => {
        expect(junitCase(`<testsuite name='s'><testcase name='a' classname='c'/></testsuite>`).id).toBe("c::a");
    });
    it("refuses a malformed tag in the middle of the document instead of silently dropping the case", () => {
        expect(() => parseJUnitXml(suite(`<testcase name=a/>`))).toThrow(/malformed markup/);
    });
    it("refuses a testsuite that is not a root or a child of testsuites", () => {
        expect(() => parseJUnitXml(`<properties>${suite(`<testcase name="a"/>`)}</properties>`)).toThrow(/root element or a child of testsuites/);
    });
    it("refuses a tests= count that is smaller than the number of testcase children", () => {
        expect(() => parseJUnitXml(suite(`<testcase name="a"/><testcase name="b"/>`, `name="s" tests="1"`))).toThrow(/tests="1".*2 testcase/);
    });
    it("refuses a testcase nested inside a testcase with ReportInvalid", () => {
        expect(() => parseJUnitXml(suite(`<testcase name="a"><testcase name="b"/></testcase>`))).toThrow(ReportInvalid);
        expect(() => parseJUnitXml(suite(`<testcase name="a"><testcase name="b"/></testcase>`))).toThrow(/nested inside testcase/);
    });
    it("refuses a testcase whose name is only whitespace", () => {
        expect(() => parseJUnitXml(suite(`<testcase name="   "/>`))).toThrow(/without a name/);
    });
    it("falls back to the suite name when classname is only whitespace", () => {
        expect(junitCase(suite(`<testcase classname="   " name="a"/>`)).id).toBe("s::a");
    });
    it("falls back to the suite name when classname is empty", () => {
        expect(junitCase(suite(`<testcase classname="" name="a"/>`)).id).toBe("s::a");
    });
    it("refuses a testcase with neither classname nor a suite name (ambiguous id)", () => {
        expect(() => parseJUnitXml(`<testsuite><testcase name="a"/></testsuite>`)).toThrow(/ambiguous/);
    });
    it("records no duration for a non-finite time attribute", () => {
        const c = junitCase(suite(`<testcase name="a" time="Infinity"/>`));
        expect("durationMs" in c).toBe(false);
    });
    it("records no duration for a negative time attribute", () => {
        const c = junitCase(suite(`<testcase name="a" time="-1"/>`));
        expect("durationMs" in c).toBe(false);
    });
    it("converts time in seconds to whole milliseconds, rounding to the nearest", () => {
        expect(junitCase(suite(`<testcase name="a" time="0.0126"/>`)).durationMs).toBe(13);
        expect(junitCase(suite(`<testcase name="b" time="0"/>`)).durationMs).toBe(0);
    });
    it("omits the optional duration and message keys when the source has none", () => {
        const c = junitCase(suite(`<testcase name="a"/>`));
        expect(Object.keys(c)).toEqual(["id", "status"]);
    });
    it("bounds a very long failure message by truncating it to a prefix", () => {
        const long = "y".repeat(5000);
        const message = junitCase(suite(`<testcase name="a"><failure message="${long}"/></testcase>`)).message!;
        expect(message.length).toBeLessThan(long.length);
        expect(long.startsWith(message)).toBe(true);
        expect(message.length).toBeGreaterThan(0);
    });
    it("ignores a property element inside properties (grammar :70)", () => {
        const report = parseJUnitXml(suite(`<properties><property name="k" value="v"/></properties><testcase name="a"/>`));
        expect(report.cases.map(c => c.id)).toEqual(["s::a"]);
    });
    it("refuses a closing tag with nothing open as mismatched", () => {
        expect(() => parseJUnitXml(`<testsuite name="s"/></testsuite>`)).toThrow(/mismatched closing tag/);
    });
    it("accepts exactly 50000 testcases and refuses 50001 (:172 states the bound)", () => {
        const cases = (n: number) => Array.from({ length: n }, (_, i) => `<testcase name="c${i}"/>`).join("");
        expect(parseJUnitXml(suite(cases(50_000))).cases).toHaveLength(50_000);
        expect(() => parseJUnitXml(suite(cases(50_001)))).toThrow(/exceeds 50000 testcases/);
    });
});
