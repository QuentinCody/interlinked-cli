import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExcludedFile, InventoryFile, RepositoryInventory } from "./measurement-types.js";
import { MAX_DECLARED_LISTED, summarizeProvenance } from "./provenance.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function file(path: string, lines: number, extra: Partial<InventoryFile> = {}): InventoryFile {
	return { path, role: "product", language: "typescript", sha256: "x", content: "a\n".repeat(lines), ...extra };
}
function excluded(path: string, role: ExcludedFile["role"], extra: Partial<ExcludedFile> = {}): ExcludedFile {
	return { path, role, reason: "Excluded by source-role policy", ...extra };
}
function inventory(files: InventoryFile[], out: ExcludedFile[], root = "/nowhere"): RepositoryInventory {
	return { version: "interlinked-source-roles-v5", root, discovery: "git", files, gaps: [], excluded: out, inputHash: "i", sourceHash: "s", issues: [] };
}

describe("provenance summary: nothing leaves the authored set unseen", () => {
	const input = inventory([file("src/a.ts", 10, { declaredGenerated: { detail: "line 1: @generated" } }), file("src/b.ts", 5), file("src/a.test.ts", 4, { role: "test" }),
		file("mocks/m.ts", 7, { role: "test", moved: { from: "product", evidence: { kind: "path", detail: "mocks/" } } })], [
		excluded("dist/out.js", "generated", { evidence: { kind: "path", detail: "dist/" }, lines: 100 }),
		excluded("web/app.bundle.js", "generated", { from: "product", evidence: { kind: "shape", detail: "mean line 5000.0 chars, code share 0.900" }, lines: 3 }),
		excluded(".yarn/releases/yarn.cjs", "vendor", { from: "product", evidence: { kind: "tool-path", detail: ".yarn/releases/" }, lines: 900 }),
		excluded("public/logo.png", "asset")], "/nowhere");
	const summary = summarizeProvenance(input);

	it("counts authored product files and lines", () => {
		expect(summary.authored).toEqual({ files: 2, lines: 15 });
	});
	it("reports every role with its files", () => {
		expect(summary.roles.find(row => row.role === "product")).toEqual({ role: "product", files: 2, lines: 15 });
		expect(summary.roles.find(row => row.role === "test")).toEqual({ role: "test", files: 2, lines: 11 });
		expect(summary.roles.find(row => row.role === "asset")).toEqual({ role: "asset", files: 1, lines: null });
	});
	it("splits generated and vendor by structural evidence kind", () => {
		expect(summary.setAside.generated).toMatchObject({ files: 2, lines: 103, byKind: { path: 1, shape: 1, "tool-path": 0, marker: 0 } });
		expect(summary.setAside.vendor).toMatchObject({ files: 1, lines: 900, byKind: { "tool-path": 1, path: 0, marker: 0, shape: 0 } });
	});
	it("names the largest set-aside files with their evidence", () => {
		expect(summary.setAside.generated.largest[0]).toEqual({ path: "dist/out.js", role: "generated", from: null, lines: 100, evidence: { kind: "path", detail: "dist/" } });
		expect(summary.setAside.vendor.largest.map(entry => entry.path)).toEqual([".yarn/releases/yarn.cjs"]);
	});
	it("counts every move out of product, including a move that keeps the file a score input", () => {
		expect(summary.moved).toEqual({ total: 3, byKind: { path: 1, "tool-path": 1, marker: 0, shape: 1, "tool-config": 0, attributes: 0, "generator-config": 0, "generator-command": 0, "uniform-structure": 0 }, toRole: { generated: 1, vendor: 1, test: 1 } });
	});
	it("lists files that declare themselves generated and are still measured, with the total", () => {
		expect(summary.declared).toEqual({ total: 1, listed: 1, files: [{ path: "src/a.ts", lines: 10, detail: "line 1: @generated" }] });
	});
	it("prints one short line that counts declared files as still measured", () => {
		expect(summary.line).toBe("authored 2 files (1 declare generated, still measured) · generated 2 · vendored 1 · unlinted 0 · moved to test by path 1");
	});
});

describe("provenance summary caps the declared list and still reports the total", () => {
	it("lists at most the cap, largest first", () => {
		const many = Array.from({ length: MAX_DECLARED_LISTED + 5 }, (_, index) => file(`g/${index}.ts`, index + 1, { declaredGenerated: { detail: "line 1: @generated" } }));
		const summary = summarizeProvenance(inventory(many, []));
		expect(summary.declared.total).toBe(MAX_DECLARED_LISTED + 5);
		expect(summary.declared.files).toHaveLength(MAX_DECLARED_LISTED);
		expect(summary.declared.files[0]?.lines).toBe(MAX_DECLARED_LISTED + 5);
	});
});

describe("provenance summary reads missing line counts from disk, bounded", () => {
	it("counts lines of a path-excluded source file and leaves binary assets unknown", () => {
		const root = mkdtempSync(join(tmpdir(), "provenance-"));
		roots.push(root); mkdirSync(join(root, "vendor"));
		writeFileSync(join(root, "vendor/lib.js"), "a\nb\nc\n");
		const summary = summarizeProvenance(inventory([], [excluded("vendor/lib.js", "vendor", { evidence: { kind: "path", detail: "vendor/" } }),
			excluded("vendor/missing.js", "vendor", { evidence: { kind: "path", detail: "vendor/" } }), excluded("logo.png", "asset")], root));
		expect(summary.setAside.vendor).toMatchObject({ files: 2, lines: 3 });
		expect(summary.roles.find(row => row.role === "asset")?.lines).toBeNull();
	});
	it("names the matching path rule for a census exit that carries no evidence of its own", () => {
		const summary = summarizeProvenance(inventory([], [excluded("pkg/dist/out.js", "generated", { lines: 5 }), excluded("node_modules/a/i.js", "vendor", { lines: 7 })]));
		expect(summary.setAside.generated.largest).toEqual([{ path: "pkg/dist/out.js", role: "generated", from: null, lines: 5, evidence: { kind: "path", detail: "dist/" } }]);
		expect(summary.setAside.vendor.byKind.path).toBe(1);
	});
	it("prints an empty authored set without a header-only note", () => {
		expect(summarizeProvenance(inventory([], [])).line).toBe("authored 0 files · generated 0 · vendored 0 · unlinted 0");
	});
});
