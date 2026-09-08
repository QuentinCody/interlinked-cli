import { describe, expect, it } from "vitest";
import { parseImportedLint } from "./parsers.js";

const REPORTS = [
    { tool: "pylint", report: [{ path: "a.py", line: 2, "message-id": "W0611", message: "Unused import", type: "warning" }], rule: "W0611", file: "a.py" },
    { tool: "shellcheck", report: { comments: [{ file: "a.sh", line: 2, code: 2086, message: "Double quote" }] }, rule: "SC2086", file: "a.sh" },
    { tool: "hadolint", report: [{ file: "Dockerfile", line: 2, code: "DL3006", message: "Pin image" }], rule: "DL3006", file: "Dockerfile" },
    { tool: "actionlint", report: [{ filepath: "ci.yml", line: 2, kind: "expression", message: "Invalid expression" }], rule: "expression", file: "ci.yml" },
    { tool: "phpcs", report: { files: { "a.php": { messages: [{ line: 2, source: "Generic.CodeAnalysis.EmptyStatement", message: "Empty statement" }] } } }, rule: "Generic.CodeAnalysis.EmptyStatement", file: "a.php" },
    { tool: "phpstan", report: { totals: { errors: 0 }, errors: [], files: { "a.php": { messages: [{ line: 2, identifier: "variable.undefined", message: "Undefined variable" }] } } }, rule: "variable.undefined", file: "a.php" },
    { tool: "psalm", report: [{ file_name: "a.php", line_from: 2, type: "UnusedVariable", message: "Unused variable" }], rule: "UnusedVariable", file: "a.php" },
    { tool: "sqlfluff", report: [{ filepath: "a.sql", violations: [{ start_line_no: 2, code: "LT01", description: "Spacing" }] }], rule: "LT01", file: "a.sql" },
    { tool: "semgrep", report: { errors: [], results: [{ path: "a.ts", start: { line: 2 }, check_id: "no-eval", extra: { message: "Avoid eval" } }] }, rule: "no-eval", file: "a.ts" },
    { tool: "standardrb", report: { files: [{ path: "a.rb", offenses: [{ cop_name: "Style/StringLiterals", message: "Use single quotes", location: { start_line: 2 } }] }] }, rule: "Style/StringLiterals", file: "a.rb" },
];

describe("additional analyzer report contracts", () => {
    it.each(REPORTS)("normalizes $tool source/rule attribution", ({ tool, report, rule, file }) => {
        const parsed = parseImportedLint({ tool, output: JSON.stringify(report) });
        expect(parsed).toEqual([expect.objectContaining({ file, line: 2, rule })]);
        expect(parsed[0]?.message.length).toBeGreaterThan(0);
    });
    it.each(REPORTS)("refuses truncated or malformed $tool output", ({ tool }) => {
        expect(() => parseImportedLint({ tool, output: "{" })).toThrow();
        expect(() => parseImportedLint({ tool, output: "{}" })).toThrow();
    });
    it.each([
        { tool: "pylint", report: [{ path: "a.py", line: 2, "message-id": "E0001", message: "Parse error" }] },
        { tool: "shellcheck", report: { comments: [{ file: "a.sh", line: 2, code: 1073, message: "Parse error" }] } },
        { tool: "hadolint", report: [{ file: "Dockerfile", line: 2, code: "DL1000", message: "Parse error" }] },
        { tool: "phpstan", report: { totals: { errors: 1 }, errors: ["Internal error"], files: {} } },
        { tool: "semgrep", report: { errors: [{ message: "Timeout" }], results: [] } },
        { tool: "sqlfluff", report: [{ filepath: "a.sql", violations: [{ code: "PRS", start_line_no: 2, description: "Parse error" }] }] },
    ])("does not baseline $tool analysis failures", ({ tool, report }) => {
        expect(() => parseImportedLint({ tool, output: JSON.stringify(report) })).toThrow();
    });
    it("reads mypy JSON lines and flake8's fixed tab-separated reporter", () => {
        expect(parseImportedLint({ tool: "mypy", output: '{"file":"a.py","line":2,"code":"arg-type","message":"Invalid argument","severity":"error"}\n' })).toEqual([{ file: "a.py", line: 2, rule: "arg-type", message: "Invalid argument" }]);
        expect(parseImportedLint({ tool: "flake8", output: "a.py\t2\tF401\tUnused import\n" })).toEqual([{ file: "a.py", line: 2, rule: "F401", message: "Unused import" }]);
        expect(parseImportedLint({ tool: "mypy", output: "" })).toEqual([]);
        expect(parseImportedLint({ tool: "flake8", output: "" })).toEqual([]);
    });
    it("normalizes formatter filenames without parsing human summaries", () => {
        expect(parseImportedLint({ tool: "prettier", output: "src/a file.ts\n" })).toEqual([{ file: "src/a file.ts", line: 1, rule: "format", message: "File does not match the configured formatting rules" }]);
        expect(parseImportedLint({ tool: "prettier", output: "" })).toEqual([]);
    });
});
