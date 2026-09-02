import { describe, expect, it } from "vitest";
import {
	exactKeys,
	gitObject,
	isoTimestamp,
	nonempty,
	parseOutcomes,
	sha256,
	sortedUniqueStrings,
} from "./simplification-agent-ci-experiment-outcomes.js";

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

type OutcomesFixture = Record<string, unknown> & {
	safety: Record<string, unknown>;
	completeness: Record<string, unknown>;
};

function validOutcomes(): OutcomesFixture {
	return {
		primary_metric: "alpha",
		metrics: [
			{ name: "alpha", unit: "ms", direction: "lower_is_better" },
			{ name: "beta", unit: "count", direction: "higher_is_better" },
		],
		safety: {
			protected_behavior_regressions: 0,
			required_checks_passed: true,
			receipt_path: "artifacts/receipt.json",
			receipt_sha256: SHA,
		},
		completeness: {
			planned_runs: 10,
			completed_runs: 8,
			scored_runs: 8,
			coverage_path: "artifacts/coverage.json",
			coverage_sha256: OTHER_SHA,
		},
		raw_results_path: "artifacts/raw.json",
		raw_results_sha256: SHA,
		analysis_output_path: "artifacts/analysis.json",
		analysis_output_sha256: OTHER_SHA,
	};
}

describe("scalar predicates", () => {
	it("exactKeys compares key sets order-insensitively", () => {
		expect(exactKeys({ b: 1, a: 2 }, ["a", "b"])).toBe(true);
		expect(exactKeys({ a: 1 }, ["a", "b"])).toBe(false);
		expect(exactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
	});

	it("nonempty accepts bounded non-empty strings only", () => {
		expect(nonempty("x")).toBe(true);
		expect(nonempty("")).toBe(false);
		expect(nonempty("x".repeat(4_097))).toBe(false);
		expect(nonempty(5)).toBe(false);
	});

	it("sha256 accepts 64 lowercase hex characters only", () => {
		expect(sha256(SHA)).toBe(true);
		expect(sha256(SHA.toUpperCase())).toBe(false);
		expect(sha256("a".repeat(63))).toBe(false);
		expect(sha256(null)).toBe(false);
	});

	it("gitObject accepts 40 and 64 hex characters", () => {
		expect(gitObject("a".repeat(40))).toBe(true);
		expect(gitObject("a".repeat(64))).toBe(true);
		expect(gitObject("a".repeat(41))).toBe(false);
	});

	it("isoTimestamp requires a canonical round-tripping ISO string", () => {
		expect(isoTimestamp("2026-01-01T00:00:00.000Z")).toBe(true);
		expect(isoTimestamp("2026-01-01T00:00:00Z")).toBe(false);
		expect(isoTimestamp("not-a-date")).toBe(false);
		expect(isoTimestamp(0)).toBe(false);
	});

	it("sortedUniqueStrings requires sorted, unique, non-empty entries", () => {
		expect(sortedUniqueStrings([])).toBe(true);
		expect(sortedUniqueStrings(["a", "b"])).toBe(true);
		expect(sortedUniqueStrings(["b", "a"])).toBe(false);
		expect(sortedUniqueStrings(["a", "a"])).toBe(false);
		expect(sortedUniqueStrings(["a", ""])).toBe(false);
		expect(sortedUniqueStrings("a")).toBe(false);
	});
});

describe("parseOutcomes", () => {
	it("accepts a fully pinned outcomes block", () => {
		const parsed = parseOutcomes(validOutcomes());
		expect(parsed).not.toBeNull();
		expect(parsed?.primary_metric).toBe("alpha");
		expect(parsed?.metrics).toHaveLength(2);
		expect(parsed?.safety.receipt_path).toBe("artifacts/receipt.json");
		expect(parsed?.completeness.scored_runs).toBe(8);
	});

	it("rejects a non-object or an unknown/missing key", () => {
		expect(parseOutcomes(null)).toBeNull();
		expect(parseOutcomes([])).toBeNull();
		expect(parseOutcomes({ ...validOutcomes(), extra: 1 })).toBeNull();
		const missing = validOutcomes();
		delete missing.metrics;
		expect(parseOutcomes(missing)).toBeNull();
	});

	it("rejects an empty, non-array, or malformed metric list", () => {
		expect(parseOutcomes({ ...validOutcomes(), metrics: [] })).toBeNull();
		expect(parseOutcomes({ ...validOutcomes(), metrics: {} })).toBeNull();
		expect(
			parseOutcomes({ ...validOutcomes(), metrics: [{ name: "alpha", unit: "ms" }] }),
		).toBeNull();
		expect(
			parseOutcomes({
				...validOutcomes(),
				metrics: [{ name: "alpha", unit: "ms", direction: "sideways" }],
			}),
		).toBeNull();
	});

	it("rejects duplicate, unsorted, or primary-missing metric names", () => {
		const dup = validOutcomes();
		dup.metrics = [
			{ name: "alpha", unit: "ms", direction: "lower_is_better" },
			{ name: "alpha", unit: "count", direction: "higher_is_better" },
		];
		expect(parseOutcomes(dup)).toBeNull();

		const unsorted = validOutcomes();
		unsorted.metrics = [
			{ name: "beta", unit: "count", direction: "higher_is_better" },
			{ name: "alpha", unit: "ms", direction: "lower_is_better" },
		];
		unsorted.primary_metric = "beta";
		expect(parseOutcomes(unsorted)).toBeNull();

		expect(parseOutcomes({ ...validOutcomes(), primary_metric: "gamma" })).toBeNull();
		expect(parseOutcomes({ ...validOutcomes(), primary_metric: "" })).toBeNull();
	});

	it("rejects an invalid safety outcome", () => {
		const base = validOutcomes();
		expect(parseOutcomes({ ...base, safety: { ...base.safety, receipt_path: "/abs" } }))
			.toBeNull();
		expect(
			parseOutcomes({
				...base,
				safety: { ...base.safety, protected_behavior_regressions: -1 },
			}),
		).toBeNull();
		expect(
			parseOutcomes({
				...base,
				safety: { ...base.safety, required_checks_passed: "yes" },
			}),
		).toBeNull();
	});

	it("rejects a completeness outcome whose counts do not nest", () => {
		const base = validOutcomes();
		expect(
			parseOutcomes({
				...base,
				completeness: { ...base.completeness, completed_runs: 11 },
			}),
		).toBeNull();
		expect(
			parseOutcomes({
				...base,
				completeness: { ...base.completeness, scored_runs: 9 },
			}),
		).toBeNull();
		expect(
			parseOutcomes({
				...base,
				completeness: { ...base.completeness, planned_runs: 1.5 },
			}),
		).toBeNull();
	});

	it("rejects unusable artifact paths and digests", () => {
		expect(parseOutcomes({ ...validOutcomes(), raw_results_path: "../escape.json" })).toBeNull();
		expect(parseOutcomes({ ...validOutcomes(), raw_results_sha256: "nope" })).toBeNull();
		expect(parseOutcomes({ ...validOutcomes(), analysis_output_path: "C:\\x.json" })).toBeNull();
		expect(parseOutcomes({ ...validOutcomes(), analysis_output_sha256: "nope" })).toBeNull();
	});
});
