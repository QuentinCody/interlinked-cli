import { expect, it } from "vitest";
import { parseRadonJson } from "./cyclomatic-python.js";

it("counts a method once when Radon also lists it outside its class", () => {
    const method = { type: "method", name: "answer", lineno: 3, endline: 5, complexity: 2 };
    const other = { ...method, lineno: 9, endline: 11 };
    const result = parseRadonJson(JSON.stringify({ "service.py": [
        { type: "class", name: "Service", lineno: 1, endline: 5, complexity: 3, methods: [method] },
        method, other,
    ] }));
    expect(result).toEqual([
        { name: "answer", line: 3, endLine: 5, cyclomatic: 2, language: "python" },
        { name: "answer", line: 9, endLine: 11, cyclomatic: 2, language: "python" },
    ]);
});
