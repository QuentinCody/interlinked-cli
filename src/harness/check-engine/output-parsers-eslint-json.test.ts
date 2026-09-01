import { describe, expect, it } from "vitest";
import { parseEslintJson } from "./output-parsers-eslint-json.js";

const SAMPLE = JSON.stringify([
	{
		filePath: "/repo/src/a.ts",
		messages: [
			{
				ruleId: "@typescript-eslint/no-unnecessary-condition",
				severity: 2,
				message: "Unnecessary conditional, value is always truthy.",
				line: 12,
				column: 7,
			},
			{ ruleId: null, severity: 1, message: "Parsing warning", line: 1, column: 1 },
		],
	},
	{ filePath: "/repo/src/clean.ts", messages: [] },
]);

describe("parseEslintJson — positive (must fire)", () => {
	it("P1: maps each message to a CheckResult with rule id, severity and position", () => {
		const out = parseEslintJson(SAMPLE, "tseslint-types");
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({
			tool: "tseslint-types",
			severity: "error",
			file: "/repo/src/a.ts",
			line: 12,
			column: 7,
			ruleId: "@typescript-eslint/no-unnecessary-condition",
		});
		expect(out[0]?.message).toContain("[@typescript-eslint/no-unnecessary-condition]");
		expect(out[1]).toMatchObject({ severity: "warning", ruleId: undefined });
	});

	it("P2: tolerates a non-JSON preamble before the array (npx banners)", () => {
		const out = parseEslintJson(`npm warn something\n${SAMPLE}`);
		expect(out).toHaveLength(2);
		expect(out[0]?.tool).toBe("eslint");
	});
});

describe("parseEslintJson — negative (must not fire)", () => {
	it("N1: empty / non-array / malformed input yields no results", () => {
		expect(parseEslintJson("")).toEqual([]);
		expect(parseEslintJson("{}")).toEqual([]);
		expect(parseEslintJson("[not json")).toEqual([]);
	});

	it("N2: entries without a filePath or messages array are skipped", () => {
		expect(parseEslintJson(JSON.stringify([{ messages: [] }, { filePath: "x" }, 7]))).toEqual([]);
	});
});
