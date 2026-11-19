import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectStandardsInventory, compareStandardsSnapshot } from "./inventory.js";
import { scanStandardsSyntax } from "./syntax.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "standards-inventory-")); roots.push(root);
	const files = { "src/main.ts": "export const value = 1;", "test.js": "const value = 1;", "fixtures/example.ts": "const fixture = 1;", "generated/output.ts": "const generated = 1;", "vendor/lib.ts": "const vendor = 1;", "README.md": "Documentation", "tool.py": "value = 1", "tsconfig.json": "{}", "logo.svg": "<svg/>" };
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), content);
	}
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	execFileSync("git", ["add", "--all"], { cwd: root });
	return root;
}

it("preserves tracked all-role denominators and identifies unsupported source explicitly", () => {
	const inventory = collectStandardsInventory(fixture(), "all");
	expect(inventory.files.map(file => file.path)).toEqual(["fixtures/example.ts", "generated/output.ts", "src/main.ts", "test.js", "vendor/lib.ts"]);
	expect(inventory.byRole.fixture?.files).toBe(1);
	expect(inventory.byRole.generated?.files).toBe(1);
	expect(inventory.byRole.vendor?.files).toBe(1);
	expect(inventory.byRole.test?.files).toBe(1);
	expect(inventory.entries.find(entry => entry.path === "tool.py")).toMatchObject({ supported: false, selected: false, reason: "unsupported_language" });
	expect(inventory.gaps).toEqual([]);
});

it("retains exact foreground source identity and end-of-file syntax beyond two MiB", () => {
	const root = fixture(), body = `// ${"x".repeat(2 * 1024 * 1024)}\nexport const atEnd: any = 1;\n`;
	writeFileSync(join(root, "src/large.ts"), body);
	const options = { resourcePolicy: "foreground-survey" } as const;
	const full = collectStandardsInventory(root, "all", options), captured = full.files.find(file => file.path === "src/large.ts");
	expect(captured?.content).toBe(body); expect(full.gaps).toEqual([]);
	const syntax = scanStandardsSyntax(captured?.content ?? "", "src/large.ts");
	expect(syntax.findings).toContainEqual(expect.objectContaining({ rule: "explicit_any", line: 2 }));
	expect(compareStandardsSnapshot(full, options)).toMatchObject({ state: "stable_selected_snapshot", changedFiles: [] });
	expect(collectStandardsInventory(root).gaps).toContainEqual(expect.objectContaining({ path: "src/large.ts", reason: expect.stringContaining("2 MiB") }));
});

it("selects product source without losing the all-role inventory", () => {
	const root = fixture();
	const all = collectStandardsInventory(root, "all");
	const product = collectStandardsInventory(root, "product");
	expect(product.files.map(file => file.path)).toEqual(["src/main.ts"]);
	expect(product.byRole).toEqual(all.byRole);
	expect(product.entries).toHaveLength(all.entries.length);
});

it("reports a symlink source as unavailable without following it", () => {
	const root = fixture(), outside = mkdtempSync(join(tmpdir(), "standards-outside-")); roots.push(outside);
	writeFileSync(join(outside, "secret.ts"), "throw new Error('outside');");
	symlinkSync(join(outside, "secret.ts"), join(root, "linked.ts"));
	const inventory = collectStandardsInventory(root, "all");
	expect(inventory.files.some(file => file.path === "linked.ts")).toBe(false);
	expect(inventory.gaps).toEqual([expect.objectContaining({ path: "linked.ts" })]);
});

it("records changed selected source and newly discovered paths during a census", () => {
	const root = fixture(), inventory = collectStandardsInventory(root);
	writeFileSync(join(root, "src/main.ts"), "export const changed = true;");
	writeFileSync(join(root, "new.ts"), "export {};");
	expect(compareStandardsSnapshot(inventory)).toMatchObject({ state: "changed", changedFiles: ["src/main.ts"], addedPaths: ["new.ts"], unavailableFiles: [], removedPaths: [] });
});

it("labels failed end-of-survey Git discovery inconclusive without claiming paths disappeared", () => {
	const root = fixture(), options = { resourcePolicy: "foreground-survey" } as const, inventory = collectStandardsInventory(root, "all", options);
	writeFileSync(join(root, ".git/index"), "corrupt index");
	expect(compareStandardsSnapshot(inventory, options)).toMatchObject({ state: "inconclusive", removedPaths: [], changedFiles: [], discoveryIssues: [expect.stringContaining("Git inventory unavailable")] });
});
