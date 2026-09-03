// Companion test for b-series-credentials.ts.
// Full behavioral coverage for these three checks lives in b-series.test.ts
// (imported via the re-export in b-series.ts, exercising the identical
// exported functions this module defines). This file is a smoke test
// confirming each export is reachable directly from its new home and still
// exercises its documented positive/negative path.

import { describe, expect, it } from "vitest";
import {
	checkHardcodedCredentials,
	checkInfiniteRecursion,
	checkSuppressionDensity,
} from "./b-series-credentials.js";

describe("checkSuppressionDensity", () => {
	it("flags a file with high suppression directive density", () => {
		const lines = Array.from({ length: 20 }, (_, i) =>
			i < 3 ? "// @ts-ignore reason" : `const x${i} = ${i};`,
		);
		const result = checkSuppressionDensity(lines.join("\n"), "thing.ts");
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toMatch(/High suppression density/);
	});

	it("returns [] for a low-density file", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`);
		expect(checkSuppressionDensity(lines.join("\n"), "thing.ts")).toEqual([]);
	});
});

describe("checkHardcodedCredentials", () => {
	it("flags a hardcoded password literal", () => {
		const content = 'const password = "sup3rSecretValue";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([
			{ line: 1, text: content },
		]);
	});

	it("skips known placeholder values", () => {
		const content = 'const password = "changeme";';
		expect(checkHardcodedCredentials(content, "config.ts")).toEqual([]);
	});

	it("skips test files entirely", () => {
		const content = 'const password = "sup3rSecretValue";';
		expect(checkHardcodedCredentials(content, "config.test.ts")).toEqual([]);
	});
});

describe("checkInfiniteRecursion", () => {
	it("flags a self-call with no guard", () => {
		const content = "function loop() {\n  loop();\n}";
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([
			{ line: 2, text: "loop();" },
		]);
	});

	it("does not flag a self-call preceded by a guard", () => {
		const content = "function loop(n) {\n  if (n <= 0) return;\n  loop(n - 1);\n}";
		expect(checkInfiniteRecursion(content, "f.ts")).toEqual([]);
	});
});
