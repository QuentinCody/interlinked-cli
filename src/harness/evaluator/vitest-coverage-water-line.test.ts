// Companion test for `vitest-coverage-water-line.ts`.
//
// The vitest coverage denominator (`coverage.include` / `coverage.exclude`) is
// a ratchet water-line exactly like `.interlinked/coverage-baseline.json`:
// excluding a file raises the coverage percentage without adding a test. These
// cases pin the block direction (exclude grows / include shrinks) and — far
// more importantly for a BLOCKING gate — every fail-open path, because a wrong
// block stops real work.
//
// Labeling convention: per-test `P<n>:` / `N<n>:` prefixes (Check Evidence
// Contract). P = must fire (block). N = must not fire (allow).

import { describe, expect, it } from "vitest";
import {
	type CoverageExtraction,
	decideVitestCoverageWaterLine,
	extractVitestCoverageArrays,
	isVitestConfigFile,
	type WaterLineVerdict,
} from "./vitest-coverage-water-line.js";

const FILE = "vitest.config.ts";

// --------------------------------------------------------------------------
// Narrowing assertions. They live OUTSIDE the `it()` bodies deliberately: a
// discriminated-union result needs one branch to reach its payload, and the
// harness's `conditional_in_test` check (rightly) refuses branching inside a
// case body. Each throws with the observed variant so a failure names it.
// --------------------------------------------------------------------------

function blockReason(v: WaterLineVerdict): string {
	if (v.kind !== "block") throw new Error(`expected a block verdict, got "${v.kind}"`);
	return v.reason;
}

function allowWarning(v: WaterLineVerdict): string {
	if (v.kind !== "allow") throw new Error(`expected an allow verdict, got "${v.kind}"`);
	if (v.warning === undefined) throw new Error("expected the allow verdict to carry a warning");
	return v.warning;
}

function okArrays(r: CoverageExtraction): { include: string[] | null; exclude: string[] | null } {
	if (r.kind !== "ok") throw new Error(`expected an ok extraction, got "${r.kind}"`);
	return r.arrays;
}

function undecidableDetail(r: CoverageExtraction): string {
	if (r.kind !== "undecidable") throw new Error(`expected undecidable, got "${r.kind}"`);
	return r.detail;
}

/** Build a vitest config whose `coverage` block carries the given body.
 *  Written as real TS source (not JSON) because that is what the extractor
 *  must parse. */
function cfg(coverageBody: string): string {
	return [
		'import { defineConfig } from "vitest/config";',
		"",
		"export default defineConfig({",
		"	test: {",
		'		include: ["src/**/*.test.ts"],',
		"		coverage: {",
		`			${coverageBody}`,
		"		},",
		"	},",
		"});",
		"",
	].join("\n");
}

const BASE = cfg(
	[
		'provider: "v8",',
		'			include: ["src/**/*.ts", "src/**/*.tsx"],',
		'			exclude: ["node_modules/**", "**/*.test.ts"],',
	].join("\n"),
);

// ==========================================================================
// isVitestConfigFile — routing
// ==========================================================================

describe("isVitestConfigFile", () => {
	it("P1: routes vitest.config.ts / .mts / .js / .mjs", () => {
		expect([
			isVitestConfigFile("vitest.config.ts"),
			isVitestConfigFile("vitest.config.mts"),
			isVitestConfigFile("vitest.config.js"),
			isVitestConfigFile("vitest.config.mjs"),
		]).toEqual([true, true, true, true]);
	});

	it("P2: routes the qualified vitest.<name>.config.<ext> shape", () => {
		expect([
			isVitestConfigFile("vitest.unit.config.ts"),
			isVitestConfigFile("vitest.integration.config.ts"),
			isVitestConfigFile("/abs/repo/vitest.stryker.config.ts"),
		]).toEqual([true, true, true]);
	});

	it("P3: routes vite.config.<ext> (vitest reads it when no vitest.config exists)", () => {
		expect([
			isVitestConfigFile("vite.config.ts"),
			isVitestConfigFile("packages/web/vite.config.mts"),
		]).toEqual([true, true]);
	});

	it("N1: does not route unrelated files", () => {
		expect([
			isVitestConfigFile("tsconfig.json"),
			isVitestConfigFile("src/vitest.ts"),
			isVitestConfigFile("vitest.config.ts.bak"),
			isVitestConfigFile("myvitest.config.ts"),
			isVitestConfigFile("jest.config.ts"),
		]).toEqual([false, false, false, false, false]);
	});
});

// ==========================================================================
// extractVitestCoverageArrays
// ==========================================================================

describe("extractVitestCoverageArrays", () => {
	it("P1: reads both literal arrays out of the coverage block", () => {
		expect(okArrays(extractVitestCoverageArrays(BASE, FILE))).toEqual({
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: ["node_modules/**", "**/*.test.ts"],
		});
	});

	it("N1: a config with no `coverage:` block yields two nulls, not an error", () => {
		const src = [
			'import { defineConfig } from "vitest/config";',
			"export default defineConfig({",
			'	test: { include: ["src/**/*.integration.test.ts"] },',
			"});",
		].join("\n");
		expect(extractVitestCoverageArrays(src, "vitest.integration.config.ts")).toEqual({
			kind: "ok",
			arrays: { include: null, exclude: null },
		});
	});

	it("N2: a spread member makes the array undecidable, naming the member", () => {
		const detail = undecidableDetail(
			extractVitestCoverageArrays(cfg('exclude: [...BASE_EXCLUDE, "src/new/**"],'), FILE),
		);
		expect(detail).toContain("coverage.exclude");
		expect(detail).toContain("BASE_EXCLUDE");
	});

	it("N3: an identifier initializer is undecidable", () => {
		expect(
			undecidableDetail(extractVitestCoverageArrays(cfg("exclude: DEFAULT_EXCLUDES,"), FILE)),
		).toContain("coverage.exclude");
	});

	it("N4: a template literal with an expression is undecidable", () => {
		expect(
			undecidableDetail(extractVitestCoverageArrays(cfg("exclude: [`${ROOT}/**`],"), FILE)),
		).toContain("coverage.exclude");
	});

	it("N5: a call expression member is undecidable", () => {
		expect(
			undecidableDetail(extractVitestCoverageArrays(cfg('include: [globFor("src")],'), FILE)),
		).toContain("coverage.include");
	});

	it("N6: a spread INSIDE the coverage object is undecidable", () => {
		expect(
			undecidableDetail(
				extractVitestCoverageArrays(cfg('...baseCoverage,\n			exclude: ["a"],'), FILE),
			),
		).toContain("spread");
	});

	it("N7: two `coverage:` object literals in one file are undecidable", () => {
		const src = [
			'export const a = { coverage: { exclude: ["x"] } };',
			'export const b = { coverage: { exclude: ["y"] } };',
		].join("\n");
		expect(undecidableDetail(extractVitestCoverageArrays(src, FILE))).toContain("coverage");
	});

	it("N8: a syntax error reports parse_error rather than a guess", () => {
		expect(
			extractVitestCoverageArrays("export default { coverage: { exclude: [ , }", FILE).kind,
		).toBe("parse_error");
	});

	it("N9: a no-substitution template literal member counts as a literal", () => {
		expect(okArrays(extractVitestCoverageArrays(cfg("exclude: [`node_modules/**`],"), FILE))).toEqual(
			{ include: null, exclude: ["node_modules/**"] },
		);
	});
});

// ==========================================================================
// decideVitestCoverageWaterLine — the blocking decision
// ==========================================================================

describe("decideVitestCoverageWaterLine", () => {
	it("P1: a new coverage.exclude member BLOCKS and the reason names it", () => {
		const after = cfg(
			[
				'provider: "v8",',
				'			include: ["src/**/*.ts", "src/**/*.tsx"],',
				'			exclude: ["node_modules/**", "**/*.test.ts", "src/harness/legacy/**"],',
			].join("\n"),
		);
		const reason = blockReason(decideVitestCoverageWaterLine(FILE, BASE, after));
		expect(reason).toContain("src/harness/legacy/**");
		expect(reason).toContain("coverage.exclude");
		expect(reason).toContain("INTERLINKED_DISABLE_BASELINE_GUARD=1");
		expect(reason).toContain(FILE);
	});

	it("P2: a dropped coverage.include member BLOCKS and the reason names it", () => {
		const after = cfg(
			[
				'provider: "v8",',
				'			include: ["src/**/*.ts"],',
				'			exclude: ["node_modules/**", "**/*.test.ts"],',
			].join("\n"),
		);
		const reason = blockReason(decideVitestCoverageWaterLine(FILE, BASE, after));
		expect(reason).toContain("src/**/*.tsx");
		expect(reason).toContain("coverage.include");
	});

	it("P3: both loosenings at once are reported in one reason", () => {
		const after = cfg(
			[
				'provider: "v8",',
				'			include: ["src/**/*.ts"],',
				'			exclude: ["node_modules/**", "**/*.test.ts", "src/generated/**"],',
			].join("\n"),
		);
		const reason = blockReason(decideVitestCoverageWaterLine(FILE, BASE, after));
		expect(reason).toContain("src/generated/**");
		expect(reason).toContain("src/**/*.tsx");
	});

	it("N1: a byte-identical rewrite allows with no warning", () => {
		expect(decideVitestCoverageWaterLine(FILE, BASE, BASE)).toEqual({ kind: "allow" });
	});

	it("N2: a realistic full coverage block compared with itself allows", () => {
		// Guards the exact false positive that would stop real work: re-writing
		// the shipped config unchanged.
		const real = cfg(
			[
				'provider: "v8",',
				'			include: ["src/**/*.ts", "src/**/*.tsx"],',
				'			reporter: ["text-summary", "json", "json-summary", "lcov"],',
				"			reportOnFailure: true,",
				'			reportsDirectory: "coverage",',
				'			exclude: ["node_modules/**", "coverage/**", "**/*.test.ts", "dist/**"],',
			].join("\n"),
		);
		expect(decideVitestCoverageWaterLine(FILE, real, real)).toEqual({ kind: "allow" });
	});

	it("N3: a SHRINKING exclude list allows (tightening the denominator)", () => {
		const after = cfg(
			[
				'provider: "v8",',
				'			include: ["src/**/*.ts", "src/**/*.tsx"],',
				'			exclude: ["node_modules/**"],',
			].join("\n"),
		);
		expect(decideVitestCoverageWaterLine(FILE, BASE, after)).toEqual({ kind: "allow" });
	});

	it("N4: a GROWING include list allows", () => {
		const after = cfg(
			[
				'provider: "v8",',
				'			include: ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.mts"],',
				'			exclude: ["node_modules/**", "**/*.test.ts"],',
			].join("\n"),
		);
		expect(decideVitestCoverageWaterLine(FILE, BASE, after)).toEqual({ kind: "allow" });
	});

	it("N5: reordering and duplicating members allows (set semantics)", () => {
		const after = cfg(
			[
				'provider: "v8",',
				'			include: ["src/**/*.tsx", "src/**/*.ts", "src/**/*.ts"],',
				'			exclude: ["**/*.test.ts", "node_modules/**", "**/*.test.ts"],',
			].join("\n"),
		);
		expect(decideVitestCoverageWaterLine(FILE, BASE, after)).toEqual({ kind: "allow" });
	});

	it("N6: reformatting (comments, trailing commas, quote style) allows", () => {
		const after = [
			'import { defineConfig } from "vitest/config";',
			"export default defineConfig({",
			"	test: {",
			'		include: ["src/**/*.test.ts"],',
			"		coverage: {",
			'			provider: "v8",',
			"			// scope strictly to our source",
			"			include: [",
			"				'src/**/*.ts',",
			"				'src/**/*.tsx',",
			"			],",
			"			exclude: ['node_modules/**', '**/*.test.ts'],",
			"		},",
			"	},",
			"});",
		].join("\n");
		expect(decideVitestCoverageWaterLine(FILE, BASE, after)).toEqual({ kind: "allow" });
	});

	it("N7: an untracked file (no HEAD blob) allows", () => {
		const after = cfg('exclude: ["everything/**"],');
		expect(decideVitestCoverageWaterLine(FILE, "", after)).toEqual({ kind: "allow" });
	});

	it("N8: editing thresholds / reporters inside coverage allows", () => {
		const before = cfg(
			['provider: "v8",', '			include: ["src/**/*.ts"],', "			thresholds: { lines: 80 },"].join(
				"\n",
			),
		);
		const after = cfg(
			['provider: "v8",', '			include: ["src/**/*.ts"],', "			thresholds: { lines: 60 },"].join(
				"\n",
			),
		);
		expect(decideVitestCoverageWaterLine(FILE, before, after)).toEqual({ kind: "allow" });
	});

	it("N9: adding a TEST-level include glob (not coverage.include) allows", () => {
		const after = BASE.replace(
			'include: ["src/**/*.test.ts"],',
			'include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],',
		);
		expect(after).not.toBe(BASE);
		expect(decideVitestCoverageWaterLine(FILE, BASE, after)).toEqual({ kind: "allow" });
	});

	it("N10: a lane config that spreads the base and adds no coverage arrays allows", () => {
		const before = [
			'import baseConfig from "./vitest.config";',
			"export default { ...baseConfig, test: { ...baseConfig.test } };",
		].join("\n");
		const after = [
			'import baseConfig from "./vitest.config";',
			'export default { ...baseConfig, test: { ...baseConfig.test, exclude: ["**/*.integration.test.ts"] } };',
		].join("\n");
		expect(decideVitestCoverageWaterLine("vitest.unit.config.ts", before, after)).toEqual({
			kind: "allow",
		});
	});

	it("N11: a non-literal member on the PROPOSED side allows and warns, naming it", () => {
		const after = cfg('exclude: [...BASE_EXCLUDE, "src/new/**"],');
		const warning = allowWarning(decideVitestCoverageWaterLine(FILE, BASE, after));
		expect(warning).toContain("BASE_EXCLUDE");
		expect(warning).toContain(FILE);
	});

	it("N12: a non-literal member on the HEAD side allows and warns", () => {
		const before = cfg("exclude: DEFAULT_EXCLUDES,");
		const after = cfg('exclude: ["a", "b", "c"],');
		expect(allowWarning(decideVitestCoverageWaterLine(FILE, before, after))).toContain(
			"coverage.exclude",
		);
	});

	it("N13: a syntax error on either side allows and warns", () => {
		const broken = "export default { coverage: { exclude: [ , }";
		expect(allowWarning(decideVitestCoverageWaterLine(FILE, BASE, broken))).toMatch(
			/parse|syntax/i,
		);
	});

	it("N14: introducing coverage.exclude where HEAD had none allows with a warning", () => {
		const before = cfg('include: ["src/**/*.ts"],');
		const after = cfg(
			['include: ["src/**/*.ts"],', '			exclude: ["src/legacy/**"],'].join("\n"),
		);
		expect(allowWarning(decideVitestCoverageWaterLine(FILE, before, after))).toContain(
			"coverage.exclude",
		);
	});

	it("N15: removing coverage.include entirely allows with a warning (widens scope)", () => {
		const after = cfg(
			['provider: "v8",', '			exclude: ["node_modules/**", "**/*.test.ts"],'].join("\n"),
		);
		expect(allowWarning(decideVitestCoverageWaterLine(FILE, BASE, after))).toContain(
			"coverage.include",
		);
	});
});
