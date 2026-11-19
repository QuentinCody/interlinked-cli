import { describe, expect, it } from "vitest";
import { detectCjsInEsm } from "./esm-cjs.js";

// Census fault: `new Set([".mjs", ".mts"])` → `new Set([".mjs"])` survived the
// companion test (docs/reviews/kill-proof-census-harness.md).
describe("detectCjsInEsm — .mts is ESM by extension", () => {
	// test-contract: public-api — an .mts file is an ES module even with no import/export line, so require() is reported
	it("flags require() in an .mts file that has no import or export", () => {
		expect(detectCjsInEsm('const fs = require("node:fs");', "/repo/src/load.mts")).toEqual([
			{ line: 1, text: 'const fs = require("node:fs");' },
		]);
	});

	// test-contract: boundary — the same source in a .ts file without ESM syntax is not judged ESM
	it("does not flag the same source in a .ts file without import/export", () => {
		expect(detectCjsInEsm('const fs = require("node:fs");', "/repo/src/load.ts")).toEqual([]);
	});
});
