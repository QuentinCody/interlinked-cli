import { afterEach, describe, expect, it, vi } from "vitest";
import {
	evaluateForbidsAfter,
	evaluateRequiresPrior,
} from "./temporal-matching.js";
import type { SessionTrajectory } from "../types.js";

function session(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "mutation-kill-eq1-fixture",
		agent_name: "test-agent",
		started_at: "2026-01-01T00:00:00.000Z",
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: 0,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
		verification_observed: new Set(),
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getCachedRegex() cache reuse — mutation kill (eq1 falsification)", () => {
	// test-contract: invariant — 1dc79a785fb7047d: forcing the
	// cache-miss guard (`!re`) to `true` recompiles the pattern on every
	// call instead of reusing the cached RegExp. Observable via the
	// global `RegExp` constructor's call count: a correct implementation
	// never grows the count on a second call with the same pattern.
	// test-contract: invariant — a second call with the same pattern reuses the cached RegExp.
	it("compiles the bash_match regex once and reuses it across repeated calls with the same pattern", () => {
		// mockImplementation reconstructs via Reflect.construct(RegExp, args)
		// rather than letting spyOn's default call-through run the mock
		// function as the `new` target directly — the latter yields an
		// object whose prototype is the spy function's own prototype, not
		// RegExp.prototype, so `.test` is missing on the returned instance.
		const OriginalRegExp = globalThis.RegExp;
		const ctorSpy = vi
			.spyOn(globalThis, "RegExp")
			.mockImplementation(function (...args: ConstructorParameters<typeof RegExp>) {
				// SAFETY: args are exactly the arguments the spied RegExp
				// constructor was invoked with — production code only ever
				// calls `new RegExp(pattern, flags)`, matching this shape.
				// A `function` (not an arrow) is required here: vitest's
				// spy re-invokes this implementation with `new`, and an
				// arrow function cannot be a constructor target. It must
				// construct via the captured `OriginalRegExp`, not the
				// bare `RegExp` identifier — that now resolves to this
				// same spy (globalThis.RegExp was just reassigned), which
				// would recurse infinitely.
				return Reflect.construct(
					OriginalRegExp,
					// SAFETY: test fixture — the spy is only ever invoked as `new RegExp(pattern, flags)`
					// by production code, so `args` is structurally a RegExp constructor argument tuple.
					args,
				);
			});
		const s = session({ commands_run: ["run foo now"] });
		evaluateRequiresPrior(s, { bash_match: "foo" });
		const callsAfterFirst = ctorSpy.mock.calls.length;
		evaluateRequiresPrior(s, { bash_match: "foo" });
		const callsAfterSecond = ctorSpy.mock.calls.length;
		expect(callsAfterSecond).toBe(callsAfterFirst);
	});
});

describe("tail() early-return vs slice — mutation kill (eq1 falsification)", () => {
	// test-contract: boundary — 876fa14abfdc5149: narrowing the
	// boundary guard from `>=` to `>` skips the early return exactly when
	// within_last_n equals arr.length, falling through to `arr.slice(...)`
	// instead. Content is identical either way (slice clamps), but the
	// EXTRA slice() call is observable via a spy on Array.prototype.slice.
	// test-contract: boundary — within_last_n === arr.length takes the early-return, no slice call.
	it("does not slice the tool_sequence when within_last_n exactly equals its length", () => {
		const arr = ["Edit:a", "Read:b"];
		const sliceSpy = vi.spyOn(Array.prototype, "slice");
		const result = evaluateRequiresPrior(session({ tool_sequence: arr }), {
			tool: "Read",
			within_last_n: arr.length,
		});
		expect(sliceSpy).not.toHaveBeenCalled();
		expect(result.satisfied).toBe(true);
	});

	// test-contract: boundary — ba7ec18015ec30a9: forcing the
	// `within_last_n >= arr.length` guard to `false` removes the early
	// return unconditionally, so even a window far larger than the array
	// falls through to an unnecessary `arr.slice(...)` call — observable
	// the same way as the boundary case above.
	// test-contract: boundary — within_last_n beyond arr.length also takes the early-return.
	it("does not slice the tool_sequence when within_last_n exceeds its length", () => {
		const arr = ["Edit:a", "Read:b"];
		const sliceSpy = vi.spyOn(Array.prototype, "slice");
		const result = evaluateRequiresPrior(session({ tool_sequence: arr }), {
			tool: "Read",
			within_last_n: arr.length + 5,
		});
		expect(sliceSpy).not.toHaveBeenCalled();
		expect(result.satisfied).toBe(true);
	});
});

describe("fileReadFieldSatisfied() fast-path — mutation kill (eq1 falsification)", () => {
	// test-contract: boundary — 618579f71ba1412a: forcing
	// `!wanted.includes("*")` to `false` always routes a wildcard-free
	// file_read through globToRegex() instead of the Set.has() fast
	// path. Return-value content is equivalent (anchored escape ==
	// exact match), but the EXTRA `new RegExp(...)` call is observable.
	// test-contract: invariant — an exact non-wildcard match takes the Set.has() fast path, no regex compile.
	it("does not compile a regex for an exact, non-wildcard file_read match", () => {
		const ctorSpy = vi.spyOn(globalThis, "RegExp");
		const result = evaluateRequiresPrior(
			session({ files_read: new Set(["a.ts"]) }),
			{ file_read: "a.ts" },
		);
		expect(ctorSpy).not.toHaveBeenCalled();
		expect(result.satisfied).toBe(true);
	});

	// test-contract: boundary — 606c34c4d539b83e: narrowing the
	// literal `"*"` to `""` in the same `includes()` check has the same
	// always-true-negated effect (every string includes ""), so it also
	// always routes through globToRegex() for a wildcard-free, non-match
	// case — same regex-construction-count observable, distinct scenario.
	// test-contract: invariant — a non-wildcard, never-read file also takes the fast path, no regex compile.
	it("does not compile a regex when checking a non-wildcard file_read that was never read", () => {
		const ctorSpy = vi.spyOn(globalThis, "RegExp");
		const result = evaluateRequiresPrior(
			session({ files_read: new Set(["other.ts"]) }),
			{ file_read: "a.ts" },
		);
		expect(ctorSpy).not.toHaveBeenCalled();
		expect(result.satisfied).toBe(false);
	});
});

describe("verificationFieldSatisfied() empty-set guard — mutation kill (eq1 falsification)", () => {
	// test-contract: boundary — e5ef5d4419ca7de5: forcing
	// `observed.size === 0` to `false` removes the early return for an
	// empty (but defined) Set, falling through to `observed.has(...)`.
	// The return value is unchanged (empty Set always answers `has`
	// false), but the EXTRA `.has()` call on the injected Set instance
	// is observable via a spy on that instance.
	// test-contract: boundary — an empty verification_observed set takes the early-return, no .has() call.
	it("never calls .has on an empty verification_observed set", () => {
		const observed = new Set<string>();
		const hasSpy = vi.spyOn(observed, "has");
		const result = evaluateRequiresPrior(
			session({ verification_observed: observed }),
			{ verification_kind: "test" },
		);
		expect(hasSpy).not.toHaveBeenCalled();
		expect(result.satisfied).toBe(false);
	});
});

describe("tail() falsy/non-positive short-circuit — confirmed equivalent", () => {
	// test-contract: boundary — structural argument for 6f4bc2ba486ee4ad
	// (`within_last_n <= 0` narrowed to `< 0`): the guard is
	// `!within_last_n || within_last_n <= 0`. The mutated operand is only
	// ever evaluated when `!within_last_n` is false, i.e. within_last_n
	// is truthy (nonzero, non-NaN). For every truthy number n, `n <= 0`
	// and `n < 0` agree (they diverge only at n === 0, which is
	// unreachable here because 0 is falsy and already short-circuits on
	// the first operand). No input can distinguish the two branches
	// through the public API — sanity-pinned below.
	// test-contract: boundary — within_last_n<=0 and within_last_n<0 are observably identical.
	it("sanity: within_last_n=0 and within_last_n=-1 both take the full-array path identically", () => {
		const zero = evaluateRequiresPrior(session({ tool_sequence: ["Read:x"] }), {
			tool: "Read",
			within_last_n: 0,
		});
		const negative = evaluateRequiresPrior(
			session({ tool_sequence: ["Read:x"] }),
			{ tool: "Read", within_last_n: -1 },
		);
		expect(zero.satisfied).toBe(true);
		expect(negative.satisfied).toBe(true);
	});
});

describe("describeUnsatisfied() sub-condition undefined-guards — confirmed equivalent", () => {
	// test-contract: invariant — structural argument shared by
	// 9839f378fc56a0cc / c89299d4b6b57f61 / 0d6fe2d4e1cad6fc /
	// cd0a8df649860d05: each mutates `pred.<field> !== undefined` to
	// `true` in a `cond && !fieldSatisfied(...)` guard. When
	// pred.<field> is undefined, the corresponding `*FieldSatisfied`
	// function returns `true` IMMEDIATELY on its own leading
	// `if (pred.<field> === undefined) return true;` guard, with zero
	// side effects (no array/regex/Set access) before that return. So
	// the mutated guard's extra invocation of `*FieldSatisfied` (which
	// the original short-circuits away) is a pure no-op: it reads no
	// state, calls no injectable dependency, and returns the same
	// `true` that makes `!fieldSatisfied(...)` false either way — the
	// `missing.push` never fires in either version. No observable
	// (return value, thrown error, dependency call count, argument
	// mutation) can distinguish them. Sanity-pinned below for all four
	// fields at once.
	// test-contract: invariant — an all-undefined predicate is vacuously satisfied.
	it("sanity: an all-undefined predicate produces satisfied:true with describeUnsatisfied unreachable", () => {
		const result = evaluateRequiresPrior(session({ tool_sequence: [] }), {});
		// Vacuous predicate is fully satisfied — this exercises predicateSatisfied's
		// vacuous-true path; describeUnsatisfied is unreachable here by construction,
		// which is exactly the invariant the equivalence argument above relies on.
		expect(result.satisfied).toBe(true);
	});
});

describe("describeUnsatisfied() missing.length fallback — confirmed equivalent", () => {
	// test-contract: public-api — structural argument for
	// f93e09a92bafb606 (`missing.length === 0` forced to `false`):
	// describeUnsatisfied() is invoked ONLY from evaluateRequiresPrior's
	// `if (ok) ... else describeUnsatisfied(...)` branch, i.e. only
	// after predicateSatisfied(pred, session) has already returned
	// false. predicateSatisfied short-circuits on the first of the four
	// *FieldSatisfied checks that returns false, and each
	// *FieldSatisfied function returns false ONLY when its predicate
	// field is defined (the undefined case always returns true first).
	// Since all four helpers are pure functions of the same
	// (pred, session) pair, describeUnsatisfied's re-invocation of that
	// SAME failing check necessarily also returns false with its field
	// defined, so `missing.push` fires for it — missing.length is
	// provably >= 1 on every reachable call. The `=== 0` branch is dead
	// on the public API; forcing it to `false` cannot be observed.
	// test-contract: public-api — an unsatisfied predicate always yields the field-specific reason string.
	it("sanity: an unsatisfied predicate always yields a non-generic reason, never the empty-missing fallback", () => {
		const result = evaluateRequiresPrior(session(), { file_read: "nope.ts" });
		expect(result.satisfied).toBe(false);
		expect(result.reason).not.toBe("predicate not satisfied");
		expect(result.reason).toBe("no prior file read matching nope.ts");
	});
});

describe("describeUnsatisfied() within_last_n suffix short-circuit — confirmed equivalent", () => {
	// test-contract: boundary — structural argument for 4e1421568e5542d2
	// (`pred.within_last_n > 0` narrowed to `>= 0`): the guard is
	// `pred.within_last_n && pred.within_last_n > 0`. The mutated
	// operand only runs when `pred.within_last_n` is truthy (nonzero),
	// and for every truthy number the two comparisons agree (diverge
	// only at 0, which the first operand already excludes) — the same
	// unreachable-boundary shape as 6f4bc2ba486ee4ad above.
	// test-contract: boundary — within_last_n=0 omits the window suffix identically under both readings.
	it("sanity: within_last_n=0 omits the window suffix identically under both readings", () => {
		const result = evaluateRequiresPrior(session({ tool_sequence: [] }), {
			tool: "Read",
			within_last_n: 0,
		});
		expect(result.reason).toBe("no prior `Read` tool call");
	});
});

describe("evaluateForbidsAfter() — sanity companion", () => {
	// test-contract: public-api — evaluateForbidsAfter is a stub that always reports unsatisfied while dormant.
	it("stays dormant (satisfied:false) when the forbidden predicate is absent", () => {
		const result = evaluateForbidsAfter(session(), { tool: "Bash" });
		expect(result).toEqual({ satisfied: false });
	});
});
