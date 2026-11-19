import { describe, expect, it } from "vitest";
import { parseCompleteEslintJson, parseEslintJson } from "./output-parsers-eslint-json.js";

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
	it("retains typed findings alongside invalid rows and rejects unreadable report envelopes", () => {
		const tool = "tseslint-types";
		expect(() => parseCompleteEslintJson("not a report", tool)).toThrow("malformed JSON");
		expect(() => parseCompleteEslintJson("{}", tool)).toThrow("must be an array");
		expect(() => parseCompleteEslintJson('[{"filePath":"x.ts","messages":[{"message":"typed warning"},null]}]', tool))
			.toThrow(expect.objectContaining({ results: [expect.objectContaining({ file: "x.ts", tool, message: "typed warning" })] }));
		expect(parseCompleteEslintJson("[]", tool)).toEqual([]);
	});
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

	it("keeps valid messages when neighboring rows and optional fields are malformed", () => {
		const out = parseEslintJson(JSON.stringify([
			null,
			{ filePath: "a.ts", messages: [null, { message: 5 }, { message: "real warning", ruleId: { bad: true }, line: "7" }] },
		]));
		expect(out).toEqual([{
			tool: "eslint", severity: "warning", file: "a.ts", line: 0, column: 0,
			message: "real warning", ruleId: undefined,
		}]);
	});
});
