import { expect, it, vi } from "vitest";
vi.mock("../checks/check-typescript.js", () => ({ loadCheckTypescript: () => null }));
import { attachSentenceCitations } from "./sentence-citations.js";
import { parseSpecSentences } from "./sentences.js";
it("reports unavailable source-comment scanning instead of implying no citations", () => {
    const rows = parseSpecSentences("docs/plan.md", "REQ-1: The command must save the file.");
    const missing = attachSentenceCitations(rows, [{ file: "src/a.ts", content: "// REQ-1" }, { file: "src/a.test.ts", content: '// REQ-1' }]);
    expect(missing).toEqual([{ file: "src/a.ts", reason: "TypeScript unavailable for source-comment citations" }]);
    expect(rows[0]?.citations.map(citation => citation.file)).toEqual(["src/a.test.ts"]);
});
