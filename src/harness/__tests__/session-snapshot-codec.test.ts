import { parseWire, wireArray, wireObject, wireRecord, wireUnknown } from "../../lib/value-validation.js";
import { describe, expect, it } from "vitest";
import {
	readActiveSkills,
	readAssertionCountsMap,
	readBoolean,
	readCapturedPlan,
	readConsecutivePattern,
	readFailedFiles,
	readGitSessionBaseline,
	readNumber,
	readNumberArray,
	readNumberMap,
	readNumberRecord,
	readObservedChecks,
	readPendingCompletions,
	readSensitivity,
	readString,
	readStringArray,
	readStringMap,
	readStringSet,
	readStubsIntroduced,
	readTaintSources,
	readTddCycles,
	readTestRuns,
	readWarnings,
	serializeCapturedPlan,
} from "../session-snapshot-codec.js";
import type { CapturedPlan } from "../types/plan.js";

// The snapshot-codec module holds the defensive coercion + serialize helpers
// lifted verbatim out of session-state.ts. SessionTracker.serialize/hydrate
// delegate to these; the full round-trip is exercised in
// session-state-roundtrip.test.ts. Here we pin the individual coercions so a
// regression in the codec surfaces against the codec, not three layers up.
//
// Every reader here is called with the on-disk snapshot's shape already
// narrowed away (`v: unknown`), so a JSON value that "looks like" a valid
// record but ISN'T a plain object (an array, a primitive) is a real defensive
// case the reader must reject independent of whether its individual fields
// happen to look plausible. `arrayMasqueradingAsRecord` builds exactly that:
// an array (fails the `isPlainObject` guard) carrying named properties that
// read like a well-formed entry, so a bypassed guard is provably
// distinguishable from one that correctly rejects it — a per-field-only test
// can't tell the two apart because the array's own field access still
// succeeds.
function arrayMasqueradingAsRecord(props: Record<string, unknown>): unknown[] {
	return Object.assign([], props);
}

describe("readString", () => {
	it("returns the string for a non-empty string", () => {
		expect(readString("hello")).toBe("hello");
	});

	it("returns null for an empty string", () => {
		expect(readString("")).toBeNull();
	});

	it("returns null for non-string values", () => {
		expect(readString(42)).toBeNull();
		expect(readString(null)).toBeNull();
		expect(readString(undefined)).toBeNull();
		expect(readString({})).toBeNull();
	});
});

describe("readNumber", () => {
	it("returns a finite number as-is", () => {
		expect(readNumber(5, 0)).toBe(5);
	});

	it("falls back to the default for NaN and Infinity", () => {
		expect(readNumber(Number.NaN, 7)).toBe(7);
		expect(readNumber(Number.POSITIVE_INFINITY, 7)).toBe(7);
	});

	it("falls back to the default for non-number values", () => {
		expect(readNumber("5", 3)).toBe(3);
		expect(readNumber(undefined, 9)).toBe(9);
	});
});

describe("readBoolean", () => {
	it("returns true only for the literal true", () => {
		expect(readBoolean(true)).toBe(true);
	});

	it("returns false for anything else, including truthy non-booleans", () => {
		expect(readBoolean(false)).toBe(false);
		expect(readBoolean(1)).toBe(false);
		expect(readBoolean("true")).toBe(false);
		expect(readBoolean(undefined)).toBe(false);
	});
});

describe("readStringArray", () => {
	it("keeps only string entries", () => {
		expect(readStringArray(["a", 1, "b", null])).toEqual(["a", "b"]);
	});

	it("returns [] for non-arrays", () => {
		expect(readStringArray("nope")).toEqual([]);
		expect(readStringArray(undefined)).toEqual([]);
	});
});

describe("readNumberArray", () => {
	it("keeps only finite-number entries", () => {
		expect(readNumberArray([1, "x", 2, Number.NaN, Number.POSITIVE_INFINITY, 3])).toEqual([1, 2, 3]);
	});

	it("returns [] for non-arrays", () => {
		expect(readNumberArray("nope")).toEqual([]);
	});
});

describe("readStubsIntroduced", () => {
	it("keeps well-formed entries", () => {
		const out = readStubsIntroduced([{ file: "a.ts", kind: "TODO", snippet: "// TODO: x" }]);
		expect(out).toEqual([{ file: "a.ts", kind: "TODO", snippet: "// TODO: x" }]);
	});

	it("drops malformed entries and returns [] for non-arrays", () => {
		expect(readStubsIntroduced("nope")).toEqual([]);
		expect(readStubsIntroduced([{ file: "a.ts" }])).toEqual([]);
		expect(readStubsIntroduced([null, 42])).toEqual([]);
	});

	it("returns [] for null (distinct from other non-arrays: iterating null throws)", () => {
		expect(readStubsIntroduced(null)).toEqual([]);
	});

	it("drops an entry whose file/kind/snippet is present but the wrong type, one field at a time", () => {
		expect(readStubsIntroduced([{ file: 123, kind: "TODO", snippet: "x" }])).toEqual([]);
		expect(readStubsIntroduced([{ file: "a.ts", kind: 123, snippet: "x" }])).toEqual([]);
		expect(readStubsIntroduced([{ file: "a.ts", kind: "TODO", snippet: 123 }])).toEqual([]);
	});
});

describe("readStringMap", () => {
	it("builds a Map from string values, dropping non-strings", () => {
		const out = readStringMap({ a: "x", b: 1, c: "y" });
		expect(out.get("a")).toBe("x");
		expect(out.get("c")).toBe("y");
		expect(out.has("b")).toBe(false);
		expect(out.size).toBe(2);
	});

	it("returns an empty Map for non-objects", () => {
		expect(readStringMap("nope").size).toBe(0);
		expect(readStringMap(null).size).toBe(0);
	});
});

describe("readNumberMap", () => {
	it("builds a Map from finite-number values, dropping the rest", () => {
		const out = readNumberMap({ a: 1, b: "x", c: Number.NaN, d: 2 });
		expect(out.get("a")).toBe(1);
		expect(out.get("d")).toBe(2);
		expect(out.size).toBe(2);
	});

	it("returns an empty Map for non-objects", () => {
		// 42 alone doesn't discriminate a bypassed guard: Object.entries(42) is
		// already [] (a boxed Number has no enumerable own properties), so a
		// forced-false isPlainObject guard would produce the identical empty
		// result. The array-masquerading value below DOES have enumerable
		// entries a bypassed guard would wrongly read.
		expect(readNumberMap(42).size).toBe(0);
		expect(readNumberMap(arrayMasqueradingAsRecord({ a: 1 })).size).toBe(0);
	});
});

describe("readNumberRecord", () => {
	it("parses numeric keys with finite-number values", () => {
		expect(readNumberRecord({ "8080": 3, "9090": 1 })).toEqual({ 8080: 3, 9090: 1 });
	});

	it("drops non-numeric keys and non-finite values", () => {
		expect(readNumberRecord({ port: 5, "80": Number.NaN, "81": "x" })).toEqual({});
	});

	it("returns {} for non-objects", () => {
		// "nope" doesn't discriminate a bypassed guard: Object.entries("nope")
		// unwraps to per-character string entries, and every value fails the
		// inner typeof-number check regardless, so the result is {} either way.
		// The array-masquerading value carries an actual numeric value a
		// bypassed guard would wrongly accept.
		expect(readNumberRecord("nope")).toEqual({});
		expect(readNumberRecord(arrayMasqueradingAsRecord({ "8080": 3 }))).toEqual({});
	});
});

describe("readConsecutivePattern", () => {
	it("reads a well-formed pattern", () => {
		expect(readConsecutivePattern({ pattern: "edit-edit-edit", count: 3 })).toEqual({
			pattern: "edit-edit-edit",
			count: 3,
		});
	});

	it("returns null when pattern is missing", () => {
		expect(readConsecutivePattern({ count: 3 })).toBeNull();
	});

	it("returns null for non-objects", () => {
		// "nope" doesn't discriminate a bypassed guard: v.pattern on a string
		// primitive is simply undefined (no "pattern" property), so the result
		// is null either way. The array-masquerading value carries an actual
		// pattern field a bypassed guard would wrongly read.
		expect(readConsecutivePattern("nope")).toBeNull();
		expect(readConsecutivePattern(arrayMasqueradingAsRecord({ pattern: "x", count: 1 }))).toBeNull();
	});
});

describe("readSensitivity", () => {
	it("passes through each valid level", () => {
		expect(readSensitivity("Confidential")).toBe("Confidential");
		expect(readSensitivity("Internal")).toBe("Internal");
		expect(readSensitivity("HighlyConfidential")).toBe("HighlyConfidential");
	});

	it("defaults unknown / malformed values to Public", () => {
		expect(readSensitivity("Bogus")).toBe("Public");
		expect(readSensitivity(42)).toBe("Public");
		expect(readSensitivity(undefined)).toBe("Public");
	});

	// "Public" is both a valid Set member AND the function's own default, so a
	// mutant that removes "Public" from the Set is otherwise unkillable (every
	// non-member input already falls through to the same default value). An
	// explicit empty string breaks the tie: it isn't a real level, but if the
	// Set's "Public" entry were ever replaced by "" it would newly match "",
	// returning "" instead of the default "Public".
	it("does not treat an empty string as a valid level", () => {
		expect(readSensitivity("")).toBe("Public");
	});
});

describe("readStringSet", () => {
	it("builds a Set from a string array, dropping non-strings", () => {
		const s = readStringSet(["a", 1, "b", null, "a"]);
		expect([...s].sort()).toEqual(["a", "b"]);
	});

	it("returns an empty Set for non-arrays", () => {
		expect(readStringSet("nope").size).toBe(0);
		expect(readStringSet(undefined).size).toBe(0);
	});
});

describe("readTaintSources", () => {
	it("coerces a well-formed source and defaults provenance", () => {
		const out = readTaintSources([
			{ file: "src/a.ts", level: "Confidential", at_step: 4 },
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual({
			file: "src/a.ts",
			level: "Confidential",
			at_step: 4,
			provenance: "local_read",
		});
	});

	it("preserves each valid explicit provenance (not just the local_read default)", () => {
		for (const provenance of ["fetched_external", "mcp_remote", "document_content", "user_provided", "local_read"] as const) {
			const out = readTaintSources([{ file: "a.ts", level: "Public", at_step: 1, provenance }]);
			expect(out[0]?.provenance).toBe(provenance);
		}
	});

	it("defaults an invalid provenance string to local_read (not the raw value)", () => {
		const out = readTaintSources([
			{ file: "a.ts", level: "Public", at_step: 1, provenance: "bogus_source" },
		]);
		expect(out[0]?.provenance).toBe("local_read");
	});

	// "local_read" is both a valid provenance AND the function's own default,
	// so a mutant that removes it from TAINT_PROVENANCE_VALUES is otherwise
	// unkillable (every non-member value already falls through to the same
	// default). An explicit empty string breaks the tie the same way the
	// readSensitivity "" test does above.
	it("does not treat an empty string as a valid provenance", () => {
		const out = readTaintSources([{ file: "a.ts", level: "Public", at_step: 1, provenance: "" }]);
		expect(out[0]?.provenance).toBe("local_read");
	});

	it("drops entries without a file", () => {
		expect(readTaintSources([{ level: "Public", at_step: 0 }])).toHaveLength(0);
	});

	it("returns [] for a non-array", () => {
		expect(readTaintSources("nope")).toEqual([]);
		expect(readTaintSources(null)).toEqual([]);
	});

	it("skips an item that isn't a plain object even when it exposes the same fields", () => {
		const out = readTaintSources([
			arrayMasqueradingAsRecord({ file: "hack.ts", level: "Public", at_step: 1 }),
		]);
		expect(out).toHaveLength(0);
	});
});

describe("readFailedFiles", () => {
	it("coerces a well-formed entry, dropping non-string checks entries", () => {
		const out = readFailedFiles({
			"src/a.ts": {
				failure_count: 2,
				checks: ["tsc", 1],
				recorded_at: "2026-01-01T00:00:00.000Z",
				tool_call_count: 5,
			},
		});
		expect(out.get("src/a.ts")).toEqual({
			failure_count: 2,
			checks: ["tsc"],
			recorded_at: "2026-01-01T00:00:00.000Z",
			tool_call_count: 5,
		});
	});

	it("returns an empty Map for a non-object v, and skips non-object entries", () => {
		expect(readFailedFiles("nope").size).toBe(0);
		expect(readFailedFiles({ "a.ts": "not-an-object" }).size).toBe(0);
	});

	it("falls back recorded_at to a fresh ISO timestamp when absent", () => {
		const out = readFailedFiles({ "a.ts": { failure_count: 1, checks: [], tool_call_count: 0 } });
		expect(out.get("a.ts")?.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("rejects a v that is an array even when its entries look valid", () => {
		const masked = arrayMasqueradingAsRecord({
			"a.ts": { failure_count: 1, checks: [], recorded_at: "x", tool_call_count: 0 },
		});
		expect(readFailedFiles(masked).size).toBe(0);
	});
});

describe("readPendingCompletions", () => {
	it("coerces a well-formed entry", () => {
		const out = readPendingCompletions({
			k1: {
				source_file: "a.ts",
				affected_files: ["b.ts"],
				resolved_files: ["b.ts"],
				recorded_at_tool_call: 4,
				description: "refactor",
			},
		});
		expect(out.get("k1")).toEqual({
			source_file: "a.ts",
			affected_files: ["b.ts"],
			resolved_files: new Set(["b.ts"]),
			recorded_at_tool_call: 4,
			description: "refactor",
		});
	});

	it("drops entries missing source_file", () => {
		expect(readPendingCompletions({ k1: { description: "x" } }).size).toBe(0);
	});

	it("defaults description to an empty string when absent", () => {
		const out = readPendingCompletions({ k1: { source_file: "a.ts", affected_files: [] } });
		expect(out.get("k1")?.description).toBe("");
	});

	it("returns an empty Map for non-objects", () => {
		// "nope" alone doesn't discriminate a bypassed v-guard: its unwrapped
		// per-character entries all fail the inner isPlainObject(raw) check
		// regardless, so the result is empty either way. The array-masquerading
		// value below carries an entry that would pass every inner check.
		expect(readPendingCompletions("nope").size).toBe(0);
		expect(
			readPendingCompletions(arrayMasqueradingAsRecord({ k1: { source_file: "a.ts" } })).size,
		).toBe(0);
	});

	it("rejects an entry that is an array even when it exposes source_file", () => {
		const out = readPendingCompletions({
			k1: arrayMasqueradingAsRecord({ source_file: "a.ts", description: "x" }),
		});
		expect(out.size).toBe(0);
	});
});

describe("readWarnings", () => {
	it("coerces a well-formed entry", () => {
		const out = readWarnings({
			w1: { check_name: "tsc", issue_count: 2, first_issued_at: 1, last_issued_at: 2, resolved: true },
		});
		expect(out.get("w1")).toEqual({
			check_name: "tsc",
			issue_count: 2,
			first_issued_at: 1,
			last_issued_at: 2,
			resolved: true,
		});
	});

	it("defaults resolved to false and drops entries missing check_name", () => {
		const out = readWarnings({ w1: { issue_count: 1 }, w2: { check_name: "lint" } });
		expect(out.has("w1")).toBe(false);
		expect(out.get("w2")?.resolved).toBe(false);
	});

	it("returns an empty Map for non-objects", () => {
		expect(readWarnings(null).size).toBe(0);
	});

	it("rejects an entry that is an array even when it exposes check_name", () => {
		const out = readWarnings({ w1: arrayMasqueradingAsRecord({ check_name: "tsc", issue_count: 1 }) });
		expect(out.size).toBe(0);
	});
});

describe("readTddCycles", () => {
	it("defaults an unknown state to no_test", () => {
		const out = readTddCycles({
			"src/a.ts": { source_file: "src/a.ts", state: "weird" },
		});
		expect(out.get("src/a.ts")?.state).toBe("no_test");
	});

	it("preserves a valid state", () => {
		const out = readTddCycles({
			"src/a.ts": { source_file: "src/a.ts", state: "green" },
		});
		expect(out.get("src/a.ts")?.state).toBe("green");
	});

	it("returns an empty Map for a non-object v", () => {
		expect(readTddCycles(null).size).toBe(0);
	});

	it("drops an entry whose raw value is an array even when it exposes source_file", () => {
		const out = readTddCycles({
			"src/a.ts": arrayMasqueradingAsRecord({ source_file: "src/a.ts", state: "green" }),
		});
		expect(out.size).toBe(0);
	});

	it("drops an entry missing source_file", () => {
		expect(readTddCycles({ "src/a.ts": { state: "green" } }).size).toBe(0);
	});

	// The naive-looking "unknown state -> no_test" test above always passes a
	// STRING (just an invalid one, "weird"); it never reaches the branch where
	// `raw.state` isn't a string at all (missing entirely). Cover that branch
	// explicitly.
	it("defaults a missing (non-string) state to no_test", () => {
		const out = readTddCycles({ "src/a.ts": { source_file: "src/a.ts" } });
		expect(out.get("src/a.ts")?.state).toBe("no_test");
	});

	it("round-trips previous_state and the optional timing fields", () => {
		const out = readTddCycles({
			"src/a.ts": {
				source_file: "src/a.ts",
				state: "green",
				previous_state: "red",
				test_file: "src/a.test.ts",
				test_written_at: 10,
				red_at: 11,
				green_at: 12,
			},
		});
		expect(out.get("src/a.ts")).toEqual({
			source_file: "src/a.ts",
			test_file: "src/a.test.ts",
			state: "green",
			test_written_at: 10,
			red_at: 11,
			green_at: 12,
			impl_edits_before_test: 0,
			previous_state: "red",
		});
	});

	it("passes through every TDD_STATES member via previous_state (no coincidental fallback to mask a removed member)", () => {
		// previous_state's own fallback is `undefined`, never a Set member, so
		// unlike `state` (whose fallback IS the string "no_test"), each member
		// here is independently observable: removing any of the four from
		// TDD_STATES would surface as previous_state flipping to undefined.
		for (const member of ["no_test", "red", "green", "regression"] as const) {
			const out = readTddCycles({
				"src/a.ts": { source_file: "src/a.ts", state: "green", previous_state: member },
			});
			expect(out.get("src/a.ts")?.previous_state).toBe(member);
		}
	});

	it("drops an invalid previous_state and defaults the other optional fields", () => {
		const out = readTddCycles({
			"src/a.ts": { source_file: "src/a.ts", state: "green", previous_state: "bogus" },
		});
		const entry = out.get("src/a.ts");
		expect(entry?.previous_state).toBeUndefined();
		expect(entry?.test_file).toBeNull();
		expect(entry?.test_written_at).toBeUndefined();
		expect(entry?.red_at).toBeUndefined();
		expect(entry?.green_at).toBeUndefined();
	});

	it("omits test_written_at/red_at/green_at when present but the wrong type (not just when absent)", () => {
		// An absent field and a wrong-typed field both fall back to `undefined`
		// today, but they take DIFFERENT code paths — a present-but-wrong-type
		// value that reaches the fallback via the ternary's type check is a
		// different mutant target than one that's simply never assigned. Cover
		// both so a forced-true ternary (which would pass the wrong-typed raw
		// value straight through instead of falling back) is observable.
		const out = readTddCycles({
			"src/a.ts": {
				source_file: "src/a.ts",
				state: "green",
				test_written_at: "not-a-number",
				red_at: "not-a-number",
				green_at: "not-a-number",
			},
		});
		const entry = out.get("src/a.ts");
		expect(entry?.test_written_at).toBeUndefined();
		expect(entry?.red_at).toBeUndefined();
		expect(entry?.green_at).toBeUndefined();
	});
});

describe("readObservedChecks", () => {
	it("keeps a well-formed entry with optional timing + detail", () => {
		const out = readObservedChecks({
			"typecheck-1": { kind: "typecheck", status: "red", red_at: 5, detail: "2 errors" },
		});
		expect(out.get("typecheck-1")).toEqual({
			kind: "typecheck",
			status: "red",
			red_at: 5,
			detail: "2 errors",
		});
	});

	it("preserves each currently-supported kind and status", () => {
		const out = readObservedChecks({
			a: { kind: "build", status: "green" },
			b: { kind: "lint", status: "red" },
		});
		expect(out.get("a")?.kind).toBe("build");
		expect(out.get("b")?.kind).toBe("lint");
	});

	it("omits optional fields that are absent, rather than setting them to undefined", () => {
		const out = readObservedChecks({ "lint-1": { kind: "lint", status: "green" } });
		expect(out.get("lint-1")).toEqual({ kind: "lint", status: "green" });
	});

	it("drops entries with an unknown kind or status", () => {
		expect(readObservedChecks({ x: { kind: "bogus", status: "red" } }).size).toBe(0);
		expect(readObservedChecks({ x: { kind: "build", status: "bogus" } }).size).toBe(0);
	});

	it("omits red_at/green_at when the raw value is a number but not finite (NaN/Infinity)", () => {
		const out = readObservedChecks({
			x: { kind: "typecheck", status: "red", red_at: Number.NaN },
			y: { kind: "build", status: "green", green_at: Number.POSITIVE_INFINITY },
		});
		expect(out.get("x")).not.toHaveProperty("red_at");
		expect(out.get("y")).not.toHaveProperty("green_at");
	});

	it("preserves a valid green_at value", () => {
		const out = readObservedChecks({ x: { kind: "build", status: "green", green_at: 9 } });
		expect(out.get("x")?.green_at).toBe(9);
	});

	it("returns an empty Map for non-objects and skips a masqueraded entry", () => {
		expect(readObservedChecks("nope").size).toBe(0);
		const out = readObservedChecks({
			x: arrayMasqueradingAsRecord({ kind: "build", status: "green" }),
		});
		expect(out.size).toBe(0);
	});

	// `v` itself must be rejected when it's an ARRAY, even though
	// `Object.entries` on an array yields numeric-keyed entries that look
	// exactly like well-formed checks (each individual entry passes
	// isPlainObject). Only the top-level `!isPlainObject(v)` guard catches
	// this — an array is never a valid `observed_checks` map, no matter what
	// its elements look like.
	it("rejects a v that is an array even when its entries look like valid checks", () => {
		const out = readObservedChecks([{ kind: "build", status: "green" }]);
		expect(out.size).toBe(0);
	});

	it("drops an entry missing kind or status entirely (not just an invalid one)", () => {
		expect(readObservedChecks({ x: { status: "red" } }).size).toBe(0);
		expect(readObservedChecks({ x: { kind: "build" } }).size).toBe(0);
	});
});

describe("readTestRuns", () => {
	it("keeps well-formed pass/fail entries", () => {
		const out = readTestRuns({ "a.test.ts": { status: "pass", at_step: 3 } });
		expect(out.get("a.test.ts")).toEqual({ status: "pass", at_step: 3 });
	});

	it("drops entries with an invalid status", () => {
		expect(readTestRuns({ "a.test.ts": { status: "flaky", at_step: 1 } }).size).toBe(0);
	});

	it("preserves a fail status (not just pass)", () => {
		const out = readTestRuns({ "a.test.ts": { status: "fail", at_step: 2 } });
		expect(out.get("a.test.ts")?.status).toBe("fail");
	});

	it("returns an empty Map for non-objects and skips a masqueraded entry", () => {
		expect(readTestRuns("nope").size).toBe(0);
		const out = readTestRuns({ a: arrayMasqueradingAsRecord({ status: "pass", at_step: 1 }) });
		expect(out.size).toBe(0);
	});

	it("rejects a v that is an array even when its entries look valid", () => {
		const masked = arrayMasqueradingAsRecord({ "a.test.ts": { status: "pass", at_step: 1 } });
		expect(readTestRuns(masked).size).toBe(0);
	});
});

describe("readAssertionCountsMap", () => {
	it("keeps well-formed entries, defaulting missing counters to 0", () => {
		const out = readAssertionCountsMap({ "a.test.ts": { blocks: 3, assertions: 9 } });
		expect(out.get("a.test.ts")).toEqual({ blocks: 3, assertions: 9 });
		const out2 = readAssertionCountsMap({ "b.test.ts": {} });
		expect(out2.get("b.test.ts")).toEqual({ blocks: 0, assertions: 0 });
	});

	it("returns an empty Map for non-objects and skips a masqueraded entry", () => {
		expect(readAssertionCountsMap("nope").size).toBe(0);
		const out = readAssertionCountsMap({ a: arrayMasqueradingAsRecord({ blocks: 1, assertions: 1 }) });
		expect(out.size).toBe(0);
	});

	it("rejects a v that is an array even when its entries look valid", () => {
		const masked = arrayMasqueradingAsRecord({ "a.test.ts": { blocks: 1, assertions: 1 } });
		expect(readAssertionCountsMap(masked).size).toBe(0);
	});
});

describe("readGitSessionBaseline", () => {
	it("round-trips a serialized baseline", () => {
		const b = readGitSessionBaseline({
			head_sha: "abc123",
			modified: ["m.ts"],
			staged: ["s.ts"],
			untracked: ["u.ts"],
		});
		expect(b?.head_sha).toBe("abc123");
		expect(b?.modified.has("m.ts")).toBe(true);
		expect(b?.staged.has("s.ts")).toBe(true);
		expect(b?.untracked.has("u.ts")).toBe(true);
	});

	it("returns undefined for a non-object", () => {
		expect(readGitSessionBaseline(null)).toBeUndefined();
	});

	it("defaults head_sha to an empty string when absent (not left undefined)", () => {
		const b = readGitSessionBaseline({ modified: [], staged: [], untracked: [] });
		expect(b?.head_sha).toBe("");
	});
});

describe("readActiveSkills", () => {
	it("returns undefined for an empty object (no markers)", () => {
		expect(readActiveSkills({})).toBeUndefined();
	});

	it("returns undefined for a non-object v", () => {
		expect(readActiveSkills(null)).toBeUndefined();
	});

	it("coerces a marker and defaults an unknown source to cli", () => {
		const out = readActiveSkills({
			ship: { name: "ship", entered_at: 1, expires_at: 2, source: "bogus" },
		});
		expect(out?.get("ship")?.source).toBe("cli");
		expect(out?.get("ship")?.expires_at).toBe(2);
	});

	it("preserves each valid source value (not just the cli default)", () => {
		const out = readActiveSkills({
			a: { name: "a", entered_at: 0, expires_at: 0, source: "hook" },
			b: { name: "b", entered_at: 0, expires_at: 0, source: "manual" },
		});
		expect(out?.get("a")?.source).toBe("hook");
		expect(out?.get("b")?.source).toBe("manual");
	});

	it("preserves an explicit cli source (not just the fallback path)", () => {
		const out = readActiveSkills({ a: { name: "a", entered_at: 0, expires_at: 0, source: "cli" } });
		expect(out?.get("a")?.source).toBe("cli");
	});

	it("defaults an empty-string source to cli (not a coincidental accept)", () => {
		// "" isn't "cli"/"hook"/"manual", so it must fall through to the default —
		// distinct from testing an already-invalid non-empty string, because a
		// mutated equality check (e.g. comparing against "" instead of "cli")
		// only misfires observably when the raw value IS the empty string.
		const out = readActiveSkills({ a: { name: "a", entered_at: 0, expires_at: 0, source: "" } });
		expect(out?.get("a")?.source).toBe("cli");
	});

	it("prefers raw.name over the map key when they differ", () => {
		const out = readActiveSkills({
			shipKey: { name: "shipName", entered_at: 1, expires_at: 2, source: "cli" },
		});
		expect(out?.get("shipKey")?.name).toBe("shipName");
	});

	it("falls back to the map key when name is missing", () => {
		const out = readActiveSkills({
			shipKey: { entered_at: 1, expires_at: 2, source: "cli" },
		});
		expect(out?.get("shipKey")?.name).toBe("shipKey");
	});

	it("rejects a v that is an array even when its entries look valid", () => {
		const masked = arrayMasqueradingAsRecord({
			ship: { name: "ship", entered_at: 1, expires_at: 2, source: "cli" },
		});
		expect(readActiveSkills(masked)).toBeUndefined();
	});

	it("skips an entry that is an array even when it exposes the same fields", () => {
		const out = readActiveSkills({
			ship: arrayMasqueradingAsRecord({ name: "ship", entered_at: 1, expires_at: 2, source: "cli" }),
		});
		expect(out?.size).toBe(0);
	});
});

describe("serializeCapturedPlan / readCapturedPlan round-trip", () => {
	const plan: CapturedPlan = {
		session_id: "s1",
		agent_name: "agent",
		created_at_iso: "2026-05-27T00:00:00.000Z",
		created_at_step: 3,
		source: "ExitPlanMode",
		steps: [
			{ intent: "write tests", tool_hint: "Write", target_hint: "a.test.ts", status: "pending" },
			{ intent: "implement", status: "executed" },
		],
	};

	it("serializes then reads back to an equivalent plan", () => {
		const json = serializeCapturedPlan(plan);
		const back = readCapturedPlan(json);
		expect(back?.session_id).toBe("s1");
		expect(back?.source).toBe("ExitPlanMode");
		expect(back?.steps).toHaveLength(2);
		expect(back?.steps[0]?.tool_hint).toBe("Write");
		expect(back?.steps[0]?.target_hint).toBe("a.test.ts");
		expect(back?.steps[1]?.tool_hint).toBeUndefined();
		expect(back?.steps[1]?.target_hint).toBeUndefined();
		expect(back?.steps[1]?.status).toBe("executed");
	});

	it("serializes a step's missing tool_hint/target_hint as explicit null, not undefined", () => {
		const json = serializeCapturedPlan({ ...plan, steps: [{ intent: "solo", status: "pending" }] });
		const steps = parseWire(json.steps, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(steps[0]?.tool_hint).toBeNull();
		expect(steps[0]?.target_hint).toBeNull();
	});

	it("defaults an unknown source to TaskCreate", () => {
		const back = readCapturedPlan({ ...serializeCapturedPlan(plan), source: "nope" });
		expect(back?.source).toBe("TaskCreate");
	});

	// "nope" above is still a string (just an invalid one); it never reaches
	// the branch where `v.source` isn't a string at all (missing entirely).
	it("defaults a missing (non-string) source to TaskCreate", () => {
		const full: Record<string, unknown> = serializeCapturedPlan(plan);
		delete full.source;
		expect(readCapturedPlan(full)?.source).toBe("TaskCreate");
	});

	it("preserves the structured_userprompt source", () => {
		const back = readCapturedPlan({ ...serializeCapturedPlan(plan), source: "structured_userprompt" });
		expect(back?.source).toBe("structured_userprompt");
	});

	// "TaskCreate" is both a valid PLAN_SOURCES member AND the function's own
	// default, so a mutant that removes it from the Set is otherwise
	// unkillable via any non-matching source (they all already fall through to
	// the same default). An explicit empty string breaks the tie.
	it("does not treat an empty-string source as valid", () => {
		const back = readCapturedPlan({ ...serializeCapturedPlan(plan), source: "" });
		expect(back?.source).toBe("TaskCreate");
	});

	it("preserves the skipped step status (not just pending/executed)", () => {
		const json = parseWire(serializeCapturedPlan(plan), wireObject({ "steps": wireArray(wireRecord(wireUnknown)) }), "test JSON value");
		json.steps = [{ ...json.steps[0], status: "skipped" }];
		const back = readCapturedPlan(json);
		expect(back?.steps[0]?.status).toBe("skipped");
	});

	// "pending" is both a valid PLAN_STEP_STATUSES member AND the function's
	// own default, so a mutant that removes it from the Set is otherwise
	// unkillable via any non-matching status. An explicit empty string breaks
	// the tie the same way the plan-level source "" test above does.
	it("does not treat an empty-string step status as valid", () => {
		const json = parseWire(serializeCapturedPlan(plan), wireObject({ "steps": wireArray(wireRecord(wireUnknown)) }), "test JSON value");
		json.steps = [{ ...json.steps[0], status: "" }];
		const back = readCapturedPlan(json);
		expect(back?.steps[0]?.status).toBe("pending");
	});

	it("defaults an unrecognized step status to pending", () => {
		const json = parseWire(serializeCapturedPlan(plan), wireObject({ "steps": wireArray(wireRecord(wireUnknown)) }), "test JSON value");
		json.steps = [{ ...json.steps[0], status: "bogus-status" }];
		const back = readCapturedPlan(json);
		expect(back?.steps[0]?.status).toBe("pending");
	});

	it("defaults a non-string step status to pending (not the same code path as an invalid string)", () => {
		// "bogus-status" above is still a string, so it takes statusRaw's TRUE
		// branch and only falls through PLAN_STEP_STATUSES' own fallback. A
		// non-string value (or a missing field) is the only way to exercise
		// statusRaw's OWN fallback branch.
		const json = parseWire(serializeCapturedPlan(plan), wireObject({ "steps": wireArray(wireRecord(wireUnknown)) }), "test JSON value");
		json.steps = [{ ...json.steps[0], status: 5 }];
		const back = readCapturedPlan(json);
		expect(back?.steps[0]?.status).toBe("pending");
		json.steps = [{ intent: "solo" }]; // status field entirely absent
		const back2 = readCapturedPlan(json);
		expect(back2?.steps[0]?.status).toBe("pending");
	});

	it("returns undefined for a malformed plan (missing required fields)", () => {
		expect(readCapturedPlan({ steps: [] })).toBeUndefined();
		expect(readCapturedPlan(null)).toBeUndefined();
	});

	it("returns undefined when exactly one of session_id/agent_name/created_at_iso is missing", () => {
		const full = serializeCapturedPlan(plan);
		expect(readCapturedPlan({ ...full, session_id: undefined })).toBeUndefined();
		expect(readCapturedPlan({ ...full, agent_name: undefined })).toBeUndefined();
		expect(readCapturedPlan({ ...full, created_at_iso: undefined })).toBeUndefined();
	});

	it("drops a step missing intent, without dropping the whole plan", () => {
		const back = readCapturedPlan({
			...serializeCapturedPlan(plan),
			steps: [{ status: "executed" }],
		});
		expect(back?.steps).toHaveLength(0);
	});

	it("drops a step that is an array even when it exposes intent", () => {
		const back = readCapturedPlan({
			...serializeCapturedPlan(plan),
			steps: [arrayMasqueradingAsRecord({ intent: "hack", status: "pending" })],
		});
		expect(back?.steps).toHaveLength(0);
	});

	it("defaults steps to an empty array when the field is missing or not an array", () => {
		const back = readCapturedPlan({ ...serializeCapturedPlan(plan), steps: undefined });
		expect(back?.steps).toEqual([]);
		const back2 = readCapturedPlan({ ...serializeCapturedPlan(plan), steps: "nope" });
		expect(back2?.steps).toEqual([]);
	});
});
