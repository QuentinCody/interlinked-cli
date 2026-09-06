import { describe, expect, it } from "vitest";
import {
	getPath,
	matchesAll,
	matchesClause,
	parseWhereClause,
	recordTimestampMs,
	resolveTimeBound,
	stringifyValue,
} from "./filters.js";

describe("parseWhereClause", () => {
	it("parses each operator with the right precedence", () => {
		expect(parseWhereClause("type=guard_block")).toEqual({
			path: "type",
			op: "=",
			value: "guard_block",
		});
		expect(parseWhereClause("kind!=tool_event")).toEqual({
			path: "kind",
			op: "!=",
			value: "tool_event",
		});
		expect(parseWhereClause("summary~=rm -rf")).toEqual({
			path: "summary",
			op: "~=",
			value: "rm -rf",
		});
		expect(parseWhereClause("output_tokens>1000")).toEqual({
			path: "output_tokens",
			op: ">",
			value: "1000",
		});
		expect(parseWhereClause("score>=0.5")).toEqual({ path: "score", op: ">=", value: "0.5" });
		expect(parseWhereClause("line<=10")).toEqual({ path: "line", op: "<=", value: "10" });
	});

	it("keeps operator characters inside the value", () => {
		expect(parseWhereClause("summary=a=b")).toEqual({ path: "summary", op: "=", value: "a=b" });
	});

	it("throws on an expression with no operator", () => {
		expect(() => parseWhereClause("justakey")).toThrow(/Invalid --where/);
		expect(() => parseWhereClause("=leadingop")).toThrow(/Invalid --where/);
	});
});

describe("getPath", () => {
	const record = {
		ts: "2026-07-24T00:00:00Z",
		git: { branch: "main" },
		checks: [
			{ id: "a", severity: "warning" },
			{ id: "b", severity: "error" },
		],
	};

	it("walks dot paths", () => {
		expect(getPath(record, "git.branch")).toEqual(["main"]);
	});

	it("fans out over arrays", () => {
		expect(getPath(record, "checks.id")).toEqual(["a", "b"]);
	});

	it("returns empty for absent paths", () => {
		expect(getPath(record, "nope.deep")).toEqual([]);
	});
});

describe("matchesClause", () => {
	const record = {
		type: "guard_block",
		tool: "Bash",
		count: 7,
		ok: true,
		checks: [{ id: "nan_coercion_guard" }],
	};

	it("matches equality on strings, numbers, and booleans", () => {
		expect(matchesClause(record, parseWhereClause("type=guard_block"))).toBe(true);
		expect(matchesClause(record, parseWhereClause("count=7"))).toBe(true);
		expect(matchesClause(record, parseWhereClause("ok=true"))).toBe(true);
		expect(matchesClause(record, parseWhereClause("type=guard_warn"))).toBe(false);
	});

	it("treats absent fields as satisfying !=", () => {
		expect(matchesClause(record, parseWhereClause("missing!=x"))).toBe(true);
		expect(matchesClause(record, parseWhereClause("type!=guard_block"))).toBe(false);
	});

	it("matches case-insensitive substrings with ~=", () => {
		expect(matchesClause(record, parseWhereClause("tool~=bas"))).toBe(true);
		expect(matchesClause(record, parseWhereClause("tool~=zsh"))).toBe(false);
	});

	it("matches numeric comparisons only on finite numbers", () => {
		expect(matchesClause(record, parseWhereClause("count>5"))).toBe(true);
		expect(matchesClause(record, parseWhereClause("count<5"))).toBe(false);
		expect(matchesClause(record, parseWhereClause("tool>5"))).toBe(false);
		expect(matchesClause(record, parseWhereClause("count>notanumber"))).toBe(false);
	});

	it("matches <= as the fallback numeric comparison (count is exactly the bound)", () => {
		// count=7: <=7 must match (equal-to-bound case) and <=6 must not — this
		// is the only case-arm test that reaches compareNumeric's final `return
		// n <= bound` line rather than one of the three explicit `if` branches.
		expect(matchesClause(record, parseWhereClause("count<=7"))).toBe(true);
		expect(matchesClause(record, parseWhereClause("count<=6"))).toBe(false);
	});

	it("matches through array fan-out", () => {
		expect(matchesClause(record, parseWhereClause("checks.id=nan_coercion_guard"))).toBe(true);
		expect(matchesClause(record, parseWhereClause("checks.id=other"))).toBe(false);
	});
});

describe("matchesAll", () => {
	it("ANDs clauses", () => {
		const record = { a: "1", b: "2" };
		const clauses = [parseWhereClause("a=1"), parseWhereClause("b=2")];
		expect(matchesAll(record, clauses)).toBe(true);
		expect(matchesAll(record, [parseWhereClause("a=1"), parseWhereClause("b=3")])).toBe(false);
	});
});

describe("resolveTimeBound", () => {
	const now = Date.parse("2026-07-24T12:00:00Z");

	it("resolves relative durations against now", () => {
		expect(resolveTimeBound("2h", now)).toBe(now - 2 * 3600 * 1000);
		expect(resolveTimeBound("7d", now)).toBe(now - 7 * 86400 * 1000);
	});

	it("resolves ISO timestamps", () => {
		expect(resolveTimeBound("2026-07-20T00:00:00Z", now)).toBe(Date.parse("2026-07-20T00:00:00Z"));
	});

	it("throws on garbage instead of comparing NaN", () => {
		expect(() => resolveTimeBound("yesterdayish", now)).toThrow(/Invalid --since/);
	});
});

describe("recordTimestampMs", () => {
	it("reads ts, falls back to timestamp, and guards non-finite parses", () => {
		expect(recordTimestampMs({ ts: "2026-07-24T00:00:00Z" })).toBe(
			Date.parse("2026-07-24T00:00:00Z"),
		);
		expect(recordTimestampMs({ timestamp: "2026-07-24T00:00:00Z" })).toBe(
			Date.parse("2026-07-24T00:00:00Z"),
		);
		expect(recordTimestampMs({ ts: "not a date" })).toBeUndefined();
		expect(recordTimestampMs({})).toBeUndefined();
	});
});

describe("stringifyValue", () => {
	it("renders scalars, null, and objects stably", () => {
		expect(stringifyValue("s")).toBe("s");
		expect(stringifyValue(7)).toBe("7");
		expect(stringifyValue(null)).toBe("null");
		expect(stringifyValue({ a: 1 })).toBe('{"a":1}');
	});
});
