// Companion test for shared-path-heuristics.ts — moved verbatim from
// shared.ts as part of the shared.ts line-cap split. Behavior unchanged.

import { describe, expect, it } from "vitest";
import {
	collectFunctionSignature,
	countTopLevelCommas,
	isScriptOrCliPath,
	isVendoredOrFixturePath,
} from "./shared-path-heuristics.js";

describe("collectFunctionSignature", () => {
	it("collects lines up to and including the line containing '{'", () => {
		const lines = ["function foo(a: number, b: string) {", "  return a;", "}"];
		expect(collectFunctionSignature(lines, 0)).toBe(" function foo(a: number, b: string) {");
	});

	it("stops at '=>' when it appears before '{'", () => {
		const lines = ["const foo = (a: number) =>", "  a + 1;"];
		expect(collectFunctionSignature(lines, 0)).toBe(" const foo = (a: number) =>");
	});

	it("stops after 20 lines even without a brace/arrow", () => {
		const lines = Array.from({ length: 25 }, (_, i) => `line${i}`);
		const sig = collectFunctionSignature(lines, 0);
		expect(sig.trim().split(" ")).toHaveLength(20);
	});
});

describe("countTopLevelCommas", () => {
	it("returns 1 for a single parameter", () => {
		expect(countTopLevelCommas("a: number")).toBe(1);
	});

	it("returns 1 for an empty string (count-of-items, not count-of-commas)", () => {
		expect(countTopLevelCommas("")).toBe(1);
	});

	it("counts top-level commas, ignoring commas nested in <>, (), {}, []", () => {
		expect(countTopLevelCommas("a: Map<string, number>, b: (x: number, y: number) => void")).toBe(
			2,
		);
	});
});

describe("isVendoredOrFixturePath — positive (must fire)", () => {
	it("flags node_modules/", () => {
		expect(isVendoredOrFixturePath("pkg/node_modules/foo/index.js")).toBe(true);
	});

	it("flags vendor/ and third_party/", () => {
		expect(isVendoredOrFixturePath("vendor/lib.go")).toBe(true);
		expect(isVendoredOrFixturePath("third_party/foo.py")).toBe(true);
	});

	it("flags dist/build/coverage output dirs", () => {
		expect(isVendoredOrFixturePath("dist/index.js")).toBe(true);
		expect(isVendoredOrFixturePath("coverage/lcov.info")).toBe(true);
	});

	it("flags minified/bundle filenames", () => {
		expect(isVendoredOrFixturePath("assets/app.min.js")).toBe(true);
		expect(isVendoredOrFixturePath("assets/app.bundle.css")).toBe(true);
	});

	it("flags __fixtures__ and __mocks__ dunder dirs", () => {
		expect(isVendoredOrFixturePath("src/checks/__fixtures__/sample.ts")).toBe(true);
		expect(isVendoredOrFixturePath("src/__mocks__/fs.ts")).toBe(true);
	});
});

describe("isVendoredOrFixturePath — negative (must not fire)", () => {
	it("does not flag a directory name that merely contains 'vendor'", () => {
		expect(isVendoredOrFixturePath("myvendor/index.ts")).toBe(false);
	});

	it("does not flag ordinary source", () => {
		expect(isVendoredOrFixturePath("src/harness/checks/shared.ts")).toBe(false);
	});
});

describe("isScriptOrCliPath — positive (must fire)", () => {
	it("flags scripts/ and bin/", () => {
		expect(isScriptOrCliPath("scripts/sync_version.py")).toBe(true);
		expect(isScriptOrCliPath("bin/wizard.go")).toBe(true);
	});

	it("flags examples/ and tutorials/", () => {
		expect(isScriptOrCliPath("examples/basic.ts")).toBe(true);
		expect(isScriptOrCliPath("tutorials/01-intro.py")).toBe(true);
	});
});

describe("isScriptOrCliPath — negative (must not fire)", () => {
	it("does not flag a directory merely containing 'scripts'", () => {
		expect(isScriptOrCliPath("myscripts/index.ts")).toBe(false);
	});

	it("does not flag ordinary product source", () => {
		expect(isScriptOrCliPath("src/harness/checks/shared.ts")).toBe(false);
	});
});
