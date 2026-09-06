// Bounded-matching evidence for gitwildmatch-v1. The overlay manifest is
// agent-writable and the matcher runs on the hook path, so a pattern that
// costs more than O(pattern x path) is a local denial of service: a VALID
// 41-byte pattern once ran for minutes against 40 characters. Every timing
// case below reads a MONOTONIC clock inside the test body and asserts a
// generous-but-real ceiling, so a future backtracking rewrite fails loudly
// instead of merely running slowly. The grammar itself is pinned by
// overlay-manifest.test.ts, which reaches these functions through the
// manifest module's re-exports.
import { describe, expect, it } from "vitest";
import {
	checkGitWildmatchPattern,
	compileGitWildmatchV1,
	matchCompiledGitWildmatchV1,
	matchesGitWildmatchV1,
} from "./overlay-glob.js";
import { MAX_PATH_BYTES } from "./path-rules.js";

const BOUND_MS = 250;

/** Milliseconds `run` took, on the monotonic clock. */
function elapsedMs(run: () => void): number {
	const started = performance.now();
	run();
	return performance.now() - started;
}

/** `count` copies of `segment` joined with "/". */
function joined(segment: string, count: number): string {
	return Array.from({ length: count }, () => segment).join("/");
}

/** The compiled pattern, or a failure the test reports instead of narrowing
 *  a null inside an `it()` body. */
function compiledOrThrow(pattern: string) {
	const compiled = compileGitWildmatchV1(pattern);
	if (compiled === null) throw new Error(`expected ${pattern} to compile`);
	return compiled;
}

describe("gitwildmatch-v1 bounded matching — positive (must accept)", () => {
	it("P1: a maximal pattern against a MAX_PATH_BYTES path matches within the bound", () => {
		const pattern = joined(`${"*a".repeat(127)}*`, 16);
		const path = joined("a".repeat(254), 16);
		expect(Buffer.byteLength(pattern, "utf8")).toBeLessThanOrEqual(MAX_PATH_BYTES);
		expect(Buffer.byteLength(path, "utf8")).toBeLessThanOrEqual(MAX_PATH_BYTES);
		let matched = false;
		const took = elapsedMs(() => {
			matched = matchesGitWildmatchV1(pattern, path);
		});
		expect(matched).toBe(true);
		expect(took).toBeLessThan(BOUND_MS);
	});

	it("P2: hundreds of rules against hundreds of candidates stay bounded", () => {
		const patterns = Array.from({ length: 300 }, (_, index) => `d${index}/**/*.json`);
		const candidates = Array.from({ length: 300 }, (_, index) => `d${index}/a/b/c/f${index}.json`);
		let hits = 0;
		const took = elapsedMs(() => {
			for (const path of candidates) {
				for (const pattern of patterns) if (matchesGitWildmatchV1(pattern, path)) hits += 1;
			}
		});
		expect(hits).toBe(300);
		expect(took).toBeLessThan(1000);
	});

	it("P3: nested '**' segments still match, and do so within the bound", () => {
		const path = `${joined("seg", 40)}/x/${joined("tail", 40)}`;
		let matched = false;
		const took = elapsedMs(() => {
			matched = matchesGitWildmatchV1("**/**/**/x/**", path);
		});
		expect(matched).toBe(true);
		expect(took).toBeLessThan(BOUND_MS);
	});

	it("P4: a pattern compiles ONCE and the compiled form matches many paths", () => {
		const compiled = compiledOrThrow("scratch/**/*.mts");
		const paths = Array.from({ length: 2000 }, (_, index) => `scratch/a/b/probe${index}.mts`);
		let matched = 0;
		const took = elapsedMs(() => {
			for (const path of paths) if (matchCompiledGitWildmatchV1(compiled, path)) matched += 1;
		});
		expect(matched).toBe(2000);
		expect(matchCompiledGitWildmatchV1(compiled, "scratch/a/b/probe.ts")).toBe(false);
		expect(took).toBeLessThan(BOUND_MS);
	});

	it("P5: the compiled form agrees with the by-pattern entry point", () => {
		const compiled = compiledOrThrow("scratch/[a-z]*.?ts");
		expect(matchCompiledGitWildmatchV1(compiled, "scratch/probe.mts")).toBe(true);
		expect(matchesGitWildmatchV1("scratch/[a-z]*.?ts", "scratch/probe.mts")).toBe(true);
		expect(matchCompiledGitWildmatchV1(compiled, "scratch/Probe.mts")).toBe(false);
	});
});

describe("gitwildmatch-v1 bounded matching — negative (must reject)", () => {
	it("N1: the classic backtracking bomb ('*a' x20 + 'b') vs 40 'a's returns false fast", () => {
		const pattern = `${"*a".repeat(20)}b`;
		expect(checkGitWildmatchPattern(pattern, "pattern")).toBeNull();
		let matched = true;
		const took = elapsedMs(() => {
			matched = matchesGitWildmatchV1(pattern, "a".repeat(40));
		});
		expect(matched).toBe(false);
		expect(took).toBeLessThan(BOUND_MS);
	});

	it("N2: an alternating '*?' pattern against a too-short path returns false fast", () => {
		const pattern = "*?".repeat(100);
		let matched = true;
		const took = elapsedMs(() => {
			matched = matchesGitWildmatchV1(pattern, "a".repeat(50));
		});
		expect(matched).toBe(false);
		expect(took).toBeLessThan(BOUND_MS);
	});

	it("N3: nested '**' in front of a star bomb is still bounded on a non-match", () => {
		const pattern = `**/**/${"*a".repeat(20)}b`;
		const path = `${joined("a", 20)}/${"a".repeat(200)}`;
		let matched = true;
		const took = elapsedMs(() => {
			matched = matchesGitWildmatchV1(pattern, path);
		});
		expect(matched).toBe(false);
		expect(took).toBeLessThan(BOUND_MS);
	});

	it("N4: an out-of-order class range is REFUSED as an invalid rule, never silently unmatchable", () => {
		// The old regex compiler threw an uncaught SyntaxError here. Matching
		// nothing was the first fix; refusing the rule is the right one — a
		// pattern that can never match any path is a typo, and a manifest that
		// carries one silently is a file the author believes travels and that
		// does not (decision 2026-09-04).
		expect(() => matchesGitWildmatchV1("x[z-a]y", "xay")).not.toThrow();
		expect(checkGitWildmatchPattern("x[z-a]y", "pattern")).not.toBeNull();
		expect(compileGitWildmatchV1("x[z-a]y")).toBeNull();
		expect(matchesGitWildmatchV1("x[z-a]y", "xay")).toBe(false);
		expect(matchesGitWildmatchV1("x[z-a]y", "xzy")).toBe(false);
		// the NEGATED form is refused too: the range is what is impossible,
		// and a negated impossible range would otherwise match everything.
		expect(checkGitWildmatchPattern("x[!z-a]y", "pattern")).not.toBeNull();
		expect(matchesGitWildmatchV1("x[!z-a]y", "xay")).toBe(false);
		// a well-ordered range, negated or not, still works
		expect(matchesGitWildmatchV1("x[a-z]y", "xay")).toBe(true);
		expect(matchesGitWildmatchV1("x[!a-z]y", "x1y")).toBe(true);
	});

	it("N5: a pattern carrying a lone surrogate is refused before compilation", () => {
		expect(checkGitWildmatchPattern("scratch/\uD800.txt", "pattern")).not.toBeNull();
		expect(compileGitWildmatchV1("scratch/\uD800.txt")).toBeNull();
		expect(matchesGitWildmatchV1("scratch/\uD800.txt", "scratch/\uD800.txt")).toBe(false);
	});

	it("N6: an invalid pattern compiles to null and therefore matches nothing", () => {
		expect(compileGitWildmatchV1("a[bc")).toBeNull();
		expect(compileGitWildmatchV1("../escape/**")).toBeNull();
		expect(matchesGitWildmatchV1("a[bc", "a[bc")).toBe(false);
	});
});
