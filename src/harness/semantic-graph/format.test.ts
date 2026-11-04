import { describe, expect, it } from "vitest";
import { formatCell, formatEdgeLines, formatMetricsTable } from "./format.js";
import type { Edge, TypeMetrics } from "./types.js";

function edge(overrides: Partial<Edge> & { source: string }): Edge {
	return {
		type: "pins",
		target: "a.ts#function:f@1",
		p: 0.8,
		probabilities: { c1: 0.8, none: 0.2 },
		confidence: 0.6,
		candidates: ["a.ts#function:f@1"],
		packet_hash: "h",
		source_hash: "s",
		model: "jev-latest",
		judged_at: "2026-10-27T00:00:00.000Z",
		state: "proposed",
		...overrides,
	};
}

const metrics: TypeMetrics[] = [
	{
		type: "pins",
		orphans: { count: 3, of: 12 },
		mismatches: { count: 1, of: 4 },
		hidden_coupling: { count: 0, of: 0 },
		churn: { count: 2, of: 3 },
	},
	{
		type: "promises",
		orphans: { count: 0, of: 5 },
		mismatches: { count: 0, of: 0 },
		hidden_coupling: { count: 5, of: 5 },
		churn: { count: 0, of: 0 },
	},
];

describe("format — positive (must fire)", () => {
	it("P1: every cell carries count, denominator and percent", () => {
		expect(formatCell({ count: 3, of: 12 })).toBe("3/12 (25%)");
		expect(formatCell({ count: 2, of: 3 })).toBe("2/3 (67%)");
		expect(formatCell({ count: 5, of: 5 })).toBe("5/5 (100%)");
	});

	it("P2: the table has a header and one row per type with every metric", () => {
		const lines = formatMetricsTable(metrics).split("\n");
		expect(lines[0]).toMatch(/^type\s+orphans\s+mismatches\s+hidden_coupling\s+churn$/);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toMatch(/^pins\s+3\/12 \(25%\)\s+1\/4 \(25%\)\s+—\s+2\/3 \(67%\)$/);
		expect(lines[2]).toMatch(/^promises\s+0\/5 \(0%\)\s+—\s+5\/5 \(100%\)\s+—$/);
	});

	it("P3: edge lines show type, p, state, source → target and honor the limit", () => {
		const edges = [
			edge({ source: "a.test.ts#test:one@1" }),
			edge({ source: "a.test.ts#test:two@2", target: null, p: 0.55, state: "stale" }),
			edge({ source: "a.test.ts#test:three@3", state: "confirmed", p: 1 }),
		];
		const lines = formatEdgeLines(edges, 2);
		expect(lines).toEqual([
			"pins  0.80  proposed  a.test.ts#test:one@1 → a.ts#function:f@1",
			"pins  0.55  stale  a.test.ts#test:two@2 → none",
		]);
		expect(formatEdgeLines(edges, 10)).toHaveLength(3);
	});
});

describe("format — negative (must not fire)", () => {
	it("N1: a zero denominator renders as a dash, never a percent", () => {
		expect(formatCell({ count: 0, of: 0 })).toBe("—");
		expect(formatMetricsTable(metrics)).not.toContain("NaN");
	});

	it("N2: an empty metrics list is only the header and an empty edge list is no lines", () => {
		expect(formatMetricsTable([]).split("\n")).toHaveLength(1);
		expect(formatEdgeLines([], 5)).toEqual([]);
		expect(formatEdgeLines([edge({ source: "s" })], 0)).toEqual([]);
	});
});
