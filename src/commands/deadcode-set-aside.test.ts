import { describe, expect, it } from "vitest";
import type { DeadCodeReport } from "./deadcode.js";
import { applySetAside, type SetAsideDecision } from "./deadcode-set-aside.js";

const report = (): DeadCodeReport => ({
	unreachableFiles: ["src/_api/a.py", "src/_api/b.py", "src/real.py", "web/gen/x.ts"],
	deadImportBindings: [{ file: "src/_api/a.py", binding: "os" }, { file: "src/real.py", binding: "sys" }] as DeadCodeReport["deadImportBindings"],
	deadExports: [{ file: "web/gen/x.ts", detail: "foo" }, { file: "web/app.ts", detail: "bar" }],
	deadTypeExports: [{ file: "web/gen/x.ts", detail: "T" }],
	testOnlyImporterFiles: ["src/_api/b.py", "src/other.py"],
	scannedFiles: 10, scannedPaths: [],
});

const decide = (file: string): SetAsideDecision | null => {
	if (file.startsWith("src/_api/")) return { role: "generated", evidence: "generator-command", detail: "openapi-python-client writes `src/_api` (scripts/gen.sh:4)" };
	if (file.startsWith("web/gen/")) return { role: "unlinted", evidence: "tool-config", detail: "eslint ignores `web/gen` (eslint.config.js:3)" };
	return null;
};

describe("applySetAside", () => {
	it("MUST-FIRE: drops set-aside files from every finding list and lists them with role, evidence and finding counts", () => {
		const out = applySetAside(report(), decide);
		expect(out.unreachableFiles).toEqual(["src/real.py"]);
		expect(out.deadImportBindings.map((b) => b.file)).toEqual(["src/real.py"]);
		expect(out.deadExports.map((d) => d.file)).toEqual(["web/app.ts"]);
		expect(out.deadTypeExports).toEqual([]);
		expect(out.testOnlyImporterFiles).toEqual(["src/other.py"]);
		expect(out.setAside?.files).toBe(3);
		expect(out.setAside?.byRole).toEqual({ generated: 2, unlinted: 1 });
		const listed = out.setAside?.listed.find((row) => row.file === "src/_api/a.py");
		expect(listed).toMatchObject({ role: "generated", evidence: "generator-command", findings: 2 });
		expect(listed?.detail).toContain("scripts/gen.sh:4");
	});

	it("MUST-NOT-FIRE: a report with no set-aside file is unchanged and carries an empty block", () => {
		const out = applySetAside(report(), () => null);
		expect(out.unreachableFiles).toEqual(report().unreachableFiles);
		expect(out.setAside).toMatchObject({ files: 0, byRole: {}, listed: [], omitted: 0 });
	});

	it("caps the listing and counts the rest as omitted", () => {
		const many = { ...report(), unreachableFiles: Array.from({ length: 80 }, (_, i) => `src/_api/m${i}.py`) };
		const out = applySetAside(many, decide);
		expect(out.setAside?.listed.length).toBe(50);
		expect(out.setAside?.omitted).toBeGreaterThan(0);
	});
});
