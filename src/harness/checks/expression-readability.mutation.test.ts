import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    analyzeExpressions, checkExpressionMeasurement, checkExpressionSize, checkInlineCallbackCount,
    checkRequiredBraces, expressionReadabilityChecks, parseExpressionLimits,
} from "./expression-readability.js";

// Behavior basis: docs/expression-readability.md (measurement contract table, boundary list,
// "Optional project policy", and the brace-config paragraph).
const FILE = "/expression-readability-fixture/example.ts";

function boundaries(source: string, file = FILE): string[] {
    return analyzeExpressions(source, file).expressions.map(item => `${item.boundary}:${item.label}`);
}

function withRepo(run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "readability-mutation-"));
    try {
        mkdirSync(join(root, ".git"));
        run(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("expression readability mutation hardening: callbacks", () => {
    it("counts function expressions passed as call arguments as inline callbacks", () => {
        const source = "const r = a.map(function (x) { return x; }).filter(function (y) { return y; }).some(function (z) { return z; });";
        expect(checkInlineCallbackCount(source, FILE)).toHaveLength(1);
    });
    it("counts callbacks passed as new-expression arguments as inline callbacks", () => {
        expect(checkInlineCallbackCount("const r = new Group(x => 1, y => 2, z => 3);", FILE)).toHaveLength(1);
    });
    it("resets callback count and depth at a function that is not an inline callback", () => {
        const report = analyzeExpressions("const r = { run: () => items.map(x => x).filter(y => y).some(z => z) };", FILE);
        expect(report.expressions.find(item => item.label === "r")).toMatchObject({ inlineCallbacks: 0, maxCallbackDepth: 0 });
    });
    it("resets conditional depth at a function boundary inside a conditional", () => {
        const report = analyzeExpressions("const v = a ? () => (b ? 1 : 2) : 3;", FILE);
        expect(report.expressions.find(item => item.label === "v")?.conditionalDepth).toBe(1);
        expect(expressionReadabilityChecks("const v = a ? () => (b ? 1 : 2) : 3;", FILE).map(item => item.check)).not.toContain("nested_ternaries");
    });
    it("does not flag a single conditional expression as nested", () => {
        expect(expressionReadabilityChecks("const x = a ? b : c;", FILE).map(item => item.check)).not.toContain("nested_ternaries");
    });
});

describe("expression readability mutation hardening: literal data classification", () => {
    const classify = (source: string): string | undefined => analyzeExpressions(source, FILE).expressions.find(item => item.label === "v")?.classification;
    it("classifies a signed numeric literal as literal data", () => {
        expect(classify("const v = +1;")).toBe("literal-data");
        expect(classify("const v = -1;")).toBe("literal-data");
    });
    it("classifies an array as literal data only when every element is literal", () => {
        expect(classify("const v = [1, 2];")).toBe("literal-data");
        expect(classify("const v = [1, compute()];")).toBe("computation");
    });
    it("classifies an object with a computed key as computation", () => {
        expect(classify("const v = { [key]: 1 };")).toBe("computation");
        expect(classify("const v = { key: 1 };")).toBe("literal-data");
    });
});

describe("expression readability mutation hardening: boundaries", () => {
    it("treats a thrown expression as a return boundary", () => {
        expect(boundaries("function f() { throw new Failure(code); }")).toContain("return:returned expression");
    });
    it("treats an expression-bodied arrow body as a return boundary", () => {
        expect(boundaries("const f = () => a + b;")).toContain("return:returned expression");
    });
    it("measures the assignment right-hand side, not the assignment target", () => {
        const assignment = analyzeExpressions("target = a + b + c;", FILE).expressions.filter(item => item.boundary === "assignment");
        expect(assignment).toHaveLength(1);
        expect(assignment[0]).toMatchObject({ label: "target", syntaxTokens: 5 });
    });
    it("treats a for-loop condition as a loop condition boundary", () => {
        expect(boundaries("for (let i = 0; i < limit; i++) { run(i); }")).toContain("condition:loop condition");
    });
});

describe("expression readability mutation hardening: test registration containers", () => {
    const NESTED_STATEMENT = "items.map(a => a.filter(b => b.some(c => c.ok)));";
    const REGISTRATION = `describe("s", () => { describe("n", () => { it("w", () => { run(); }); }); });`;
    it("treats .spec files as test paths whose registration calls are not charged", () => {
        const specFindings = expressionReadabilityChecks(REGISTRATION, "src/example.spec.ts");
        const sourceFindings = expressionReadabilityChecks(REGISTRATION, "src/example.ts");
        expect(sourceFindings.map(item => item.check)).toContain("ubs_deeply_nested_callback");
        expect(specFindings).toEqual([]);
    });
    it("still measures an ordinary statement inside a test file", () => {
        const findings = expressionReadabilityChecks(NESTED_STATEMENT, "src/example.test.ts");
        expect(findings.map(item => item.check)).toContain("ubs_deeply_nested_callback");
    });
    it("measures a registration-named call outside test paths but not inside them", () => {
        const statements = (file: string): number => boundaries(`it("w", () => { run(); });`, file).filter(item => item === "statement:expression statement").length;
        expect(statements("src/example.ts")).toBe(2);
        expect(statements("src/example.test.ts")).toBe(1);
    });
});

describe("expression readability mutation hardening: control-flow depth and limits", () => {
    it("does not count an else-if chain as additional nesting", () => {
        const source = "if (a) { run(); } else if (b) { run(); } else if (c) { run(); } else if (d) { run(); } else if (e) { run(); }";
        expect(expressionReadabilityChecks(source, FILE).filter(item => item.check === "control_flow_depth")).toEqual([]);
    });
    it("reports the deepest depth reached within one over-limit region", () => {
        const source = "if(a){if(b){if(c){if(d){if(e){run();}}}}}";
        const findings = expressionReadabilityChecks(source, FILE).filter(item => item.check === "control_flow_depth");
        expect(findings).toHaveLength(1);
        expect(findings[0]?.value).toBe(5);
    });
    it("applies caller-supplied limits when analyzing", () => {
        const report = analyzeExpressions("if (a) { if (b) { run(); } }", FILE, { controlFlowDepth: 1 });
        expect(report.structural.map(item => item.check)).toEqual(["control_flow_depth"]);
        expect(analyzeExpressions("if (a) { if (b) { run(); } }", FILE).structural).toEqual([]);
    });
    it("flags expression size only when tokens exceed the limit, not when equal", () => {
        const source = "const x = a + b;";
        expect(expressionReadabilityChecks(source, FILE, { expressionTokens: 3 }).filter(item => item.check === "expression_size")).toEqual([]);
        expect(expressionReadabilityChecks(source, FILE, { expressionTokens: 2 }).filter(item => item.check === "expression_size")).toHaveLength(1);
    });
    it("accepts a limit of 10000 and rejects 10001", () => {
        expect(parseExpressionLimits('{"version":1,"limits":{"expressionTokens":10000}}').expressionTokens).toBe(10000);
        expect(() => parseExpressionLimits('{"version":1,"limits":{"expressionTokens":10001}}')).toThrow();
    });
    it("rejects unknown top-level policy fields", () => {
        expect(() => parseExpressionLimits('{"version":1,"limits":{},"extra":1}')).toThrow();
    });
});

describe("expression readability mutation hardening: braces and style configuration", () => {
    const UNBRACED = "if (ok)\n run();";
    it("does not diagnose an else-if chain whose bodies are braced", () => {
        const source = "if (a) {\n run();\n} else if (b) {\n run();\n} else {\n run();\n}";
        expect(checkRequiredBraces(source, FILE)).toEqual([]);
    });
    it("defers brace style to a package.json prettier entry", () => {
        withRepo(root => {
            const file = join(root, "a.ts");
            expect(checkRequiredBraces(UNBRACED, file)).toHaveLength(1);
            writeFileSync(join(root, "package.json"), '{"name":"x","prettier":{}}');
            expect(checkRequiredBraces(UNBRACED, file)).toEqual([]);
        });
    });
    it("defers brace style to an adopted lint-import policy", () => {
        withRepo(root => {
            const file = join(root, "a.ts");
            mkdirSync(join(root, ".interlinked"));
            writeFileSync(join(root, ".interlinked", "lint-import.json"), "{}");
            expect(checkRequiredBraces(UNBRACED, file)).toEqual([]);
        });
    });
    it("does not inherit style configuration from above the git root", () => {
        const outer = mkdtempSync(join(tmpdir(), "readability-outer-"));
        try {
            const repo = join(outer, "repo");
            mkdirSync(join(repo, ".git"), { recursive: true });
            writeFileSync(join(outer, "eslint.config.mjs"), "export default [];");
            expect(checkRequiredBraces(UNBRACED, join(repo, "a.ts"))).toHaveLength(1);
        } finally { rmSync(outer, { recursive: true, force: true }); }
    });
    it("reports an invalid policy only as expression_measurement and stays silent for other checks", () => {
        withRepo(root => {
            const file = join(root, "a.ts");
            mkdirSync(join(root, ".interlinked"));
            writeFileSync(join(root, ".interlinked", "readability.json"), "{ not json");
            expect(checkExpressionMeasurement("const v = 1;", file)).toMatchObject([{ text: expect.stringContaining("NOT CHECKED") }]);
            expect(checkExpressionSize("const v = 1;", file)).toEqual([]);
        });
    });
});
