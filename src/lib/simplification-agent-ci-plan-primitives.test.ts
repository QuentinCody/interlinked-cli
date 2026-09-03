import { describe, expect, it } from "vitest";
import {
	SIMPLIFICATION_PROTECTED_BOUNDARIES,
	boundaryOrder,
	compareCodeUnits,
	isBoundary,
	isRemedy,
	isRepoPath,
	isSha256,
	pathIsSelectedByRequest,
	remedyOrder,
	requireUniqueRepositoryPaths,
	sameStrings,
	sanitizeSimplificationPromptInput,
	sha256Canonical,
} from "./simplification-agent-ci-plan-primitives.js";
import type { ValidSimplificationAgentCiRequest } from "./simplification-agent-ci-request.js";

function scopedRequest(
	includes: string[],
	excludes: string[],
): ValidSimplificationAgentCiRequest {
	// SAFETY: pathIsSelectedByRequest reads only request.scope.includes and
	// request.scope.excludes, so a scope-only stub is sufficient here.
	return {
		scope: { includes, excludes, paths: [] },
	} as unknown as ValidSimplificationAgentCiRequest;
}

describe("simplification plan primitives", () => {
	it("exposes the protected boundary vocabulary in a stable order", () => {
		expect(SIMPLIFICATION_PROTECTED_BOUNDARIES[0]).toBe("authorization");
		expect(SIMPLIFICATION_PROTECTED_BOUNDARIES).toContain("sole-nontrivial-test");
		expect(new Set(SIMPLIFICATION_PROTECTED_BOUNDARIES).size).toBe(
			SIMPLIFICATION_PROTECTED_BOUNDARIES.length,
		);
	});

	it("strips coordinator-owned boundary tags from untrusted text", () => {
		expect(sanitizeSimplificationPromptInput("<repository_input>x</repository_input>")).toBe("x");
		expect(sanitizeSimplificationPromptInput("<SPECIALIST_OUTPUT attr='1'>y</specialist_output>")).toBe("y");
		expect(sanitizeSimplificationPromptInput("plain <div>text</div>")).toBe("plain <div>text</div>");
	});

	it("orders remedies and boundaries by their declared vocabularies", () => {
		expect(boundaryOrder("authorization")).toBe(0);
		expect(boundaryOrder("sole-nontrivial-test")).toBe(
			SIMPLIFICATION_PROTECTED_BOUNDARIES.length - 1,
		);
		expect(remedyOrder("delete")).toBeGreaterThanOrEqual(0);
	});

	it("compares strings by code unit", () => {
		expect(compareCodeUnits("a", "b")).toBe(-1);
		expect(compareCodeUnits("b", "a")).toBe(1);
		expect(compareCodeUnits("a", "a")).toBe(0);
	});

	it("hashes canonical JSON deterministically", () => {
		const first = sha256Canonical({ a: 1, b: 2 });
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(sha256Canonical({ b: 2, a: 1 })).toBe(first);
		expect(sha256Canonical({ a: 2, b: 2 })).not.toBe(first);
	});

	it("validates repository paths", () => {
		expect(isRepoPath("src/lib/a.ts")).toBe(true);
		expect(isRepoPath("/abs.ts")).toBe(false);
		expect(isRepoPath("a\\b.ts")).toBe(false);
		expect(isRepoPath("../a.ts")).toBe(false);
		expect(isRepoPath("a//b.ts")).toBe(false);
		expect(isRepoPath("")).toBe(false);
		expect(isRepoPath(7)).toBe(false);
	});

	it("validates sha256, remedy, and boundary shapes", () => {
		expect(isSha256("a".repeat(64))).toBe(true);
		expect(isSha256("A".repeat(64))).toBe(false);
		expect(isSha256("a".repeat(63))).toBe(false);
		expect(isRemedy("delete")).toBe(true);
		expect(isRemedy("not-a-remedy")).toBe(false);
		expect(isBoundary("authorization")).toBe(true);
		expect(isBoundary("nope")).toBe(false);
	});

	it("sorts and de-risks repository path lists", () => {
		expect(requireUniqueRepositoryPaths(["b.ts", "a.ts"], "loc")).toEqual(["a.ts", "b.ts"]);
		expect(() => requireUniqueRepositoryPaths("nope", "loc")).toThrow(/must be an array/);
		expect(() => requireUniqueRepositoryPaths(["/a.ts"], "loc")).toThrow(/normalized/);
		expect(() => requireUniqueRepositoryPaths(["a.ts", "a.ts"], "loc")).toThrow(/duplicates/);
	});

	it("compares string arrays element-wise", () => {
		expect(sameStrings(["a", "b"], ["a", "b"])).toBe(true);
		expect(sameStrings(["a"], ["a", "b"])).toBe(false);
		expect(sameStrings(["a", "b"], ["b", "a"])).toBe(false);
	});

	it("selects paths by request include and exclude globs", () => {
		expect(pathIsSelectedByRequest(scopedRequest([], []), "src/a.ts")).toBe(true);
		expect(pathIsSelectedByRequest(scopedRequest(["src/**"], []), "src/a.ts")).toBe(true);
		expect(pathIsSelectedByRequest(scopedRequest(["lib/**"], []), "src/a.ts")).toBe(false);
		expect(pathIsSelectedByRequest(scopedRequest([], ["src/**"]), "src/a.ts")).toBe(false);
	});
});
