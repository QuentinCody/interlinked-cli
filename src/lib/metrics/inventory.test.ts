import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectRepositoryInventory } from "./inventory.js";

const roots: string[] = [];
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "metrics-inventory-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/main.ts"), "export function add(a: number, b: number) { return a + b; }\n");
    return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("repository measurement scope", () => {
    it("binds test and configuration edits without changing the product source hash", () => {
        const root = fixture();
        writeFileSync(join(root, "src/main.test.ts"), "test code");
        const first = collectRepositoryInventory(root);
        writeFileSync(join(root, "src/main.test.ts"), "different test code");
        const second = collectRepositoryInventory(root);
        expect(first.sourceHash).toBe(second.sourceHash);
        expect(first.inputHash).not.toBe(second.inputHash);
        expect(second.files.map(file => file.role).sort()).toEqual(["product", "test"]);
    });
    it("reports symlink sources as gaps and temporary fixtures as exclusions", () => {
        const root = fixture();
        symlinkSync(join(root, "src/main.ts"), join(root, "src/link.ts"));
        mkdirSync(join(root, "src/_content_gate_fixtures-123"));
        writeFileSync(join(root, "src/_content_gate_fixtures-123/probe.ts"), "broken(");
        const result = collectRepositoryInventory(root);
        expect(result.gaps.map(gap => gap.path)).toEqual(["src/link.ts"]);
        expect(result.excluded.map(file => [file.path, file.role])).toContainEqual(["src/_content_gate_fixtures-123/probe.ts", "fixture"]);
    });
    it("retains unsupported product languages and does not trust a generated comment", () => {
        const root = fixture();
        writeFileSync(join(root, "src/main.py"), "def main(): return 1\n");
        writeFileSync(join(root, "src/hidden.ts"), "// @generated\nexport function hidden() { return 1; }\n");
        const result = collectRepositoryInventory(root);
        expect(result.files.find(file => file.path === "src/main.py")?.language).toBe("python");
        expect(result.files.find(file => file.path === "src/hidden.ts")?.role).toBe("product");
    });
});
