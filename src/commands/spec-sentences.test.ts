import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerSpecSentenceCommand } from "./spec-sentences.js";
import { scanSpecSentences, SPEC_FILE_BYTES } from "../harness/spec/sentence-project.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "spec-sentences-")); roots.push(root);
    mkdirSync(join(root, "docs")); mkdirSync(join(root, "src"));
    writeFileSync(join(root, "docs/plan.md"), "# Policy\nREQ-1: The command must save the file.\n\nThe command must preserve the state.");
    writeFileSync(join(root, "src/save.test.ts"), '// REQ-1\n// See docs/plan.md#policy');
    return root;
}
it("exposes read-only JSON and JSONL with separately reported direct and contextual coverage", async () => {
    const root = fixture(); vi.spyOn(process, "cwd").mockReturnValue(root);
    const out = vi.spyOn(console, "log").mockImplementation(() => {}), err = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = readdirSync(root);
    const program = new Command(); registerSpecSentenceCommand(program.command("spec"));
    await program.parseAsync(["node", "interlinked", "spec", "sentences", "docs/plan.md", "--json"]);
    const result = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(result.summary).toMatchObject({ requirementCitationShare: 1, directRequirementCitationShare: 0.5 });
    expect(result.advisory).toBe(true); expect(readdirSync(root)).toEqual(before);
    out.mockClear();
    const jsonlProgram = new Command(); registerSpecSentenceCommand(jsonlProgram.command("spec"));
    await jsonlProgram.parseAsync(["node", "interlinked", "spec", "sentences", "docs/plan.md"]);
    expect(out.mock.calls).toHaveLength(2); expect(JSON.parse(String(err.mock.calls[0]?.[0])).advisory).toBe(true);
});
it("reports unsupported, missing, oversized and private inputs without reading their contents", () => {
    const root = fixture(); writeFileSync(join(root, "docs/large.md"), "x".repeat(SPEC_FILE_BYTES + 1));
    const result = scanSpecSentences(root, ["docs/large.md", "missing.md", ".interlinked/config.local.json", "../../other.md"]);
    expect(result.rows).toEqual([]); expect(result.complete).toBe(false);
    expect(result.summary.issues.map(issue => issue.file)).toEqual(expect.arrayContaining(["docs/large.md", "missing.md", ".interlinked/config.local.json", "../../other.md"]));
});
