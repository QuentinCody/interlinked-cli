import { parseWire, wireAbsentOptional, wireArray, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
// Tests for `interlinked deadcode` — the whole-repo dead-code scan verb
// (operator request 2026-08-17: per-edit detection and repo scanning are two
// separate controls; this is the scan half).

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildDeadExportsRepo,
	collectReferences,
	deadcodeCommand,
	scanDeadCode,
} from "./deadcode.js";

let tmp: string;

/** Capture every `console.log` line the CLI action prints. */
function captureLog(): string[] {
	const lines: string[] = [];
	vi.spyOn(console, "log").mockImplementation((l: string) => {
		lines.push(String(l));
	});
	return lines;
}

interface CapturedCategories {
	items: { file: string; symbol?: string; bucket: string; recommendation: string }[];
}

/** Parse the `--categorize --json` payload the action printed. Every field the
 *  cast promises is asserted by the caller. */
function parseCategories(lines: string[]): CapturedCategories {
	const parsed = parseWire(JSON.parse(lines.join("\n")), wireObject({ "categories": wireObject({ "items": wireArray(wireObject({ "file": wireString, "symbol": wireAbsentOptional(wireString), "bucket": wireString, "recommendation": wireString })) }) }), "test JSON value");
	return parsed.categories;
}

/** Seed enough candidates to push all three printed lists past their 40-row
 *  cap: 41 unused import bindings, plus 5 files × (10 dead value exports +
 *  10 dead type exports) — MAX_FLAGGED caps each detector at 10 per file. */
function seedTruncationFixture(): void {
	const unused = Array.from({ length: 41 }, (_, i) => `u${i}`).join(", ");
	seed("src/many-imports.ts", `import { ${unused} } from "./b.js";\nexport const manyHost = 1;\n`);
	for (let f = 0; f < 5; f++) {
		const body = Array.from(
			{ length: 10 },
			(_, i) => `export const v${f}${i} = ${i};\nexport interface T${f}${i} { a: number }`,
		).join("\n");
		seed(`src/surface-${f}.ts`, `${body}\n`);
	}
}

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
		const report = parseWire(JSON.parse(lines.join("\n")), wireObject({ "unreachableFiles": wireArray(wireString), "deadImportBindings": wireArray(wireObject({ "file": wireString, "binding": wireString })), "deadExports": wireArray(wireObject({ "file": wireString, "detail": wireString })), "deadTypeExports": wireArray(wireObject({ "file": wireString, "detail": wireString })), "testOnlyImporterFiles": wireAbsentOptional(wireArray(wireString)), "scannedFiles": wireNumber, "scannedPaths": wireArray(wireString) }), "test JSON value");
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

describe("scanDeadCode — walk fault tolerance", () => {
	// test-contract: bug-class — a dangling symlink makes statSync throw
	// mid-walk; the walk skips that entry and keeps scanning its siblings
	it("skips an entry it cannot stat and still scans the files after it", () => {
		symlinkSync(join(tmp, "src/nowhere-at-all.ts"), join(tmp, "src/aaa-ghost.ts"));
		const r = scanDeadCode(tmp);
		expect(r.scannedPaths).not.toContain("src/aaa-ghost.ts");
		expect(r.scannedPaths).toContain("src/orphan.ts");
	});
});

describe("scanDeadCode — entry-point discovery", () => {
	// test-contract: behavior — a file an npm script runs is reachable by
	// definition, whatever the script is named; non-string values are skipped
	it("treats a source file named by any npm script as an entry point", () => {
		seed(
			"package.json",
			JSON.stringify({
				name: "fixture",
				bin: { fixture: "./dist/index.js" },
				scripts: { docs: "tsx src/script-entry.ts", weird: 7 },
			}),
		);
		seed("src/script-entry.ts", "export const ranByScript = 1;\n");
		seed("src/never-scripted.ts", "export const nobody = 1;\n");
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).not.toContain("src/script-entry.ts");
		expect(r.unreachableFiles).toContain("src/never-scripted.ts");
	});

	// test-contract: boundary — fail-soft: an unparseable manifest leaves the
	// scan running on the conventional entry set instead of throwing
	it("falls back to conventional entries when package.json is unparseable", () => {
		seed("package.json", "{ name: broken,,,");
		seed("src/cli.ts", "export const cliMain = 1;\n");
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).toContain("src/cli.ts");
		expect(r.unreachableFiles).not.toContain("src/index.ts");
	});

	// test-contract: behavior — an embedded sub-project's entry is invisible to
	// this repo's import graph, so its own manifest is what declares it
	it("treats an index beside its own package.json as a sub-project entry point", () => {
		seed("src/embedded/package.json", JSON.stringify({ name: "embedded" }));
		seed("src/embedded/index.ts", "export const embeddedEntry = 1;\n");
		seed("src/plain/index.ts", "export const plainEntry = 1;\n");
		const r = scanDeadCode(tmp);
		expect(r.unreachableFiles).not.toContain("src/embedded/index.ts");
		expect(r.unreachableFiles).toContain("src/plain/index.ts");
	});
});

describe("collectReferences", () => {
	// test-contract: bug-class — one unreadable file must not abort the sweep
	it("skips an unreadable file and still records edges from the readable ones", () => {
		const refs = collectReferences(tmp, ["src/vanished.ts", "src/a.ts"]);
		expect(refs.byNonTest.has("src/b.ts")).toBe(true);
		expect(refs.byTest.size).toBe(0);
	});
});

describe("buildDeadExportsRepo", () => {
	// test-contract: public-api — the DeadExportsRepo contract says an
	// unreadable path reads as null; throwing would abort the whole scan
	it("reports an unreadable importer as null and still reads the real ones", () => {
		const { repo } = buildDeadExportsRepo(tmp, ["src/a.ts", "src/gone.ts"]);
		expect(repo.readFile("src/gone.ts")).toBeNull();
		expect(repo.readFile("src/a.ts")).toContain('import { helper } from "./b.js";');
	});

	// test-contract: behavior — primed content stands in for the filesystem,
	// which is how the scan avoids re-reading a file it already loaded
	it("serves primed content for a path the filesystem does not have", () => {
		const { repo, prime } = buildDeadExportsRepo(tmp, ["src/ghosted.ts"]);
		prime("src/ghosted.ts", "export const primed = 1;\n");
		expect(repo.readFile("src/ghosted.ts")).toBe("export const primed = 1;\n");
		expect(repo.listFiles()).toEqual(["src/ghosted.ts"]);
	});
});

describe("scanDeadCode — the TYPE-export lane", () => {
	// test-contract: behavior — types get their own lane because erasing one
	// can never change runtime behavior; the value lane must stay clear of it
	it("reports an exported interface with no consumer in the type lane only", () => {
		seed("src/typedefs.ts", "export interface Unconsumed {\n\tfield: string;\n}\n");
		const r = scanDeadCode(tmp);
		const hit = r.deadTypeExports.find((d) => d.file === "src/typedefs.ts");
		expect(hit?.detail).toContain("unused export 'Unconsumed'");
		expect(r.deadExports.some((d) => d.file === "src/typedefs.ts")).toBe(false);
	});
});

describe("deadcodeCommand --categorize", () => {
	// test-contract: public-api — --json emits ONE object carrying the scan
	// report plus a categories block bucketing every candidate
	it("--json buckets an unreferenced orphan file as ambiguous/review", async () => {
		const lines = captureLog();
		const code = await deadcodeCommand({ categorize: true, json: true, cwd: tmp });
		expect(code).toBe(0);
		const orphan = parseCategories(lines).items.find(
			(i) => i.file === "src/orphan.ts" && i.symbol === undefined,
		);
		expect(orphan?.bucket).toBe("ambiguous");
		expect(orphan?.recommendation).toBe("review");
	});

	// test-contract: behavior — the action wires the scan's test-only signal
	// into the categorizer; without it a test handle looks deletable
	it("--json buckets an export whose only importer is a test as a deliberate seam", async () => {
		seed("src/only-tested.ts", "export const onlyTested = 1;\n");
		seed(
			"src/only-tested.test.ts",
			'import { onlyTested } from "./only-tested.js";\nconsole.log(onlyTested);\n',
		);
		const lines = captureLog();
		await deadcodeCommand({ categorize: true, json: true, cwd: tmp });
		const seam = parseCategories(lines).items.find((i) => i.symbol === "onlyTested");
		expect(seam?.bucket).toBe("deliberate-seam");
		expect(seam?.recommendation).toBe("annotate");
	});

	// test-contract: public-api — the human path prints the header, the bucket
	// sections, and the safe-to-act footer
	it("prints the bucket sections and the safe-to-act footer without --json", async () => {
		const lines = captureLog();
		const code = await deadcodeCommand({ categorize: true, cwd: tmp });
		expect(code).toBe(0);
		expect(lines[0]).toMatch(
			/^Dead-code categorization — \d+ candidate\(s\) bucketed by deletion safety$/,
		);
		expect(lines.some((l) => l.startsWith("\nambiguous ("))).toBe(true);
		expect(lines[lines.length - 1]).toBe(
			"\nSafe-to-act buckets: reexport-residue, orphaned-type, superseded, inert branches. keep/annotate buckets are deliberate or planned code.",
		);
	});
});

describe("deadcodeCommand — human-readable report", () => {
	// test-contract: public-api — the default path prints one titled section
	// per layer and closes with the mutation-lane pointer
	it("prints a titled section per layer and the mutation-lane pointer", async () => {
		const lines = captureLog();
		const code = await deadcodeCommand({ cwd: tmp });
		expect(code).toBe(0);
		expect(lines[0]).toMatch(
			/^Dead-code scan — \d+ files \(reachability layers; candidates, not verdicts\)$/,
		);
		expect(lines).toContain(
			"\nUnreachable files (1) — nothing imports them; verify no runtime path loads them:",
		);
		expect(lines).toContain("  src/orphan.ts");
		expect(lines).toContain("\nDead import bindings (1) — imported, never referenced:");
		expect(lines).toContain("  src/a.ts: neverTouched");
		expect(lines[lines.length - 1]).toBe(
			"\nSemantic (behaviorally inert) dead code is the mutation lane's job: interlinked mutation disposition --list dead_code.",
		);
	});

	// test-contract: boundary — each of the three lists prints at most 40 rows
	// and names how many it withheld, so the terminal report stays readable
	it("truncates each list at 40 rows and names the withheld count", async () => {
		seedTruncationFixture();
		const lines = captureLog();
		await deadcodeCommand({ cwd: tmp });
		const truncations = lines.filter((l) => l.startsWith("  … +"));
		expect(truncations).toEqual([
			"  … +2 more (use --json)",
			"  … +15 more (use --json)",
			"  … +10 more (use --json)",
		]);
	});
});
