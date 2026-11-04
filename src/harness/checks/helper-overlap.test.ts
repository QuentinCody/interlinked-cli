import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeHelperOverlap, collectSiblingOverlapSources, HELPER_OVERLAP_LIMITS, matchPartialHelperOverlaps } from "./helper-overlap.js";
import { checkExtractedHelperDuplicate, findExtractedHelperDuplicates } from "./helper-hygiene.js";
import { extractFunctionShingles } from "./dry.js";
import { DEFAULT_ADVISORY_SKIPS } from "../../commands/verify/advisory.js";

const A = "/repo/src/a.ts";
const B = "/repo/src/b.ts";
const body = `const first = input.value;
const next = first + 1;
output.push(next);
output.push(first);
return output;`;
const source = (name: string, text = body) => `function ${name}(input: any, output: any[]) {\n${text}\n}`;
function matches(left = source("fresh"), right = source("existing"), otherFile = B) {
    return matchPartialHelperOverlaps(analyzeHelperOverlap(left, A), [analyzeHelperOverlap(right, otherFile)], new Set(["fresh"]));
}
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("partial helper overlap evidence", () => {
    it("MUST-FIRE: a shared five-statement block survives different surrounding logic and alpha renames", () => {
        const right = source("existing", `if (input.stop) throw new Error('stop');\n${body.replaceAll("first", "value").replaceAll("next", "plusOne").replaceAll("output", "result")}`).replace("output: any[]", "result: any[]");
        expect(matches(source("fresh"), right)).toHaveLength(1);
    });
    it("MUST-FIRE: comments and formatting do not change structural evidence", () => {
        expect(matches(source("fresh", body.replace("const next", "/* keep literal identity */\nconst next")))).toHaveLength(1);
    });
    it.each([
        ["literal", body.replace("+ 1", "+ 2")],
        ["property", body.replace("input.value", "input.other")],
        ["operator", body.replace("+ 1", "- 1")],
        ["binding relationship", body.replace("output.push(first)", "output.push(next)")],
    ])("MUST-NOT-FIRE: changed %s", (_name, text) => expect(matches(source("fresh", text))).toEqual([]));
    it("MUST-NOT-FIRE: different shorthand keys are not alpha-renamed", () => {
        const text = body.replace("output.push(next)", "output.push({next})");
        expect(matches(source("fresh", text), source("existing", text.replaceAll("next", "later")))).toEqual([]);
    });
    it("MUST-NOT-FIRE: object destructuring shorthand keeps its property identity", () => {
        const text = body.replace("const first = input.value", "const {first} = input");
        expect(matches(source("fresh", text), source("existing", text.replaceAll("first", "other")))).toEqual([]);
    });
    it("MUST-FIRE: alpha-renaming shadowed bindings preserves their distinct symbols", () => {
        const left = `let x = input.value;\n{ let x = 1; output.push(x); }\noutput.push(x);\noutput.push(input);\nreturn output;`;
        const right = `let a = input.value;\n{ let b = 1; output.push(b); }\noutput.push(a);\noutput.push(input);\nreturn output;`;
        expect(matches(source("fresh", left), source("existing", right))).toHaveLength(1);
        expect(matches(source("fresh", left), source("existing", right.replace("output.push(b)", "output.push(a)")))).toEqual([]);
    });
    it("MUST-NOT-FIRE: module bindings with the same spelling are not the same identity", () => {
        const text = body.replace("first + 1", "first + offset");
        expect(matches("const offset = 1;\n" + source("fresh", text), "const offset = 2;\n" + source("existing", text))).toEqual([]);
    });
    it("MUST-FIRE: the same imported binding can be aliased locally", () => {
        const left = "import { offset as step } from './shared.js';\n" + source("fresh", body.replace("+ 1", "+ step"));
        const right = "import { offset as increment } from './shared.js';\n" + source("existing", body.replace("+ 1", "+ increment"));
        expect(matches(left, right)).toHaveLength(1);
        expect(matches(left, right.replace("./shared.js", "./different.js"))).toEqual([]);
    });
    it("MUST-NOT-FIRE: same-file and different-directory candidates", () => {
        expect(matches(source("fresh"), source("existing"), A)).toEqual([]);
        expect(matches(source("fresh"), source("existing"), "/repo/elsewhere/b.ts")).toEqual([]);
    });
    it.each(["import './b.js';", "export * from './b.js';", "const dependency = require('./b');", "import('./b.js');"])("MUST-NOT-FIRE: direct edge %s", edge => {
        expect(matches(edge + source("fresh"))).toEqual([]);
        expect(matches(source("fresh"), edge.replaceAll("./b", "./a") + source("existing"))).toEqual([]);
    });
    it.each(["break", "continue"])("MUST-NOT-FIRE: %s escapes its candidate window", jump => {
        const text = `while (input) { const first = 1; output.push(first); output.push(2); output.push(3); ${jump}; }`;
        expect(matches(source("fresh", text), source("existing", text))).toEqual([]);
    });
    it("MUST-FIRE: a break whose target is wholly inside a statement window is retained", () => {
        const text = body.replace("output.push(next);", "while (next) { break; }");
        expect(matches(source("fresh", text), source("existing", text))).toHaveLength(1);
    });
    it("MUST-NOT-FIRE: syntactically invalid proposed source is unavailable", () => {
        const parsed = analyzeHelperOverlap(source("fresh") + " const broken = ;", A);
        expect(parsed.unavailable).toBe("parse-error");
        expect(parsed.windows).toEqual([]);
    });
    it("MUST-NOT-FIRE: fewer than five statements", () => {
        expect(matches(source("fresh", body.split("\n").slice(1).join("\n")), source("existing"))).toEqual([]);
    });
    it("MUST-NOT-FIRE: a preexisting function or no-op edit does not acquire a partial finding", () => {
        const current = source("fresh"); const siblings = vi.fn(() => [analyzeHelperOverlap(source("existing"), B)]);
        expect(findExtractedHelperDuplicates({ content: current, preContent: current, filePath: A }, () => [], siblings)).toEqual([]);
        expect(siblings).not.toHaveBeenCalled();
        expect(findExtractedHelperDuplicates({ content: current + "\nconst unrelated = 1;", preContent: current, filePath: A }, () => [], siblings)).toEqual([]);
    });
    it("MUST-FIRE: a newly introduced function gets advisory review wording", () => {
        const findings = findExtractedHelperDuplicates({ content: source("fresh"), preContent: "", filePath: A }, () => [], () => [analyzeHelperOverlap(source("existing"), B)]);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.text).toContain("preserve behavioral differences");
        expect(findings[0]?.text).not.toContain("import it instead");
        expect(DEFAULT_ADVISORY_SKIPS.has("extracted_helper_duplicate")).toBe(true);
    });
    it("MUST-NOT-FIRE twice: existing whole-body move finding suppresses partial evidence", () => {
        const text = source("same");
        const findings = findExtractedHelperDuplicates({ content: text, preContent: "", filePath: A }, () => extractFunctionShingles(text, B), () => [analyzeHelperOverlap(text, B)]);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.text).toContain("move in progress");
    });
    it("MUST-NOT-FIRE: work caps stop pathological files and sibling lists", () => {
        const huge = analyzeHelperOverlap(source("fresh", "output.push(1);\n".repeat(1000)), A);
        expect(huge.truncated).toBe(true);
        expect(huge.visited).toBeLessThanOrEqual(HELPER_OVERLAP_LIMITS.nodes);
        expect(huge.windows.length).toBeLessThanOrEqual(HELPER_OVERLAP_LIMITS.windows);
        expect(analyzeHelperOverlap(" ".repeat(HELPER_OVERLAP_LIMITS.bytes + 1), A).windows).toEqual([]);
        const empty = analyzeHelperOverlap("", B); const match = analyzeHelperOverlap(source("existing"), B);
        expect(matchPartialHelperOverlaps(analyzeHelperOverlap(source("fresh"), A), [...Array.from({ length: 40 }, () => empty), match], new Set(["fresh"]))).toEqual([]);
    });
    it("MUST-FIRE: disk wrapper reads current baseline and bounded sibling source", () => {
        const dir = mkdtempSync(join(tmpdir(), "partial-helper-")); directories.push(dir);
        const target = join(dir, "a.ts"); writeFileSync(target, "");
        writeFileSync(join(dir, "b.ts"), source("existing", "if (input.stop) throw new Error('stop');\n" + body.replaceAll("first", "aValue").replaceAll("next", "aNext")));
        const findings = checkExtractedHelperDuplicate(source("fresh"), target, dir);
        expect(findings.some(x => x.text.includes("structural overlap"))).toBe(true);
        expect(collectSiblingOverlapSources(target)).toHaveLength(1);
        writeFileSync(target, source("fresh"));
        expect(checkExtractedHelperDuplicate(source("fresh"), target, dir)).toEqual([]);
    });
});
