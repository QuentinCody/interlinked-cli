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
			{ file: "README.md", line: 2, message: '"six bets" vs the B census: 7 ids' },
		]);
		expect(out).toContain("1 retained cross-file spec fact finding(s)");
		expect(out).toContain("README.md:2");
		expect(out).toContain("interlinked query spec-drift");
		expect(out).toContain("session causation unmeasured");
		expect(out).not.toMatch(/auto-?fix/i);
	});

	it("caps the quoted list and reports the remainder count", () => {
		const entries = Array.from({ length: 5 }, (_, i) => ({
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
