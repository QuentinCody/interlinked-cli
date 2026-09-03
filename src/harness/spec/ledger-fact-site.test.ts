import { describe, expect, it } from "vitest";
import { representativeSites } from "./ledger-fact-site.js";

describe("ledger-fact-site — representativeSites", () => {
	it("returns one summary site per distinct value", () => {
		const list = [
			{ file: "a.md", line: 1, value: "10" },
			{ file: "b.md", line: 2, value: "10" },
			{ file: "c.md", line: 3, value: "20" },
		];
		const { summary } = representativeSites(list, 10);
		expect(summary).toHaveLength(2);
		expect(summary.map((s) => s.value)).toEqual(["10", "20"]);
	});

	it("bounds findings by findingCap and dedupes by file", () => {
		const list = [
			{ file: "a.md", line: 1, value: "10" },
			{ file: "b.md", line: 2, value: "20" },
			{ file: "c.md", line: 3, value: "30" },
		];
		const { findings } = representativeSites(list, 2);
		expect(findings).toHaveLength(2);
	});

	it("pins the scoped file first so it always survives the cap", () => {
		const list = [
			{ file: "a.md", line: 1, value: "10" },
			{ file: "b.md", line: 2, value: "10" },
			{ file: "scoped.md", line: 3, value: "10" },
		];
		const { findings } = representativeSites(list, 1, "scoped.md");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.file).toBe("scoped.md");
	});

	it("returns no findings for an empty list", () => {
		const { summary, findings } = representativeSites([], 10);
		expect(summary).toEqual([]);
		expect(findings).toEqual([]);
	});
});
