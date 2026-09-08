import { describe, expect, it } from "vitest";
import { parseImportedLint } from "./parsers.js";

describe("imported analyzer protocols", () => {
    it("reads Oxlint native and JavaScript plugin diagnostics, preserving their rule IDs", () => {
        const diagnostics = ["eslint(no-debugger)", "anti-slop(no-unknown-type-alias)"].map((code) => ({ filename: "src/a.ts", code, message: "finding", labels: [{ span: { line: 2, column: 3 } }] }));
        const rows = parseImportedLint({ tool: "oxlint", output: JSON.stringify({ number_of_files: 1, diagnostics }) });
        expect(rows.map((row) => row.rule)).toEqual(diagnostics.map((row) => row.code));
        expect(rows[0]).toMatchObject({ file: "src/a.ts", line: 2 });
        expect(parseImportedLint({ tool: "oxlint", output: '{"number_of_files":1,"diagnostics":[]}' })).toEqual([]);
    });
    it.each([
        { number_of_files: 0, diagnostics: [] },
        { number_of_files: 1 },
        { number_of_files: 1, diagnostics: [{ filename: "a.js", message: "parse error", labels: [{ span: { line: 1 } }] }] },
        { number_of_files: 1, diagnostics: [{ filename: "a.js", code: "rule", message: "finding", labels: [] }] },
    ])("refuses unusable Oxlint reports rather than treating them as clean: %j", (report) => {
        expect(() => parseImportedLint({ tool: "oxlint", output: JSON.stringify(report) })).toThrow();
    });
    it.each([
        ["biome", { summary: { skipped: 0, diagnosticsNotPrinted: 0 }, diagnostics: [{ category: "lint/suspicious/noConsole", message: "console", location: { path: "a.js", start: { line: 1 } } }] }, "lint/suspicious/noConsole"],
        ["eslint", [{ filePath: "a.js", messages: [{ ruleId: "no-eval", line: 1, message: "avoid eval", severity: 1 }] }], "no-eval"],
        ["ruff", [{ filename: "a.py", location: { row: 1 }, code: "F401", message: "unused" }], "F401"],
        ["golangci-lint", { Issues: [{ Pos: { Filename: "a.go", Line: 1 }, FromLinter: "staticcheck", Text: "SA1000: bad expression" }] }, "staticcheck"],
        ["swiftlint", [{ file: "a.swift", line: 1, rule_id: "force_cast", reason: "avoid cast" }], "force_cast"],
        ["rubocop", { files: [{ path: "a.rb", offenses: [{ location: { start_line: 1 }, cop_name: "Lint/UnusedMethodArgument", message: "unused" }] }] }, "Lint/UnusedMethodArgument"],
        ["stylelint", [{ source: "a.css", warnings: [{ line: 1, rule: "block-no-empty", text: "empty" }], parseErrors: [] }], "block-no-empty"],
    ])("preserves %s diagnostic identity and location", (tool, report, rule) => {
        const rows = parseImportedLint({ tool: String(tool), output: JSON.stringify(report) });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ line: 1, rule });
    });
    it("requires a completed Cargo build and retains Clippy warnings", () => {
        const message = JSON.stringify({ reason: "compiler-message", message: { level: "warning", code: { code: "clippy::unwrap_used" }, message: "unwrap", spans: [{ file_name: "src/lib.rs", line_start: 1, is_primary: true }] } });
        const finished = JSON.stringify({ reason: "build-finished", success: true });
        expect(parseImportedLint({ tool: "clippy", output: `${message}\n${finished}\n` })).toEqual([{ file: "src/lib.rs", line: 1, rule: "clippy::unwrap_used", message: "unwrap" }]);
        expect(() => parseImportedLint({ tool: "clippy", output: message })).toThrow("did not complete");
    });
    it("does not treat malformed or incomplete reports as clean", () => {
        expect(() => parseImportedLint({ tool: "ruff", output: "truncated [" })).toThrow("Invalid lint JSON; no verdict");
        expect(() => parseImportedLint({ tool: "eslint", output: "{}" })).toThrow("array");
        expect(() => parseImportedLint({ tool: "eslint", output: '[{"filePath":"a.js","messages":[{"ruleId":null,"line":1,"message":"parse failure"}]}]' })).toThrow("Incomplete");
    });
});
