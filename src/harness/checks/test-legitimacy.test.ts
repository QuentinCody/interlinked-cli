import { describe, expect, it } from "vitest";
import type { InlineMatch } from "../check-registry/types.js";
import { checkTestLegitimacy, TRUNCATION_SUMMARY_PREFIX } from "./test-legitimacy.js";

const TEST_PATH = "src/lib/widget.test.ts";
const MUTATION_PATH = "src/lib/widget.mutation-kill.test.ts";

function check(content: string, filePath = TEST_PATH): InlineMatch[] {
    return checkTestLegitimacy(content, filePath);
}

describe("checkTestLegitimacy — file eligibility and contract grounding", () => {
    it("N1: ignores non-test files, even when they contain test-shaped text", () => {
        const found = check(
            "expect(value).toBeTruthy();\nimport { __privateThing } from \"./internal/api.js\";",
            "src/lib/widget.ts",
        );
        expect(found).toEqual([]);
    });

    it("N2: does not require a contract marker on an ordinary test file", () => {
        expect(check("it(\"renders\", () => expect(render()).toEqual(\"ok\"));")).toEqual([]);
    });

    it.each(["public-api", "invariant", "bug", "security", "boundary"])(
        "N3: accepts a specific %s contract marker for a mutation-directed test",
        (kind) => {
            const content = `// test-contract: ${kind} — widget renders the documented empty-state label\nit(\"covers the survivor\", () => expect(render()).toEqual(\"Empty\"));`;
            expect(check(content, MUTATION_PATH)).toEqual([]);
        },
    );

    it("P1: reports each mutation-directed test case without a contract marker", () => {
        const found = check(
            [
                "it(\"covers the survivor\", () => expect(render()).toEqual(\"Empty\"));",
                "it(\"covers another survivor\", () => expect(render()).toEqual(\"Ready\"));",
            ].join("\n"),
            MUTATION_PATH,
        );
        expect(found).toHaveLength(2);
        expect(found.map((match) => match.line)).toEqual([1, 2]);
        expect(found[0]?.text).toContain("contract");
    });

    it("P1b: keeps model-qualified mutation filenames inside the strict file class", () => {
        const found = check(
            "it(\"covers a Luna-targeted survivor\", () => expect(render()).toEqual(\"Ready\"));",
            "src/lib/widget.mutation-kill-luna.test.ts",
        );
        expect(found).toHaveLength(1);
        expect(found[0]?.text).toContain("missing test-contract");
    });

    it.each([
        "// test-contract: public-api",
        "// test-contract: performance — test public API",
        "// test-contract: unknown — test the mutation",
    ])("P2: reports a malformed or generic contract marker: %s", (marker) => {
        const found = check(`${marker}\nit(\"case\", () => expect(render()).toEqual(\"ok\"));`, MUTATION_PATH);
        expect(found).toHaveLength(1);
        expect(found[0]?.line).toBe(2);
        expect(found[0]?.text).toContain("it(");
    });

    it("P3: requires a marker for each mutation-directed test case", () => {
        const content = [
            "// test-contract: public-api — widget renders the documented empty-state label",
            "it(\"grounded case\", () => expect(render()).toEqual(\"Empty\"));",
            "",
            "it(\"ungrounded case\", () => expect(render()).toEqual(\"Ready\"));",
        ].join("\n");
        const found = check(content, MUTATION_PATH);
        expect(found).toHaveLength(1);
        expect(found[0]?.line).toBe(4);
        expect(found[0]?.text).toContain("ungrounded");
    });

    it("N4: maps a marker across a small blank-line/decorator window to its case", () => {
        const content = [
            "// test-contract: boundary — decorated case handles the empty input boundary",
            "",
            "@caseMetadata(\"empty\")",
            "it(\"decorated case\", () => expect(render([])).toEqual(\"Empty\"));",
        ].join("\n");
        expect(check(content, MUTATION_PATH)).toEqual([]);
    });
});

describe("checkTestLegitimacy — assertion quality", () => {
    it("P4: flags broad truthiness assertions and incidental call-order assertions", () => {
        const content = [
            "it(\"accepts a result\", () => {",
            "    expect(result).toBeTruthy();",
            "    expect(error).toBeFalsy();",
            "    expect(spy).toHaveBeenNthCalledWith(2, \"payload\");",
            "    expect(spy.mock.invocationCallOrder[0]).toBe(1);",
            "});",
        ].join("\n");
        const found = check(content);
        expect(found.map((match) => match.line)).toEqual([2, 3, 4, 5]);
        expect(found.every((match) => match.text.length > 0)).toBe(true);
    });

    it("N5: does not flag exact equality assertions", () => {
        const found = check([
            "it(\"checks the label\", () => {",
            "    expect(label).toBe(\"Ready\");",
            "    expect(render()).toEqual({ status: \"ready\" });",
            "});",
        ].join("\n"));
        expect(found).toEqual([]);
    });
});

describe("checkTestLegitimacy — black-box and source hygiene", () => {
    it("P5: flags explicitly private symbols and internal/private module imports", () => {
        const content = [
            "import { __privateThing } from \"./api.js\";",
            "import { InternalParser } from \"./api.js\";",
            "import { parse } from \"../internal/parser.js\";",
            "import { render } from \"../private/render.js\";",
        ].join("\n");
        const found = check(content);
        expect(found.map((match) => match.line)).toEqual([1, 2, 3, 4]);
    });

    // test-contract: invariant — a quote inside a regex literal before an import is not a string opener; the private import that follows is still flagged (review 2026-09-30)
    it("P8: flags a private import that follows a regex literal containing a quote", () => {
        const found = check('const quote = /"/;\nimport { _parse } from "./private/parser";');
        expect(found.map((match) => match.line)).toEqual([2]);
        const returned = check('function pattern() { return /"/; }\nimport { _parse } from "./private/parser";');
        expect(returned.map((match) => match.line)).toEqual([2]);
    });
    // test-contract: invariant — valid TypeScript, JSX and regex contexts never hide a finding (review 2026-09-30, round 6): a JSX closing tag, a non-null assertion, a unicode identifier and the identifier `of` before a division keep the assertion visible; a regex after a control paren or after a comment-separated keyword still lets the private import on line 2 be flagged
    // test-contract: invariant — a fixture string holding `import(...)` at a line start is a rejected match start, and the scan resumes right after it, so the real private import that the rejected match had spanned is still flagged (review 2026-09-30, round 7)
    it("P10: a real private import after a multiline fixture containing an import is still flagged", () => {
        const content = ["const fixture = `", 'import("public")', "`;", 'import { _parse } from "./private/parser";'].join("\n");
        expect(check(content).map((match) => match.line)).toEqual([4]);
    });
    it("P9: JSX, non-null, unicode and `of` divisions keep the truthiness finding; control-paren and comment-separated regexes keep the import finding", () => {
        expect(check("const view = <div>{value}</div>; expect(view).toBeTruthy();", "src/lib/view.test.tsx").map((match) => match.line)).toEqual([1]);
        for (const division of ["count! / 2", "π / 2", "of / 2"]) {
            expect(check(`const half = ${division}; expect(half).toBeTruthy();`).map((match) => match.line), division).toEqual([1]);
        }
        expect(check('if (ready) /"/.test(text);\nimport { _parse } from "./private/parser";').map((match) => match.line)).toEqual([2]);
        expect(check('function f() { return/*comment*/typeof /"/; }\nimport { _parse } from "./private/parser";').map((match) => match.line)).toEqual([2]);
    });
    // test-contract: invariant — a division after a postfix operator is code, not a regex opener: the assertion after it stays visible and the file is judged on it (review 2026-09-30, round 5)
    it("N-division: a postfix-operator division does not hide the assertion that follows", () => {
        const withAssertion = "let count = 4; const half = count++ / 2; expect(half).toBeTruthy();";
        const withoutAssertion = "let count = 4; const half = count++ / 2;";
        // The truthiness assertion is the finding; with the division masked as a regex opener it vanished.
        expect(check(withAssertion).map((match) => match.line)).toEqual([1]);
        expect(check(withoutAssertion)).toEqual([]);
    });

    it("P7: flags a real require of an internal module", () => {
        const found = check("const parser = require('../internal/parser.js');");
        expect(found).toHaveLength(1);
        expect(found[0]?.line).toBe(1);
    });

    it("P6: flags formatter-shaped multiline imports containing __test_only__ at the import start", () => {
        const content = [
            "import {",
            "    render,",
            "    __test_only__,",
            "} from \"./widget.js\";",
        ].join("\n");
        const found = check(content);
        expect(found.map((match) => match.line)).toEqual([1]);
    });

    it("N7: ignores formatter-shaped multiline imports of ordinary public names", () => {
        const content = [
            "import {",
            "    render,",
            "    createWidget,",
            "} from \"./widget.js\";",
        ].join("\n");
        expect(check(content)).toEqual([]);
    });

    it("N6: ignores comments and string literals that merely mention suspicious patterns", () => {
        const content = [
            "// expect(result).toBeTruthy();",
            "const example = \"expect(result).toBeFalsy()\";",
            "const matcher = \"toHaveBeenNthCalledWith\";",
            "const fixture = \"../internal/parser.js\";",
        ].join("\n");
        expect(check(content)).toEqual([]);
    });

    it("N8: ignores import-shaped suspicious text in comments and strings", () => {
        const content = [
            "// import { __test_only__ } from \"./widget.js\";",
            "const template = `import { __test_only__ } from \"./widget.js\";`;",
            "const example = \"import { __test_only__ } from \\\"./widget.js\\\";\";",
        ].join("\n");
        expect(check(content)).toEqual([]);
    });

    it("N9: ignores require-shaped text in comments and strings", () => {
        const content = [
            "// const parser = require('../internal/parser.js');",
            "const example = \"require('../internal/parser.js')\";",
        ].join("\n");
        expect(check(content)).toEqual([]);
    });
});

// Followup #27: MAX_MATCHES capped the SCAN, so 43 real missing markers were
// reported as exactly 20 — an under-count that reads as "nearly done". The cap
// now bounds the listing only; the true total rides in a trailing summary.
describe("checkTestLegitimacy — listing cap reports a true count", () => {
    const unmarkedCases = (n: number): string =>
        Array.from({ length: n }, (_, i) => `it("case ${i}", () => expect(render()).toEqual("ok"));`).join("\n");

    it("P8: 43 unmarked mutation-directed cases list 20 and report all 43", () => {
        const found = check(unmarkedCases(43), MUTATION_PATH);
        const listed = found.filter((m) => m.text.startsWith("missing test-contract"));
        expect(listed).toHaveLength(20);
        const summary = found[found.length - 1];
        expect(summary?.text).toContain(TRUNCATION_SUMMARY_PREFIX);
        expect(summary?.text).toContain("23 more");
        expect(summary?.text).toContain("43 test-legitimacy finding(s)");
        expect(summary?.line).toBe(20);
    });

    it("P9: the summary counts brittle-assertion findings too, not just contract markers", () => {
        const content = Array.from({ length: 25 }, () => "expect(value).toBeTruthy();").join("\n");
        const found = check(content, TEST_PATH);
        expect(found).toHaveLength(21);
        expect(found[20]?.text).toContain("25 test-legitimacy finding(s)");
    });

    it("N10: exactly 20 findings list all 20 with NO summary line", () => {
        const found = check(unmarkedCases(20), MUTATION_PATH);
        expect(found).toHaveLength(20);
        expect(found.some((m) => m.text.startsWith(TRUNCATION_SUMMARY_PREFIX))).toBe(false);
    });

    it("N11: an under-cap file is unchanged — no summary, exact lines", () => {
        const found = check(unmarkedCases(3), MUTATION_PATH);
        expect(found).toHaveLength(3);
        expect(found.map((m) => m.line)).toEqual([1, 2, 3]);
    });
});
