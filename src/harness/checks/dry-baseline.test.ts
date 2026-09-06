import { describe, expect, it } from "vitest";
import { extractFunctionShingles, findClones } from "./dry.js";
import { filterToRisers, firstValue, snapshotDryShingles } from "./dry-baseline.js";

const cloneBody = `{
	const out = [];
	for (const row of rows) {
		if (row.enabled) {
			out.push(row.value);
		}
	}
	return out;
}`;

describe("dry-baseline — riser filter", () => {
	it("suppresses pre-existing duplication the edit did not introduce", () => {
		// File already had two clones BEFORE the edit.
		const pre = `
function collectA(rows: Row[]): number[] ${cloneBody}
function collectB(rows: Row[]): number[] ${cloneBody}
`;
		const baseline = snapshotDryShingles({
			preContent: pre,
			filePath: "src/collect.ts",
			candidates: [],
		});
		// Post-edit: same two clones still there (edit touched something else).
		const post = extractFunctionShingles(pre, "src/collect.ts");
		const current = findClones({ edited: post, candidates: [] });
		expect(current.length).toBe(1); // detector still sees it
		const risers = filterToRisers(current, baseline);
		expect(risers.length).toBe(0); // but baseline suppresses it
	});

	it("surfaces a clone the edit newly introduced", () => {
		const pre = `
function collectA(rows: Row[]): number[] ${cloneBody}
`;
		const baseline = snapshotDryShingles({
			preContent: pre,
			filePath: "src/collect.ts",
			candidates: [],
		});
		// Post-edit: a second clone was added.
		const post = `
function collectA(rows: Row[]): number[] ${cloneBody}
function collectB(rows: Row[]): number[] ${cloneBody}
`;
		const postFns = extractFunctionShingles(post, "src/collect.ts");
		const current = findClones({ edited: postFns, candidates: [] });
		const risers = filterToRisers(current, baseline);
		expect(risers.length).toBe(1);
	});

	it("passes through everything when the baseline is empty", () => {
		const fns = extractFunctionShingles(
			`function collectA(rows: Row[]): number[] ${cloneBody}\nfunction collectB(rows: Row[]): number[] ${cloneBody}`,
			"src/collect.ts",
		);
		const current = findClones({ edited: fns, candidates: [] });
		const risers = filterToRisers(current, new Map());
		expect(risers).toEqual(current);
	});

	it("snapshot of a file with no functions yields an empty baseline", () => {
		const baseline = snapshotDryShingles({
			preContent: "export const X = 1;\n",
			filePath: "src/const.ts",
			candidates: [],
		});
		expect(baseline.size).toBe(0);
	});

	it("firstValue returns undefined for an empty map instead of iterating forever", () => {
		// filterToRisers short-circuits on baseline.size === 0 before ever
		// calling firstValue, so this exercises the fallback directly: an
		// empty map has nothing to yield from the for..of, so control must
		// fall through to the explicit `return undefined`.
		expect(firstValue(new Map())).toBeUndefined();
	});

	it("firstValue returns the sole entry's value for a single-key map", () => {
		const inner = new Map([["a<=>b", 0.9]]);
		const baseline: Map<string, Map<string, number>> = new Map([["src/collect.ts", inner]]);
		expect(firstValue(baseline)).toBe(inner);
	});
});
