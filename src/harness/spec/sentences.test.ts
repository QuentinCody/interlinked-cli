import { describe, expect, it } from "vitest";
import { classifySpecSentence, parseSpecSentences, sentenceSpans } from "./sentences.js";
import { attachSentenceCitations } from "./sentence-citations.js";

describe("frozen sentence grammar", () => {
    it.each([
        ["The agent must preserve the file.", "requirement"],
        ["It may return the error.", "requirement"],
        ["It must stop.", "note"],
        ["Keep the file because the state must survive.", "rationale"],
        ["It must save the file, e.g. a manifest.", "example"],
        ["A descriptive note.", "note"],
    ] as const)("classifies %s as %s by the frozen precedence", (text, label) => expect(classifySpecSentence(text)).toBe(label));
    it("does not split abbreviations, decimals, inline code or URLs", () => {
        const text = "Use e.g. v2.5 at https://example.test/a. Then `x.y()` works!";
        expect(sentenceSpans(text).map(row => row.text)).toEqual([text]); // URL punctuation is protected conservatively.
        expect(sentenceSpans("It must save the file. Then stop!").map(row => row.text)).toEqual(["It must save the file.", "Then stop!"]);
    });
    it("does not emit a numbered-list marker as its own sentence", () => {
        const rows = parseSpecSentences("plan.md", "1. The command must save the file.\n2. The command must preserve the state.");
        expect(rows).toHaveLength(2);
        expect(rows.map(row => row.class)).toEqual(["requirement", "requirement"]);
    });
    it("keeps indented list continuations as prose and drops standalone table delimiters", () => {
        const rows = parseSpecSentences("plan.md", "- [ ] The command must save the file\n      before exiting.\n\n| It must preserve the state. |\n");
        expect(rows.map(row => row.class)).toEqual(["requirement", "requirement"]);
        expect(rows[0]).toMatchObject({ line: 1, endLine: 2 });
        expect(rows.some(row => row.sentence.trim() === "|")).toBe(false);
        expect(parseSpecSentences("plan.md", "Paragraph.\n\n    code();")[1]?.class).toBe("example");
    });
    it("keeps provenance, duplicate headings, Setext anchors and code examples", () => {
        const rows = parseSpecSentences("plan.md", "# Setup\nREQ-1: It must save the file.\nIt must preserve the state.\n\n# Setup\n```ts\nmust(file);\n```\n\nOther\n-----\nIt should return the error.");
        expect(rows).toHaveLength(4);
        expect(rows[0]).toMatchObject({ line: 2, endLine: 2, definitionIds: ["REQ-1"], anchors: ["setup"], class: "requirement" });
        expect(rows[1]).toMatchObject({ line: 3, endLine: 3 });
        expect(rows[2]).toMatchObject({ line: 6, endLine: 8, anchors: ["setup-1"], class: "example" });
        expect(rows[3]).toMatchObject({ line: 12, anchors: ["setup-1", "other"] });
        const moved = parseSpecSentences("plan.md", "\n# Setup\nREQ-1: It must save the file.");
        expect(moved[0]?.id).toBe(rows[0]?.id);
    });
    it("keeps ancestor anchors and ignores headings hidden in comments and fences", () => {
        const rows = parseSpecSentences("plan.md", "# Parent\n## Child\nIt must save the file.\n<!--\n# Hidden\n-->\n```\n# Fake\n```\n");
        expect(rows[0]?.anchors).toEqual(["parent", "child"]);
        expect(rows.map(row => row.anchors)).not.toContain(["fake"]);
    });
});

describe("exact citation scope", () => {
    it("MUST-FIRE for a test's exact definition ID and source comment anchor", () => {
        const rows = parseSpecSentences("docs/plan.md", "# Policy\nREQ-1: It must save the file.\n\nIt must preserve the state.");
        attachSentenceCitations(rows, [{ file: "src/save.test.ts", content: 'it("REQ-1 persists", () => {});' },
            { file: "src/save.ts", content: '// See docs/plan.md#policy\nexport const unrelated = "REQ-1";' }]);
        expect(rows[0]?.citations).toEqual(expect.arrayContaining([
            expect.objectContaining({ file: "src/save.test.ts", scope: "sentence", reference: "REQ-1" }),
            expect.objectContaining({ file: "src/save.ts", scope: "section", reference: "docs/plan.md#policy" }),
        ]));
        expect(rows[1]?.citations.map(citation => citation.scope)).toEqual(["section"]);
    });
    it("MUST-NOT-FIRE for prefix IDs, external URLs, uncited strings, self refs or ambiguous IDs", () => {
        const rows = [...parseSpecSentences("docs/a.md", "REQ-1: It must save the file."), ...parseSpecSentences("docs/b.md", "REQ-1: It must preserve the state.")];
        attachSentenceCitations(rows, [
            { file: "src/a.test.ts", content: '// REQ-10 REQ-1 https://host/docs/a.md#req-1' },
            { file: "src/a.ts", content: 'const value = "docs/a.md#req-1";' },
            { file: "docs/a.md", content: 'See plan docs/a.md.' },
        ]);
        expect(rows.every(row => row.citations.length === 0)).toBe(true);
    });
    it("does not promote bare plan links to sentence scope; supports exact explicit anchors", () => {
        const rows = parseSpecSentences("docs/a.md", '<a id="save"></a>\nIt must save the file.\n\nIt must preserve the state.');
        attachSentenceCitations(rows, [{ file: "src/a.ts", content: '// Fixes docs/a.md\n// See docs/a.md#save' }]);
        expect(rows[0]?.citations.map(citation => citation.scope)).toEqual(["document", "sentence"]);
        expect(rows[1]?.citations.map(citation => citation.scope)).toEqual(["document"]);
    });
});

it("requires a document qualifier for compact IDs used by unrelated sessions and plans", () => {
    const rows = parseSpecSentences("docs/a.md", "B5: The command must save the file.");
    attachSentenceCitations(rows, [{ file: "src/unrelated.test.ts", content: '// historical unit B5' },
        { file: "src/related.test.ts", content: '// docs/a.md B5' }]);
    expect(rows[0]?.citations.map(citation => citation.file)).toEqual(["src/related.test.ts"]);
});
