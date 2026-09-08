import { parseWire, wireArray, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	DEFAULT_MIN_COVERAGE_PCT,
	evaluateTestedFile,
	hasCompanionTest,
	isTestableSourceFile,
	loadUntestedFilesBaseline,
	minCoverageFor,
	resetUntestedFilesBaselineCache,
	type UntestedFilesBaseline,
} from "./tested-file-policy.js";

describe("DEFAULT_MIN_COVERAGE_PCT", () => {
	it("is the canonical 60% threshold", () => {
		expect(DEFAULT_MIN_COVERAGE_PCT).toBe(60);
	});

	// Single source of truth: the in-code default and the committed baseline's
	// min_coverage_pct MUST be the same number, so the enforced threshold is never
	// two values depending on whether a baseline loaded. Ratcheting the threshold
	// means changing BOTH together; this test fails the moment they drift apart.
	it("equals the committed baseline's min_coverage_pct (no drift)", () => {
		const baselinePath = join(
			process.cwd(),
			".interlinked",
			"untested-files-baseline.json",
		);
		const committed = parseWire(JSON.parse(readFileSync(baselinePath, "utf-8")), wireObject({ "min_coverage_pct": wireNumber }), "test JSON value");
		expect(committed.min_coverage_pct).toBe(DEFAULT_MIN_COVERAGE_PCT);
	});
});

describe("isTestableSourceFile", () => {
	// A module body with genuine runtime logic — the default for the path-axis
	// cases below, so only the path/extension gate is exercised.
	const LOGIC = "export function f(x: number): number {\n\tif (x > 0) return x;\n\treturn 0;\n}\n";

	it("flags hand-written source modules across adapter languages", () => {
		expect(isTestableSourceFile({ filePath: "src/harness/server.ts", content: LOGIC })).toBe(true);
		expect(isTestableSourceFile({ filePath: "src/lib/config.ts", content: LOGIC })).toBe(true);
		expect(isTestableSourceFile({ filePath: "pkg/handler.go", content: "func H() {}" })).toBe(true);
		expect(isTestableSourceFile({ filePath: "app/main.py", content: "def m():\n\treturn 1" })).toBe(true);
		expect(isTestableSourceFile({ filePath: "crate/src/lib.rs", content: "fn f() {}" })).toBe(true);
	});

	it("exempts test/spec files, declarations, and landing/static dirs", () => {
		expect(isTestableSourceFile({ filePath: "src/foo.test.ts", content: LOGIC })).toBe(false);
		expect(isTestableSourceFile({ filePath: "src/foo.spec.tsx", content: LOGIC })).toBe(false);
		expect(
			isTestableSourceFile({ filePath: "src/harness/__tests__/evaluator.test.ts", content: LOGIC }),
		).toBe(false);
		expect(isTestableSourceFile({ filePath: "src/api.d.ts", content: LOGIC })).toBe(false);
		expect(isTestableSourceFile({ filePath: "landing/index.ts", content: LOGIC })).toBe(false);
		expect(isTestableSourceFile({ filePath: "scripts/build.ts", content: LOGIC })).toBe(false);
	});

	it("exempts non-source extensions", () => {
		expect(isTestableSourceFile({ filePath: "docs/guide.md", content: "# doc" })).toBe(false);
		expect(isTestableSourceFile({ filePath: "config/data.json", content: "{}" })).toBe(false);
	});

	it("exempts benchmark sources (bench/ dir or *.bench.* infix)", () => {
		expect(isTestableSourceFile({ filePath: "bench/_helpers/warm.ts", content: LOGIC })).toBe(false);
		expect(
			isTestableSourceFile({ filePath: "bench/evaluator-hot-path.bench.ts", content: LOGIC }),
		).toBe(false);
		// A `.bench.ts` infix outside a bench/ dir is exempt too.
		expect(isTestableSourceFile({ filePath: "src/harness/foo.bench.ts", content: LOGIC })).toBe(false);
	});

	it("honors the // interlinked-tdd: exempt content directive", () => {
		const content = `// interlinked-tdd: exempt — wiring only\n${LOGIC}`;
		expect(isTestableSourceFile({ filePath: "src/harness/wiring.ts", content })).toBe(false);
		// Without the directive the same logic file is testable.
		expect(isTestableSourceFile({ filePath: "src/harness/wiring.ts", content: LOGIC })).toBe(true);
	});

	it("honors the @codegen-data header marker (template-string carriers)", () => {
		const content = `// @codegen-data — emitted into the generated .mjs\nexport const CHUNK = \`some ${"$"}{template} body with the word function inside\`;\n`;
		expect(isTestableSourceFile({ filePath: "src/lib/hook-template-chunks/x.ts", content })).toBe(
			false,
		);
	});

	it("exempts @generated files (no hand-written logic)", () => {
		const content = `// @generated supermodel-sidecar — do not edit\n${LOGIC}`;
		expect(isTestableSourceFile({ filePath: "src/harness/x.graph.ts", content })).toBe(false);
	});

	it("exempts a pure DATA / type-only module (no function-like logic)", () => {
		// const data records + type/interface only — nothing behavioral to test.
		const dataOnly = [
			"import type { CheckMeta } from './types.js';",
			"export type Sev = 'low' | 'high';",
			"export interface Rule { id: string; sev: Sev }",
			"export const META: Record<string, CheckMeta> = {",
			"\tfoo: { name: 'Foo', description: 'detects if(!x) for-loops while scanning', tier: 1 },",
			"\tbar: { name: 'Bar', description: 'returns nothing', tier: 2 },",
			"};",
			"export const RULES: Rule[] = [{ id: 'a', sev: 'high' }, { id: 'b', sev: 'low' }];",
			"",
		].join("\n");
		expect(isTestableSourceFile({ filePath: "src/harness/check-metadata/x.ts", content: dataOnly })).toBe(
			false,
		);
	});

	it("does NOT exempt a module that mixes data with a real function", () => {
		const mixed = [
			"export const TABLE = [1, 2, 3];",
			"export function pick(i: number): number {",
			"\treturn TABLE[i] ?? 0;",
			"}",
			"",
		].join("\n");
		expect(isTestableSourceFile({ filePath: "src/harness/x.ts", content: mixed })).toBe(true);
	});

	it("does NOT exempt a const arrow function as data (arrow is logic)", () => {
		const arrow = "export const add = (a: number, b: number): number => a + b;\n";
		expect(isTestableSourceFile({ filePath: "src/harness/x.ts", content: arrow })).toBe(true);
	});

	it("does NOT treat an empty / side-effect-only module as data-only", () => {
		// No declarations at all → not "data-only"; stays testable (conservative).
		expect(isTestableSourceFile({ filePath: "src/harness/side-effect.ts", content: "import './x.js';\n" })).toBe(
			true,
		);
	});
});

// Regression: the committed baseline must list ONLY files the corrected
// predicate still considers testable. If a file became exempt (gained a
// companion test, a `// interlinked-tdd: exempt` / `@codegen-data` marker, was
// recognized as DATA-only, etc.) it must be REMOVED from the baseline, not left
// as a grandfathered phantom. This pins the "no false positives in the
// baseline" invariant the re-seed established.
describe("committed baseline contains only genuinely-testable files", () => {
	it("every baseline entry is still testable under the corrected predicate", () => {
		const baselinePath = join(process.cwd(), ".interlinked", "untested-files-baseline.json");
		const committed = parseWire(JSON.parse(readFileSync(baselinePath, "utf-8")), wireObject({ "files": wireArray(wireString) }), "test JSON value");
		const exempt: string[] = [];
		for (const rel of committed.files) {
			let content: string;
			try {
				content = readFileSync(join(process.cwd(), rel), "utf-8");
			} catch {
				// A baseline entry pointing at a deleted file is its own problem,
				// surfaced elsewhere; skip it here so this test stays focused.
				continue;
			}
			if (!isTestableSourceFile({ filePath: rel, content })) exempt.push(rel);
		}
		expect(exempt).toEqual([]);
	});
});

describe("evaluateTestedFile", () => {
	const baseline: UntestedFilesBaseline = {
		version: 1,
		min_coverage_pct: 60,
		files: new Set(["src/legacy/old.ts"]),
	};

	it("flags an untested, non-grandfathered file (no companion, coverage below threshold)", () => {
		const verdict = evaluateTestedFile({
			input: { relPath: "src/new.ts", hasCompanion: false, coveragePct: 10 },
			baseline,
		});
		expect(verdict.untested).toBe(true);
		expect(verdict.grandfathered).toBe(false);
	});

	it("flags an untested file when coverage is null (file absent from the report)", () => {
		const verdict = evaluateTestedFile({
			input: { relPath: "src/orphan.ts", hasCompanion: false, coveragePct: null },
			baseline,
		});
		expect(verdict.untested).toBe(true);
		expect(verdict.grandfathered).toBe(false);
	});

	it("passes a file with a companion test regardless of coverage", () => {
		const withNullCov = evaluateTestedFile({
			input: { relPath: "src/tested.ts", hasCompanion: true, coveragePct: null },
			baseline,
		});
		expect(withNullCov.untested).toBe(false);
		const withLowCov = evaluateTestedFile({
			input: { relPath: "src/tested.ts", hasCompanion: true, coveragePct: 3 },
			baseline,
		});
		expect(withLowCov.untested).toBe(false);
	});

	it("passes a companion-less file whose coverage is at/above the threshold", () => {
		const atThreshold = evaluateTestedFile({
			input: { relPath: "src/covered.ts", hasCompanion: false, coveragePct: 60 },
			baseline,
		});
		expect(atThreshold.untested).toBe(false);
		const aboveThreshold = evaluateTestedFile({
			input: { relPath: "src/covered.ts", hasCompanion: false, coveragePct: 92 },
			baseline,
		});
		expect(aboveThreshold.untested).toBe(false);
	});

	it("grandfathers a baselined untested file (does not fail the gate)", () => {
		const verdict = evaluateTestedFile({
			input: { relPath: "src/legacy/old.ts", hasCompanion: false, coveragePct: null },
			baseline,
		});
		expect(verdict.untested).toBe(true);
		expect(verdict.grandfathered).toBe(true);
	});

	it("falls back to DEFAULT_MIN_COVERAGE_PCT when no baseline is loaded", () => {
		// 50% is below the default 60% threshold and there is no grandfather list.
		const verdict = evaluateTestedFile({
			input: { relPath: "src/x.ts", hasCompanion: false, coveragePct: 50 },
			baseline: null,
		});
		expect(verdict.untested).toBe(true);
		expect(verdict.grandfathered).toBe(false);
	});
});

describe("hasCompanionTest", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tfp-companion-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is true when a sibling *.test.ts exists", () => {
		writeFileSync(join(dir, "svc.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "svc.test.ts"), "import './svc.js';\n");
		expect(hasCompanionTest("svc.ts", dir)).toBe(true);
	});

	it("is true when a __tests__/*.test.ts exists", () => {
		writeFileSync(join(dir, "svc.ts"), "export const x = 1;\n");
		mkdirSync(join(dir, "__tests__"), { recursive: true });
		writeFileSync(join(dir, "__tests__", "svc.test.ts"), "import '../svc.js';\n");
		expect(hasCompanionTest("svc.ts", dir)).toBe(true);
	});

	it("is true when a sibling *.coverage.test.ts exists (infixed companion)", () => {
		// The repo convention `grep-accelerator.coverage.test.ts` — a
		// supplementary coverage suite — must count as a companion.
		writeFileSync(join(dir, "accel.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "accel.coverage.test.ts"), "import './accel.js';\n");
		expect(hasCompanionTest("accel.ts", dir)).toBe(true);
	});

	it("is true when a sibling *.fixtures.test.ts exists (infixed companion)", () => {
		writeFileSync(join(dir, "svc2.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "svc2.fixtures.test.ts"), "import './svc2.js';\n");
		expect(hasCompanionTest("svc2.ts", dir)).toBe(true);
	});

	it("is false when no companion exists", () => {
		writeFileSync(join(dir, "lonely.ts"), "export const x = 1;\n");
		expect(hasCompanionTest("lonely.ts", dir)).toBe(false);
	});
});

describe("loadUntestedFilesBaseline + minCoverageFor", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tfp-"));
		resetUntestedFilesBaselineCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetUntestedFilesBaselineCache();
	});

	it("returns null + the default threshold when no baseline file exists", () => {
		expect(loadUntestedFilesBaseline(dir)).toBeNull();
		expect(minCoverageFor(dir)).toBe(DEFAULT_MIN_COVERAGE_PCT);
	});

	it("loads min_coverage_pct and the grandfather set", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "untested-files-baseline.json"),
			JSON.stringify({ version: 1, min_coverage_pct: 70, files: ["src/a.ts", "src/b.ts"] }),
		);
		resetUntestedFilesBaselineCache();
		const baseline = loadUntestedFilesBaseline(dir);
		expect(baseline?.min_coverage_pct).toBe(70);
		expect(baseline?.files.has("src/a.ts")).toBe(true);
		expect(baseline?.files.has("src/b.ts")).toBe(true);
		expect(minCoverageFor(dir)).toBe(70);
	});

	it("fails soft to the default threshold on malformed JSON", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "untested-files-baseline.json"), "{ not json");
		resetUntestedFilesBaselineCache();
		expect(loadUntestedFilesBaseline(dir)).toBeNull();
		expect(minCoverageFor(dir)).toBe(DEFAULT_MIN_COVERAGE_PCT);
	});

	it("fails soft when min_coverage_pct is missing or non-numeric", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "untested-files-baseline.json"),
			JSON.stringify({ version: 1, files: ["src/a.ts"] }),
		);
		resetUntestedFilesBaselineCache();
		expect(loadUntestedFilesBaseline(dir)).toBeNull();
	});
});
