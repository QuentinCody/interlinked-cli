import { describe, expect, it } from "vitest";
import {
	formatReviewFindingsWarning,
	formatSpecDriftWarning,
} from "./spec-stop-checks.js";

describe("formatSpecDriftWarning", () => {
	it("returns null for undefined or empty stashes", () => {
		expect(formatSpecDriftWarning(undefined)).toBeNull();
		expect(formatSpecDriftWarning([])).toBeNull();
	});

	it("lists findings with file:line and reflective wording", () => {
		const out = formatSpecDriftWarning([
			{ kind: "declared_fact_drift", file: "README.md", line: 2, message: 'fact:mode differs from plan.md' },
		]);
		expect(out).toContain("1 retained structural spec finding(s)");
		expect(out).toContain("README.md:2");
		expect(out).toContain("interlinked query spec-drift");
		expect(out).toContain("session causation unmeasured");
		expect(out).not.toMatch(/auto-?fix/i);
	});

	it("caps the quoted list and reports the remainder count", () => {
		const entries = Array.from({ length: 5 }, (_, i) => ({
			kind: "xref_missing_file",
			file: `f${i}.md`,
			line: i + 1,
			message: `finding ${i}`,
		}));
		const out = formatSpecDriftWarning(entries);
		expect(out).toContain("f0.md:1");
		expect(out).toContain("f2.md:3");
		expect(out).not.toContain("f3.md");
		expect(out).toContain("…and 2 more");
	});

	it("never promotes heuristic or unclassified legacy entries into Stop warnings", () => {
		expect(formatSpecDriftWarning([{ file: "review.md", line: 1, message: "legacy example" }])).toBeNull();
		for (const kind of ["count_claim_drift", "range_claim_drift", "unknown"]) {
			expect(formatSpecDriftWarning([{ kind, file: "review.md", line: 1, message: "quoted example" }])).toBeNull();
		}
	});

	it("counts only structural findings in a mixed retained snapshot", () => {
		const out = formatSpecDriftWarning([
			{ kind: "range_claim_drift", file: "review.md", line: 1, message: "example" },
			{ kind: "xref_missing_anchor", file: "guide.md", line: 2, message: "missing target heading" },
		]);
		expect(out).toContain("1 retained structural");
		expect(out).toContain("guide.md:2");
		expect(out).not.toContain("review.md");
	});
});

describe("formatReviewFindingsWarning", () => {
	it("returns null when nothing is open", () => {
		expect(formatReviewFindingsWarning(undefined)).toBeNull();
		expect(formatReviewFindingsWarning([])).toBeNull();
	});

	it("lists open findings with the ack escape hatch, capped", () => {
		const open = Array.from({ length: 4 }, (_, i) => ({
			id: `review_finding_number_${i}_with_a_long_identifier_suffix`,
			file: "docs/plan.md",
			line: i + 1,
			message: `finding ${i} statement`,
		}));
		const out = formatReviewFindingsWarning(open);
		expect(out).toContain("4 ingested review finding(s)");
		expect(out).toContain("docs/plan.md:1");
		expect(out).toContain("findings ack");
		expect(out).toContain("…and 1 more");
		expect(out).not.toMatch(/auto-?fix/i);
	});
});
