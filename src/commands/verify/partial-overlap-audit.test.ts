import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkExistingPartialOverlap } from "./partial-overlap-audit.js";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });
const body = "let x = value + 2; x *= 3; x -= 4; x += 5; x /= 6; return x;";
it("MUST-FIRE: existing cross-file overlap is audited without an edit baseline", () => {
    root = mkdtempSync(join(tmpdir(), "partial-audit-")); mkdirSync(join(root, "src"));
    const file = join(root, "src", "a.ts"), other = join(root, "src", "b.ts");
    const content = `export function a(value: number) { ${body} }`;
    writeFileSync(file, content); writeFileSync(other, `export function b(value: number) { ${body} }`);
    expect(checkExistingPartialOverlap(content, file, root)).toHaveLength(1);
    // Same-size content changes invalidate the audit's cache.
    writeFileSync(other, `export function b(value: number) { ${body.replace("*= 3", "*= 9")} }`);
    expect(checkExistingPartialOverlap(content, file, root)).toEqual([]);
});
it("MUST-NOT-FIRE: explicit import edges and test files", () => {
    root = mkdtempSync(join(tmpdir(), "partial-audit-"));
    const file = join(root, "a.ts");
    const content = `import { b } from './b.js'; export function a(value: number) { ${body} }`;
    writeFileSync(file, content); writeFileSync(join(root, "b.ts"), `export function b(value: number) { ${body} }`);
    expect(checkExistingPartialOverlap(content, file, root)).toEqual([]);
    expect(checkExistingPartialOverlap(content, join(root, "a.test.ts"), root)).toEqual([]);
});
