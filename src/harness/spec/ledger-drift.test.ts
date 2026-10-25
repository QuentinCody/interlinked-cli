import { describe, expect, it } from "vitest";
import { SpecLedger } from "./ledger.js";
import { foldLooseDefinedIds, type GlobalNamespace } from "./ledger-drift.js";
import { extractSpecFacts } from "./extract-facts.js";

const never = (): boolean => false;

it("extends a legacy namespace without a per-file index when a new file defines another id", () => {
    const namespace: GlobalNamespace = {
        prefix: "G", style: "compact", nums: new Set([1, 2]), max: 2,
        files: ["registry.md"], definingFiles: ["registry.md"],
    };
    foldLooseDefinedIds(new Map([["compact G", namespace]]), new Map([
        ["extra.md", extractSpecFacts("- G5 fifth gate", "extra.md")],
    ]));
    expect([...namespace.nums]).toEqual([1, 2, 5]);
    expect(namespace.max).toBe(5);
    expect(namespace.files).toEqual(["registry.md", "extra.md"]);
    expect(namespace.definingFiles).toEqual(["registry.md", "extra.md"]);
});

// Round-5 #3: a local registry that disagrees with the claim suppresses the
// cross-file finding ONLY when the global census adds nothing beyond it.
describe("split-registry suppression refinement (round-5 #3)", () => {
	it("fires range drift when another file extends the registry", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"a.md": [
					"| X-01 | a |",
					"| X-20 | b |",
					"Valid for X-01 through X-10.",
				].join("\n"),
				"b.md": "| X-21 | c |\n| X-30 | d |",
			},
			never,
		);
		const range = l.computeDrift().filter((f) => f.kind === "range_claim_drift");
		expect(range).toEqual([
			expect.objectContaining({
				file: "a.md",
				message: expect.stringContaining("X-30"),
			}),
		]);
	});

	it("fires range drift when a sibling adds LOWER ids even if maxima match (sol-max #5)", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"a.md": ["| X-05 | a |", "| X-20 | b |", "Valid X-01 through X-10."].join("\n"),
				"b.md": "| X-01 | c |\n| X-02 | d |",
			},
			never,
		);
		// a.md's local max (20) equals the global max, but b.md contributes X-01/02,
		// so the census is cross-file — the understated claim must still fire.
		const range = l.computeDrift().filter((f) => f.kind === "range_claim_drift");
		expect(range).toEqual([
			expect.objectContaining({ file: "a.md", message: expect.stringContaining("X-20") }),
		]);
	});

	it("still suppresses when the global census equals the local registry", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"a.md": [
					"| X-01 | a |",
					"| X-20 | b |",
					"Valid for X-01 through X-10.",
				].join("\n"),
			},
			never,
		);
		expect(l.computeDrift().filter((f) => f.kind === "range_claim_drift")).toEqual(
			[],
		);
	});

	it("measures a compact range claim against the compact census only (sol-max #10)", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				// Compact A registry + a full-span compact claim (A1..A3)…
				"claim.md": [
					"- A1 first",
					"- A2 second",
					"- A3 third",
					"Steps A1 through A3 are the intro.",
				].join("\n"),
				// …a sibling extends the COMPACT census to A9 (so the claim drifts)…
				"ext.md": ["- A7 seven", "- A8 eight", "- A9 nine"].join("\n"),
				// …and a dashed A registry reaches A-50, which must be ignored.
				"dashed.md": ["| A-01 | a |", "| A-50 | b |"].join("\n"),
			},
			never,
		);
		const range = l.computeDrift().filter((f) => f.kind === "range_claim_drift");
		// Exactly one finding, citing the compact census (A-9) — never the dashed
		// A-50 (the old both-styles loop emitted a spurious second finding).
		expect(range).toHaveLength(1);
		expect(range[0]?.message).toContain("A-9");
		expect(range[0]?.message).not.toContain("A-50");
	});

	it("fires count drift when a sibling file extends a disagreeing local registry", () => {
		const l = SpecLedger.fromContents(
			"/repo",
			{
				"a.md": ["## The six bets", "- B1 a", "- B2 b", "- B3 c"].join("\n"),
				"b.md": "- B4 d\n- B5 e\n- B6 f\n- B7 g",
			},
			never,
		);
		// Local registry (3) disagrees with the claim (6), but the global
		// census (7) is a DIFFERENT story — the finding must survive.
		const count = l.computeDrift().filter((f) => f.kind === "count_claim_drift");
		expect(count).toEqual([
			expect.objectContaining({
				file: "a.md",
				message: expect.stringContaining("7 distinct ids"),
			}),
		]);
	});
});
