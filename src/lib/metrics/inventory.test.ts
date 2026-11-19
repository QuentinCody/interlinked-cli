import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectRepositoryInventory } from "./inventory.js";
import { analyzeRepository } from "./analysis.js";
import { inventoryWithOverrides } from "./inventory-overrides.js";
import { evidenceIdentity } from "./evidence-identity.js";

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
	it("keeps an unreadable tracked input as a named foreground gap", () => {
		const root = fixture(); execFileSync("git", ["init", "--quiet"], { cwd: root });
		execFileSync("git", ["add", "src/main.ts"], { cwd: root }); rmSync(join(root, "src/main.ts"));
		const inventory = collectRepositoryInventory(root, { resourcePolicy: "foreground-survey" });
		expect(inventory.files).toEqual([]); expect(inventory.gaps).toContainEqual(expect.objectContaining({ path: "src/main.ts", reason: expect.stringMatching(/ENOENT/) }));
	});
	it("measures the complete foreground body beyond two MiB including meaningful end-of-file structure", () => {
		const root = fixture(), body = `// ${"x".repeat(2 * 1024 * 1024)}\nexport function atEnd(enabled: boolean) { return enabled ? 1 : 0; }\n`;
		writeFileSync(join(root, "src/large.ts"), body);
		const full = collectRepositoryInventory(root, { resourcePolicy: "foreground-survey" });
		expect(full.files.find(file => file.path === "src/large.ts")?.content).toBe(body);
		expect(full.gaps).toEqual([]);
		expect(analyzeRepository(full).files.find(file => file.input.path === "src/large.ts")?.structure).toMatchObject({ state: "measured", functions: [{ name: "atEnd", cyclomatic: 2 }] });
		expect(collectRepositoryInventory(root).gaps).toContainEqual(expect.objectContaining({ path: "src/large.ts", reason: expect.stringContaining("2 MiB") }));
	});
    it("separates lock-named implementation changes from dependency lockfile changes", () => {
        const root = fixture();
        writeFileSync(join(root, "src/clock.ts"), "export function clock() { return 1; }\n");
        writeFileSync(join(root, "yarn.lock"), "first dependency resolution\n");
        const inventory = collectRepositoryInventory(root), before = evidenceIdentity(inventory);
        const sourceEdit = inventoryWithOverrides(inventory, new Map([["src/clock.ts", "export function clock() { return 2; }\n"]]));
        expect(evidenceIdentity(sourceEdit).dependencyHash).toBe(before.dependencyHash);
        expect(sourceEdit.sourceHash).not.toBe(inventory.sourceHash);
        const dependencyEdit = inventoryWithOverrides(inventory, new Map([["yarn.lock", "second dependency resolution\n"]]));
        expect(evidenceIdentity(dependencyEdit).dependencyHash).not.toBe(before.dependencyHash);
        expect(dependencyEdit.sourceHash).toBe(inventory.sourceHash);
    });

    it.each(["clock.ts", "file-mutation-lock.ts"])("measures %s as product source on disk and in proposed edits", name => {
        const root = fixture(), path = `src/${name}`;
        writeFileSync(join(root, path), "export function run(enabled: boolean) { return enabled ? 1 : 0; }\n");
        const inventory = collectRepositoryInventory(root);
        const analysis = analyzeRepository(inventory);
        expect(analysis.files.find(file => file.input.path === path)).toMatchObject({ input: { role: "product" },
            structure: { state: "measured", functions: [{ name: "run", cyclomatic: 2 }] } });
        const proposed = inventoryWithOverrides(inventory, new Map([[path, "export function run() { return 2; }\n"]]));
        expect(analyzeRepository(proposed).files.find(file => file.input.path === path)?.structure).toMatchObject({ state: "measured", functions: [{ name: "run", cyclomatic: 1 }] });
        expect(proposed.sourceHash).not.toBe(inventory.sourceHash);
    });

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
