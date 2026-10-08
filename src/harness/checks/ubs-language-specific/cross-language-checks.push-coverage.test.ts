import { expect, it } from "vitest";
import { checkSqlEscapeHatchNonLiteral, checkUbsHardcodedLocalhost } from "./cross-language-checks.js";

it("bounds repeated hardcoded endpoint findings to the first ten source lines", () => {
    const line = 'fetch("http://localhost:8787/api");';
    expect(checkUbsHardcodedLocalhost(Array(12).fill(line).join("\n"), "src/client.ts")).toEqual(
        Array.from({ length: 10 }, (_, index) => ({ line: index + 1, text: line })),
    );
});

it("reports the original SQL call line after multiline comments are stripped", () => {
    const source = "/* documented example\n sql.raw(example);\n */\n  sql.raw(userInput); // request input\n";
    expect(checkSqlEscapeHatchNonLiteral(source, "src/query.ts")).toEqual([{
        line: 4,
        text: "SQL escape hatch (sql.raw() called with non-literal argument — should only wrap compile-time constants (schema names, etc.): sql.raw(userInput); // request input",
    }]);
});
