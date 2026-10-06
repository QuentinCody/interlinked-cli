import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureCorpusInputs, corpusScope } from "./corpus-snapshot.js";
const roots: string[] = [];
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "corpus-snapshot-")); roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "const x = 1;");
    writeFileSync(join(root, "src/a.test.ts"), "test('x', () => {});");
    return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("does not invalidate eligible input evidence when excluded runtime files appear", () => {
    const root = fixture();
    const before = captureCorpusInputs(join(root, "src"), root, "source-and-tests");
    mkdirSync(join(root, "src/.interlinked"));
    writeFileSync(join(root, "src/.interlinked/observation.ts"), "generated runtime output");
    writeFileSync(join(root, "src/run.log"), "runtime output");
    const after = captureCorpusInputs(join(root, "src"), root, "source-and-tests");
    expect(after.digest).toBe(before.digest);
    expect(after.inputs).toEqual(before.inputs);
});
it("captures test detector inputs and makes dirty edits stale", () => {
    const root = fixture(); const scope = corpusScope("unawaited_async_assertion");
    const before = captureCorpusInputs(join(root, "src"), root, scope);
    expect(before.inputs.map(x => x.file)).toEqual(["src/a.test.ts"]);
    writeFileSync(join(root, "src/a.test.ts"), "changed");
    expect(captureCorpusInputs(join(root, "src"), root, scope).digest).not.toBe(before.digest);
});
it("retains failed discovery and symlinks as incomplete evidence", () => {
    const root = fixture();
    expect(captureCorpusInputs(join(root, "missing"), root, "source").failures).toHaveLength(1);
    symlinkSync(join(root, "src/a.ts"), join(root, "src/alias.ts"));
    expect(captureCorpusInputs(join(root, "src"), root, "source").failures[0]?.message).toMatch(/symlink/);
});
it("source-and-tests scope includes both domains but records fixture exclusions", () => {
    const root = fixture(); mkdirSync(join(root, "src/__fixtures__"));
    writeFileSync(join(root, "src/__fixtures__/bad.ts"), "bad");
    const result = captureCorpusInputs(join(root, "src"), root, "source-and-tests");
    expect(result.inputs).toHaveLength(2); expect(result.exclusions).toContain("src/__fixtures__");
});
