import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeExpressions, expressionReadabilityChecks, introducedReadability, parseExpressionLimits } from "./expression-readability.js";
import { checkExpressionSize, checkInlineCallbackCount, checkControlFlowDepth, checkRequiredBraces, checkStatementsPerLine, checkExpressionMeasurement } from "./expression-readability.js";

const FILE = "/expression-readability-fixture/example.ts";
const NESTED = 'const missing = project.scenarios.flatMap(scenario => scenario.contractIds.filter(id => !manifest.cases.some(row => row.id === id)).map(id => `${scenario.id} → ${id}`));';

describe("expression readability", () => {
    it("attributes a regression to the growing return when another return shrinks", () => {
        const sum = (count: number): string => Array.from({ length: count }, () => "term").join(" + ");
        const before = `function total(flag) { if(flag) { return ${sum(31)}; }\nreturn ${sum(50)}; }`;
        const after = `function total(flag) { if(flag) { return ${sum(32)}; }\nreturn ${sum(49)}; }`;
        expect(introducedReadability(before, after, FILE).filter(item => item.check === "expression_size"))
            .toMatchObject([{ line: 1, value: 63 }]);
    });
    it("P1: expression-size registry bridge flags a large computation", () => {
        expect(checkExpressionSize(`const total = ${Array.from({ length: 35 }, (_, i) => `part${i}`).join(" + ")};`, FILE)).toHaveLength(1);
    });
    it("N1: expression-size registry bridge does not flag literal data", () => {
        expect(checkExpressionSize(`const labels = [${Array.from({ length: 100 }, () => '"label"').join(",")}];`, FILE)).toEqual([]);
    });
    it("P2: callback-count registry bridge flags the supplied nested reference lookup", () => {
        expect(checkInlineCallbackCount(NESTED, FILE)).toHaveLength(1);
    });
    it("N2: callback-count registry bridge accepts a named pipeline", () => {
        expect(checkInlineCallbackCount("const result = items.filter(isRequired).map(toName);", FILE)).toEqual([]);
    });
    it("P3: control-depth registry bridge flags four nested branches", () => {
        expect(checkControlFlowDepth("if(a){if(b){if(c){if(d){run();}}}}", FILE)).toHaveLength(1);
    });
    it("N3: control-depth registry bridge accepts three nested branches", () => {
        expect(checkControlFlowDepth("if(a){if(b){if(c){run();}}}", FILE)).toEqual([]);
    });
    it("P4: brace registry bridge flags an unbraced loop", () => {
        expect(checkRequiredBraces("for (const item of items)\n run(item);", FILE)).toHaveLength(1);
    });
    it("N4: brace registry bridge accepts an explicit loop body", () => {
        expect(checkRequiredBraces("for (const item of items) { run(item); }", FILE)).toEqual([]);
    });
    it("P5: statement registry bridge flags same-line sibling actions", () => {
        expect(checkStatementsPerLine("read(); validate();", FILE)).toHaveLength(1);
    });
    it("N5: statement registry bridge accepts separate lines", () => {
        expect(checkStatementsPerLine("read();\nvalidate();", FILE)).toEqual([]);
    });
    it("P6: measurement registry bridge reports malformed syntax unavailable", () => {
        expect(checkExpressionMeasurement("const broken = (", FILE)).toMatchObject([{ text: expect.stringContaining("NOT CHECKED") }]);
    });
    it("N6: measurement registry bridge stays silent for exact syntax", () => {
        expect(checkExpressionMeasurement("const value = 1;", FILE)).toEqual([]);
    });
    it("detects worsening below an unchanged initializer line, but not formatting or movement", () => {
        const before = "const result = outer.map(x =>\n inner.filter(y => y.ok)\n);";
        const after = "const result = outer.map(x =>\n inner.filter(y => third.some(z => z.ok))\n);";
        expect(introducedReadability(before, after, FILE).map(item => item.check)).toContain("ubs_deeply_nested_callback");
        expect(introducedReadability(after, "\n" + after.replace("third.some", "third\n.some"), FILE)).toEqual([]);
    });

    it("requires braces and one sibling statement per line without counting for headers", () => {
        expect(expressionReadabilityChecks("for (let i=0; i<2; i++) {\n run(i);\n}", FILE)).toEqual([]);
        const findings = expressionReadabilityChecks("if (ready)\n run();\nconst a = 1; const b = 2;", FILE);
        expect(findings.map(item => item.check).sort()).toEqual(["required_braces", "statements_per_line"]);
    });

    it("validates configuration and keeps unspecified defaults", () => {
        expect(parseExpressionLimits('{"version":1,"limits":{"expressionTokens":90}}').expressionTokens).toBe(90);
        for (const limits of ['{"callbackDepth":0}', '{"callbackDepth":2.5}', '{"unknown":2}']) {
            expect(() => parseExpressionLimits(`{"version":1,"limits":${limits}}`)).toThrow();
        }
    });

    it("allows single-line guards but diagnoses multiline bodies, including wrapped expressions", () => {
        expect(checkRequiredBraces("function f() { if (!ready) return fail(); }", FILE)).toEqual([]);
        expect(checkRequiredBraces("if (ready) run(\n first, second);", FILE)).toHaveLength(1);
        expect(checkRequiredBraces("if (\n ready\n) run();", FILE)).toEqual([]);
        expect(checkRequiredBraces("if (ready)\n /* reason */ run();", FILE)).toHaveLength(1);
    });

    it("defers brace style to the target repository without executing its config", () => {
        const root = mkdtempSync(join(tmpdir(), "readability-policy-"));
        try {
            mkdirSync(join(root, ".git"));
            const file = join(root, "a.ts");
            expect(checkRequiredBraces("if (ok)\n run();", file)).toHaveLength(1);
            expect(introducedReadability("", "if (ok)\n run();", file).map(item => item.check)).toContain("required_braces");
            writeFileSync(join(root, "eslint.config.mjs"), "throw new Error('do not execute config');");
            expect(checkRequiredBraces("if (ok)\n run();", file)).toEqual([]);
            expect(introducedReadability("", "if (ok)\n run();", file).map(item => item.check)).not.toContain("required_braces");
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("counts executable template interpolations and resets control flow at function boundaries", () => {
        const template = 'const output = `${items.map(a => a.filter(b => b.some(c => c.ok)))}`;';
        expect(expressionReadabilityChecks(template, FILE).map(item => item.check)).toContain("ubs_deeply_nested_callback");
        const source = "if(a){ if(b){ if(c){ if(d){ work(); } } } }";
        expect(expressionReadabilityChecks(source, FILE).find(item => item.check === "control_flow_depth")?.value).toBe(4);
        expect(expressionReadabilityChecks("if(a){ if(b){ if(c){ const f = () => { if(d){ work(); } }; } } }", FILE).filter(item => item.check === "control_flow_depth")).toEqual([]);
    });
    it("measures branch-free expression callbacks independently of expression size", () => {
        const report = analyzeExpressions(NESTED, FILE);
        expect(report.status).toBe("measured");
        expect(report.expressions.find(item => item.label === "missing")).toMatchObject({
            syntaxTokens: 46, inlineCallbacks: 4, maxCallbackDepth: 3,
        });
        expect(expressionReadabilityChecks(NESTED, FILE).map(item => item.check)).toEqual([
            "ubs_deeply_nested_callback", "inline_callback_count",
        ]);
    });

    it("keeps token measurements independent of whitespace and descriptive identifier length", () => {
        const compact = analyzeExpressions("const x = a.filter(x => x.ready);", FILE);
        const expanded = analyzeExpressions("const readableName =\n collection.filter(\n candidate => candidate.ready\n );", FILE);
        expect(compact.expressions[0]?.syntaxTokens).toBe(expanded.expressions[0]?.syntaxTokens);
    });

    it("does not penalize named pipelines or literal lookup data", () => {
        const data = `const labels = { ${Array.from({ length: 100 }, (_, i) => `key${i}: "value"`).join(",")} };`;
        expect(expressionReadabilityChecks(data, FILE)).toEqual([]);
        expect(expressionReadabilityChecks("const result = items.filter(isRequired).map(toRequirement);", FILE)).toEqual([]);
    });

    it("measures multiline ternaries without confusing optional types, regexes or literal text", () => {
        const source = "const x = a ? b :\n c ? d : e;\ntype Maybe = { a?: string };\nconst pattern = /a?b?/;";
        expect(expressionReadabilityChecks(source, FILE).filter(item => item.check === "nested_ternaries")).toHaveLength(1);
        expect(expressionReadabilityChecks('const text = "? ? => =>";', FILE)).toEqual([]);
    });

    it("reports unavailable syntax and unsupported languages instead of a clean measurement", () => {
        expect(analyzeExpressions("const broken = (", FILE).status).toBe("unavailable");
        expect(analyzeExpressions("x = 1", "example.py").status).toBe("unsupported");
    });

    it("inspects computation inside test callbacks without charging describe/it nesting", () => {
        const source = `describe("suite", () => { describe("nested", () => { it("works", () => { ${NESTED} }); }); });`;
        const findings = expressionReadabilityChecks(source, "src/example.test.ts");
        expect(findings.filter(item => item.check === "ubs_deeply_nested_callback")).toHaveLength(1);
        expect(findings.find(item => item.check === "ubs_deeply_nested_callback")?.label).toBe("missing");
    });

    it("groups oversized nested arguments into the containing actionable expression", () => {
        const source = "const answer = outer(inner(a + b + c + d + e + f));";
        const findings = expressionReadabilityChecks(source, FILE, { expressionTokens: 8 });
        expect(findings.filter(item => item.check === "expression_size")).toHaveLength(1);
        expect(findings[0]?.label).toBe("answer");
    });
});
