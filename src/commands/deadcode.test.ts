// Tests for `interlinked deadcode` — the whole-repo dead-code scan verb
// (operator request 2026-08-17: per-edit detection and repo scanning are two
// separate controls; this is the scan half).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeadCodeReport, deadcodeCommand, scanDeadCode } from "./deadcode.js";

let tmp: string;

function seed(rel: string, content: string): void {
	const abs = join(tmp, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-deadcode-"));
	seed(
		"package.json",
		JSON.stringify({ name: "fixture", bin: { fixture: "./dist/index.js" } }),
	);
	seed("src/index.ts", 'import { used } from "./a.js";\nconsole.log(used);\n');
	seed(
		"src/a.ts",
		'import { helper } from "./b.js";\nimport { neverTouched } from "./b.js";\nexport const used = helper();\n',
	);
	seed("src/b.ts", "export function helper(): number { return 1; }\nexport const neverTouched = 2;\n");
	seed("src/orphan.ts", "export const island = 1;\n");
	seed("src/orphan.test.ts", "// tests never count as importers for reachability\n");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("scanDeadCode — positive (must report)", () => {
	// test-contract: behavior — the three layers report their own finding kinds:
	// unreachable files, dead import bindings, and dead exports
	it("P1: reports the orphan file, the unused import binding, and the unused export", () => {
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).toContain("src/orphan.ts");
		const bindings = r.deadImportBindings.map((b) => `${b.file}:${b.binding}`);
		expect(bindings).toContain("src/a.ts:neverTouched");
	});
});

describe("scanDeadCode — negative (must not report)", () => {
	// test-contract: boundary — entry points resolved from package.json bin and
	// reachable/used files never appear as unreachable candidates
	it("N1: the bin entry and imported files are not unreachable candidates", () => {
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).not.toContain("src/index.ts");
		expect(r.unreachableFiles).not.toContain("src/a.ts");
		expect(r.unreachableFiles).not.toContain("src/b.ts");
	});

	it("N2: test files are excluded from the unreachable list entirely", () => {
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).not.toContain("src/orphan.test.ts");
	});

	// test-contract: public-api — the CLI action's --json mode prints ONE
	// parseable report carrying all four report fields and exits 0
	it("P2: deadcodeCommand --json prints the full report shape", async () => {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((l: string) => {
			lines.push(String(l));
		});
		const code = await deadcodeCommand({ json: true, cwd: tmp });
		expect(code).toBe(0);
		// SAFETY: parsing the command's own --json output; the assertions
		// below verify every field the cast promises.
		const report = JSON.parse(lines.join("\n")) as DeadCodeReport;
		expect(report.unreachableFiles).toContain("src/orphan.ts");
		expect(report.deadImportBindings.map((b) => b.binding)).toContain("neverTouched");
		expect(Array.isArray(report.deadExports)).toBe(true);
		expect(report.scannedFiles).toBeGreaterThan(0);
	});

	// test-contract: bug-class — a file consumed ONLY via dynamic import()
	// looked unreachable (calibration run 2026-08-17: deadcode-categorize.ts
	// itself, loaded lazily by the CLI action, was the live FP)
	it("N4: a file reached only via dynamic import() is not unreachable", () => {
		seed(
			"src/lazy-host.ts",
			'export async function load(): Promise<unknown> {\n\treturn import("./lazy-leaf.js");\n}\n',
		);
		seed("src/lazy-leaf.ts", "export const lazily = 1;\n");
		seed("src/index3.ts", 'import { load } from "./lazy-host.js";\nvoid load();\n');
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).not.toContain("src/lazy-leaf.ts");
	});

	// test-contract: bug-class — files consumed ONLY through `export … from`
	// barrels looked importerless on first landing (the graph tracks import
	// statements, not re-export edges); checks/pii.ts was the live FP
	it("N3: a file reached only via a re-export barrel is not unreachable", () => {
		seed("src/barrel.ts", 'export * from "./leaf.js";\nexport { pick } from "./leaf2.js";\n');
		seed("src/leaf.ts", "export const viaStarOnly = 1;\n");
		seed("src/leaf2.ts", "export const pick = 2;\n");
		seed("src/index2.ts", 'import { viaStarOnly } from "./barrel.js";\nconsole.log(viaStarOnly);\n');
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).not.toContain("src/leaf.ts");
		expect(r.unreachableFiles).not.toContain("src/leaf2.ts");
	});
});

// The test-only signal feeds `--categorize`: a file in this bucket is
// presented as "alive only because tests import it", i.e. a deletion lead.
// Campaign 2026-09-02 measured 142 rows against a ground truth of 43 — the
// classifier read the project graph only, and the graph records static
// import statements, so a barrel `export … from` edge or a dynamic
// `import()` from live product code was invisible.
describe("scanDeadCode testOnlyImporterFiles — positive (must fire)", () => {
	// test-contract: behavior — the true positive the bucket exists for
	it("P3: a module imported only from a *.test.ts IS test-only", () => {
		seed("src/only-tested.ts", "export const onlyTested = 1;\n");
		seed(
			"src/only-tested.test.ts",
			'import { onlyTested } from "./only-tested.js";\nconsole.log(onlyTested);\n',
		);
		const r = scanDeadCode(tmp);
		expect(r.testOnlyImporterFiles).toContain("src/only-tested.ts");
	});

	// test-contract: boundary — the test-file predicate is path-shaped, not
	// suffix-only: a __tests__/ importer counts as a test importer too
	it("P4: a module imported only from __tests__/ IS test-only", () => {
		seed("src/nested-only.ts", "export const nestedOnly = 1;\n");
		seed(
			"src/__tests__/nested-only.spec.ts",
			'import { nestedOnly } from "../nested-only.js";\nconsole.log(nestedOnly);\n',
		);
		const r = scanDeadCode(tmp);
		expect(r.testOnlyImporterFiles).toContain("src/nested-only.ts");
	});
});

describe("scanDeadCode testOnlyImporterFiles — negative (must not fire)", () => {
	// test-contract: bug-class — barrel re-export edges are invisible to the
	// project graph, so the leaf looked test-only (deadcode over-report 3x)
	it("N5: a module reached only through `export … from` in a non-test barrel is NOT test-only", () => {
		seed("src/pbarrel.ts", 'export * from "./pleaf.js";\nexport { pick2 } from "./pleaf2.js";\n');
		seed("src/pleaf.ts", "export const viaProductBarrel = 1;\n");
		seed("src/pleaf2.ts", "export const pick2 = 2;\n");
		seed(
			"src/pleaf.test.ts",
			'import { viaProductBarrel } from "./pleaf.js";\nconsole.log(viaProductBarrel);\n',
		);
		seed("src/pleaf2.test.ts", 'import { pick2 } from "./pleaf2.js";\nconsole.log(pick2);\n');
		const r = scanDeadCode(tmp);
		expect(r.testOnlyImporterFiles).not.toContain("src/pleaf.ts");
		expect(r.testOnlyImporterFiles).not.toContain("src/pleaf2.ts");
	});

	// test-contract: bug-class — the lazily-loaded module class (the CLI's own
	// `await import("./deadcode-categorize.js")` was the live FP)
	it("N6: a module reached only via dynamic import() from product code is NOT test-only", () => {
		seed(
			"src/dyn-host.ts",
			'export async function load(): Promise<unknown> {\n\treturn import("./dyn-leaf.js");\n}\n',
		);
		seed("src/dyn-leaf.ts", "export const lazily = 1;\n");
		seed(
			"src/dyn-leaf.test.ts",
			'import { lazily } from "./dyn-leaf.js";\nconsole.log(lazily);\n',
		);
		const r = scanDeadCode(tmp);
		expect(r.testOnlyImporterFiles).not.toContain("src/dyn-leaf.ts");
	});

	// test-contract: boundary — a commented-out import is not a live edge, so
	// the broadened specifier scan must not launder a true positive away
	it("N7: a commented-out product import does not clear a genuinely test-only module", () => {
		seed("src/cmt-host.ts", '// import { commented } from "./cmt-leaf.js";\nexport const x = 1;\n');
		seed("src/cmt-leaf.ts", "export const commented = 1;\n");
		seed(
			"src/cmt-leaf.test.ts",
			'import { commented } from "./cmt-leaf.js";\nconsole.log(commented);\n',
		);
		const r = scanDeadCode(tmp);
		expect(r.testOnlyImporterFiles).toContain("src/cmt-leaf.ts");
	});

	// test-contract: bug-class — a span-matching block-comment strip mis-pairs
	// on regex literals / template strings and swallows the whole import
	// block, which silently restored the over-report (measured on
	// structural-checks.ts: 16 specifiers lost)
	it("N8: a barrel carrying JSDoc and a regex literal still clears its leaf", () => {
		seed(
			"src/doc-barrel.ts",
			[
				"/**",
				" * Barrel with a doc comment above the re-export.",
				" */",
				'export const SPLAT = /\\/\\*|\\*\\//;',
				"",
				'export { docLeafValue } from "./doc-leaf.js";',
				"",
			].join("\n"),
		);
		seed("src/doc-leaf.ts", "export const docLeafValue = 1;\n");
		seed(
			"src/doc-leaf.test.ts",
			'import { docLeafValue } from "./doc-leaf.js";\nconsole.log(docLeafValue);\n',
		);
		const r = scanDeadCode(tmp);
		expect(r.testOnlyImporterFiles).not.toContain("src/doc-leaf.ts");
	});
});
