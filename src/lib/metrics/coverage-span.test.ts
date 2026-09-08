import { expect, it } from "vitest";
import { parseIstanbulEvidence } from "./evidence-coverage.js";

it("accepts open-ended V8 columns for line and branch counts without fabricating exact columns", () => {
    const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: null } };
    const report = { "index.js": { statementMap: { 0: loc }, s: { 0: 1 }, fnMap: { 0: { loc } }, f: { 0: 1 },
        branchMap: { 0: { type: "if", loc, locations: [loc, { start: {}, end: {} }] } }, b: { 0: [1, 0] } } };
    expect(parseIstanbulEvidence(report, "/repo")[0]).toMatchObject({ lines: { total: 1, covered: 1 }, branches: { total: 2, covered: 1 }, functions: { total: 1, covered: 1 } });
    const invalid = structuredClone(report); invalid["index.js"].statementMap[0].start.line = 0;
    expect(() => parseIstanbulEvidence(invalid, "/repo")).toThrow("Invalid source span");
});
