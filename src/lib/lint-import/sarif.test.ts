import { describe, expect, it } from "vitest";
import { parseSarif } from "./sarif.js";
import { parseReportAdapter } from "./custom-adapters.js";

const result = { ruleId: "AvoidAny", message: { text: "Avoid unchecked values" }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/a%20file.ts" }, region: { startLine: 3 } } }] };
function report(run: Record<string, unknown> = {}): string {
    return JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "CustomLint" } }, invocations: [{ executionSuccessful: true }], results: [result], ...run }] });
}

describe("SARIF report adoption", () => {
    it("normalizes source URI, rule provenance and location", () => {
        expect(parseSarif(report())).toEqual([{ file: "src/a file.ts", line: 3, rule: "CustomLint/AvoidAny", message: "Avoid unchecked values" }]);
    });
    it("resolves artifact indexes and declared URI bases", () => {
        const indexed = { ...result, locations: [{ physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: 3 } } }] };
        expect(parseSarif(report({ results: [indexed], artifacts: [{ location: { uri: "a.ts", uriBaseId: "ROOT" } }], originalUriBaseIds: { ROOT: { uri: "file:///repo/" } } }))[0]?.file).toBe("/repo/a.ts");
    });
    it("honors accepted native suppressions and absent baseline results", () => {
        expect(parseSarif(report({ results: [{ ...result, suppressions: [{ status: "accepted" }] }, { ...result, baselineState: "absent" }] }))).toEqual([]);
    });
    it.each([
        { invocations: [{ executionSuccessful: false }] },
        { invocations: [{ executionSuccessful: true, toolExecutionNotifications: [{ level: "error" }] }] },
        { results: undefined }, { results: [{ ...result, locations: [] }] },
        { results: [{ ...result, ruleId: undefined }] },
    ])("rejects incomplete or failed reports: %j", (run) => { expect(() => parseSarif(report(run))).toThrow(); });
    it.each(["{}", "{", '{"version":"2.1.0","runs":[]}'])("does not interpret %s as a clean report", (text) => { expect(() => parseSarif(text)).toThrow(); });
    it.each([
        { command: "sh", args: ["-c", "lint"] },
        { command: "custom-lint", args: "--sarif" },
        { command: "custom-lint", args: ["--fix"] },
        { command: "custom-lint", args: [], successCodes: [1] },
    ])("rejects non-reviewable adapter execution: %j", (adapter) => {
        expect(() => parseReportAdapter({ format: "sarif", ...adapter })).toThrow();
    });
});
