import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCoworkArtifact } from "./artifacts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(name: string) {
    const root = mkdtempSync(join(tmpdir(), "cowork-artifact-")); roots.push(root);
    return join(root, name);
}
function office(path: string, parts: Record<string, string>): void {
    // Python's standard library produces real ZIP fixtures, independently of
    // the bounded reader under test. No downloads or Office installation.
    execFileSync("python3", ["-c", "import json,sys,zipfile; p=json.load(sys.stdin); z=zipfile.ZipFile(p['path'],'w',zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in p['parts'].items()]; z.close()"],
        { input: JSON.stringify({ path, parts }), timeout: 10000 });
}
describe("Cowork knowledge-work artifact checks", () => {
    it("reports placeholders as warnings and hashes the actual file bytes", () => {
        const path = fixture("report.md");
        writeFileSync(path, "# Report\n[INSERT SOURCE HERE]\n");
        const report = checkCoworkArtifact(path);
        expect(report.findings).toContainEqual(expect.objectContaining({ check: "placeholder_text", severity: "warning" }));
        expect(report.sha256).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
    });
    it("finds cached spreadsheet errors without claiming formula recalculation", () => {
        const path = fixture("book.xlsx");
        office(path, { "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>", "xl/worksheets/sheet1.xml": '<worksheet><c r="A1" t="e"><v>#REF!</v></c></worksheet>' });
        const report = checkCoworkArtifact(path);
        expect(report.findings).toContainEqual(expect.objectContaining({ check: "cached_spreadsheet_errors", severity: "error" }));
        expect(report.limitations.join()).toContain("formula recalculation");
    });
    it.each([["report.docx", "word/document.xml"], ["deck.pptx", "ppt/presentation.xml"]])("reads bounded Office content in %s", (name, part) => {
        const path = fixture(name);
        office(path, { "[Content_Types].xml": "<Types/>", [part]: "<document><text>TBD</text></document>" });
        expect(checkCoworkArtifact(path).findings).toContainEqual(expect.objectContaining({ check: "placeholder_text" }));
    });
    it("rejects malformed archives and reports unsupported formats as unmeasured", () => {
        const path = fixture("broken.docx"); writeFileSync(path, "not a ZIP");
        expect(() => checkCoworkArtifact(path)).toThrow("directory");
        const pdf = fixture("file.pdf"); writeFileSync(pdf, "%PDF-1.7");
        expect(checkCoworkArtifact(pdf).status).toBe("unmeasured");
    });
});
