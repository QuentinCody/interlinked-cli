import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyResults } from "./tool-results-types-keys.js";
import { runTypeRedundancyChecks } from "./file-checks-type-redundancy.js";

/** Real git fixture: both underlying detectors shell to `git ls-files`. */
let root: string | undefined;
function fixture(files: Record<string, string>): string {
	root = mkdtempSync(join(tmpdir(), "type-redundancy-wiring-"));
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), content);
	}
	execSync("git init -q", { cwd: root });
	return root;
}
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("runTypeRedundancyChecks", () => {
	it("P1: files issues under their own result keys with the right check ids", () => {
		const r = emptyResults();
		// A test-file path keeps both detectors silent regardless of repo state —
		// the point here is the wiring shape (keys exist, no throw), not
		// detector behavior (owned by type-redundancy.test.ts / dead-exports-inline.test.ts).
		runTypeRedundancyChecks({
			content: "export interface X { id: string }\n",
			file: "/tmp/wiring-probe/a.test.ts",
			relPath: "a.test.ts",
			cwd: "/tmp/wiring-probe",
			r,
		});
		expect(r.deadTypeExports).toEqual([]);
		expect(r.duplicateTypeDeclaration).toEqual([]);
	});

	it("P2: a real orphaned type export and a real duplicate declaration land under the RIGHT check ids (not swapped, not merged)", () => {
		const dupContent = "export interface Shape {\n\tid: string;\n}\n";
		const cwd = fixture({
			"src/a.ts": dupContent,
			"src/b.ts": "export interface Shape {\n\tid: string;\n}\n",
			"src/orphan.ts": "export interface OnlyHere {\n\tvalue: number;\n}\n",
		});
		const r = emptyResults();
		runTypeRedundancyChecks({
			content: dupContent,
			file: join(cwd, "src/a.ts"),
			relPath: "src/a.ts",
			cwd,
			r,
		});
		// Duplicate declaration fires under `duplicateTypeDeclaration` with the
		// duplicate_type_declaration check id — a swap (or a merge into
		// deadTypeExports) would fail this.
		expect(r.duplicateTypeDeclaration).toHaveLength(1);
		expect(r.duplicateTypeDeclaration[0]?.check).toBe("duplicate_type_declaration");
		expect(r.duplicateTypeDeclaration[0]?.message).toContain("b.ts");

		const r2 = emptyResults();
		runTypeRedundancyChecks({
			content: "export interface OnlyHere {\n\tvalue: number;\n}\n",
			file: join(cwd, "src/orphan.ts"),
			relPath: "src/orphan.ts",
			cwd,
			r: r2,
		});
		// Orphaned export fires under `deadTypeExports` with the
		// dead_type_exports check id.
		expect(r2.deadTypeExports).toHaveLength(1);
		expect(r2.deadTypeExports[0]?.check).toBe("dead_type_exports");
		expect(r2.deadTypeExports[0]?.message).toContain("OnlyHere");
	});
});
