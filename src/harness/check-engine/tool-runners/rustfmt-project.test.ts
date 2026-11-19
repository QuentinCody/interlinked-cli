import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { rustfmtProjectScope } from "./rustfmt-project.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(): string { const root = mkdtempSync(join(tmpdir(), "rustfmt-scope-")); roots.push(root); return root; }
function file(root: string, path: string, body: string): string {
	const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, body); return target;
}

it("selects a root Cargo crate or workspace before classifying descendant fixture paths", () => {
	const root = project(), manifest = file(root, "Cargo.toml", '[workspace]\nmembers=["fixtures/member"]\n');
	file(root, "fixtures/member/Cargo.toml", '[package]\nname="member"\nversion="0.1.0"\nedition="2024"\n');
	file(root, "fixtures/member/src/lib.rs", "pub fn value()->u8{1}\n");
	expect(rustfmtProjectScope(root)).toEqual({ mode: "cargo", manifest });
});
it("excludes independent fixture crates with an explicit intentional-scope reason", () => {
	const root = project(); file(root, "fixtures/crate/Cargo.toml", '[package]\nname="fixture"\nversion="0.1.0"\n');
	file(root, "fixtures/crate/src/lib.rs", "pub fn fixture()->u8{1}\n");
	expect(rustfmtProjectScope(root)).toMatchObject({ mode: "excluded", category: "config_disabled", reason: expect.stringContaining("fixture") });
});
it("retains standalone product and authored test Rust files without requiring Cargo", () => {
	const root = project(), product = file(root, "src/main.rs", "fn main(){}"), test = file(root, "tests/check.rs", "fn check(){}");
	file(root, "fixtures/example.rs", "fn example(){}");
	expect(rustfmtProjectScope(root)).toEqual({ mode: "files", files: [product, test] });
});
it("distinguishes a non-Rust population from intentionally excluded Rust", () => {
	const root = project(); file(root, "index.js", "export const value = 1;");
	expect(rustfmtProjectScope(root)).toMatchObject({ mode: "excluded", category: "file_type_mismatch", reason: expect.stringContaining("No selected Rust") });
});
it("retains unknown discovery instead of claiming language absence", () => {
	const root = project(); symlinkSync("missing.rs", join(root, "missing.rs"));
	expect(rustfmtProjectScope(root)).toMatchObject({ mode: "unavailable", reason: expect.stringContaining("missing.rs") });
});
it("preserves bounded background inventory failures as unknown", () => {
	expect(rustfmtProjectScope(project(), { discovery: "filesystem", paths: [], issues: ["Discovery reached a caller limit"] }))
		.toEqual({ mode: "unavailable", reason: "Discovery reached a caller limit" });
});
