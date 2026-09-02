import { describe, expect, it } from "vitest";
import {
	checkedCandidateCount,
	narrowScopeFields,
	scopeConsistencyReason,
	validationModeReason,
} from "./simplification-agent-ci-request-shape.js";

const SHA = "a".repeat(64);

describe("scopeConsistencyReason", () => {
	it("accepts a diff scope that pins a base_sha", () => {
		expect(scopeConsistencyReason("diff", SHA, ["src/a.ts"])).toBeNull();
	});

	it("accepts a repository scope with no paths and no base_sha", () => {
		expect(scopeConsistencyReason("repository", null, [])).toBeNull();
	});

	it("accepts a paths scope with at least one path", () => {
		expect(scopeConsistencyReason("paths", null, ["src/a.ts"])).toBeNull();
	});

	it("rejects a diff scope without a base_sha", () => {
		expect(scopeConsistencyReason("diff", null, [])).toBe(
			"request.scope.base_sha is required only for diff scope",
		);
	});

	it("rejects a non-diff scope that carries a base_sha", () => {
		expect(scopeConsistencyReason("repository", SHA, [])).toBe(
			"request.scope.base_sha is required only for diff scope",
		);
	});

	it("rejects a repository scope with paths", () => {
		expect(scopeConsistencyReason("repository", null, ["src/a.ts"])).toBe(
			"request.scope.paths must be empty for repository scope",
		);
	});

	it("rejects a paths scope with no paths", () => {
		expect(scopeConsistencyReason("paths", null, [])).toBe(
			"request.scope.paths must not be empty for paths scope",
		);
	});

	it("ignores path cardinality when paths did not parse to an array", () => {
		expect(scopeConsistencyReason("paths", null, { reason: "bad" })).toBeNull();
		expect(scopeConsistencyReason("repository", null, { reason: "bad" })).toBeNull();
	});
});

describe("narrowScopeFields", () => {
	it("returns the narrowed fields when every member has the right shape", () => {
		expect(narrowScopeFields(SHA, ["a"], ["b"], ["c"])).toEqual({
			head_sha: SHA,
			paths: ["a"],
			includes: ["b"],
			excludes: ["c"],
		});
	});

	it("rejects a non-string head_sha", () => {
		expect(narrowScopeFields(null, [], [], [])).toBeNull();
	});

	it("rejects a non-array paths, includes, or excludes", () => {
		expect(narrowScopeFields(SHA, { reason: "bad" }, [], [])).toBeNull();
		expect(narrowScopeFields(SHA, [], { reason: "bad" }, [])).toBeNull();
		expect(narrowScopeFields(SHA, [], [], { reason: "bad" })).toBeNull();
	});
});

describe("checkedCandidateCount", () => {
	it("accepts the inclusive bounds", () => {
		expect(checkedCandidateCount(0)).toBe(0);
		expect(checkedCandidateCount(100)).toBe(100);
		expect(checkedCandidateCount(7)).toBe(7);
	});

	it("rejects out-of-range, fractional, and non-number values", () => {
		const reason = { reason: "request.validation.max_candidates must be an integer from 0 through 100" };
		expect(checkedCandidateCount(-1)).toEqual(reason);
		expect(checkedCandidateCount(101)).toEqual(reason);
		expect(checkedCandidateCount(1.5)).toEqual(reason);
		expect(checkedCandidateCount("7")).toEqual(reason);
		expect(checkedCandidateCount(null)).toEqual(reason);
		expect(checkedCandidateCount(Number.NaN)).toEqual(reason);
	});
});

describe("validationModeReason", () => {
	it("accepts a none mode with no plan and zero candidates", () => {
		expect(validationModeReason("none", null, 0)).toBeNull();
	});

	it("accepts a candidate mode with a plan and at least one candidate", () => {
		expect(validationModeReason("candidate", SHA, 1)).toBeNull();
	});

	it("rejects a none mode that carries a plan or candidates", () => {
		const reason = "request.validation none mode must omit a check plan and use zero candidates";
		expect(validationModeReason("none", SHA, 0)).toBe(reason);
		expect(validationModeReason("none", null, 2)).toBe(reason);
	});

	it("rejects a candidate mode missing a plan or candidates", () => {
		const reason = "request.validation candidate mode requires a check plan and at least one candidate";
		expect(validationModeReason("candidate", null, 3)).toBe(reason);
		expect(validationModeReason("candidate", SHA, 0)).toBe(reason);
	});
});
