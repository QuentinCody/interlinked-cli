import { describe, expect, it } from "vitest";
import {
	COVERAGE_STATUSES,
	EVIDENCE_STATES,
	SCOPE_KINDS,
	SOURCE_STATUSES,
	VALIDATION_STATUSES,
	finiteNumberOrNull,
	isMember,
	isSimplificationRepositoryPath,
	nonNegativeInteger,
	nullableString,
	parsedList,
	pathList,
	requiredString,
	stringList,
	uniqueCanonicalStrings,
} from "./simplification-schema-scope-kinds.js";

describe("simplification-schema-scope-kinds — vocabularies", () => {
	it("fixes the enumerated members used across the report schema", () => {
		expect(SCOPE_KINDS).toEqual(["repository", "changed", "staged", "range"]);
		expect(VALIDATION_STATUSES).toEqual(["not_run", "passed", "failed", "inconclusive"]);
		expect(COVERAGE_STATUSES).toEqual(["complete", "partial", "unavailable"]);
		expect(SOURCE_STATUSES).toEqual(["checked", "partial", "skipped", "unavailable"]);
		expect(EVIDENCE_STATES).toEqual(["candidate", "heuristic", "proven", "sandbox-validated"]);
	});
});

describe("simplification-schema-scope-kinds — isMember", () => {
	it("accepts a value present in the choice list", () => {
		expect(isMember("changed", SCOPE_KINDS)).toBe(true);
	});
	it("rejects a value absent from the choice list", () => {
		expect(isMember("unknown", SCOPE_KINDS)).toBe(false);
		expect(isMember(42, SCOPE_KINDS)).toBe(false);
	});
});

describe("simplification-schema-scope-kinds — requiredString / nullableString", () => {
	it("accepts a non-empty string", () => {
		expect(requiredString("value")).toBe("value");
	});
	it("rejects an empty string or non-string", () => {
		expect(requiredString("")).toBeNull();
		expect(requiredString(1)).toBeNull();
	});
	it("passes through null and undefined for optional strings", () => {
		expect(nullableString(null)).toBeNull();
		expect(nullableString("value")).toBe("value");
	});
	it("marks an invalid nullable string as undefined (parse failure)", () => {
		expect(nullableString(1)).toBeUndefined();
	});
});

describe("simplification-schema-scope-kinds — stringList", () => {
	it("accepts an array of strings", () => {
		expect(stringList(["a", "b"])).toEqual(["a", "b"]);
	});
	it("rejects a non-array or an array with a non-string entry", () => {
		expect(stringList("a")).toBeNull();
		expect(stringList(["a", 1])).toBeNull();
	});
});

describe("simplification-schema-scope-kinds — isSimplificationRepositoryPath", () => {
	it("accepts a relative repository-style path", () => {
		expect(isSimplificationRepositoryPath("src/a.ts")).toBe(true);
	});
	it("rejects absolute, drive-letter, backslash, and traversal paths", () => {
		expect(isSimplificationRepositoryPath("/src/a.ts")).toBe(false);
		expect(isSimplificationRepositoryPath("C:/src/a.ts")).toBe(false);
		expect(isSimplificationRepositoryPath("src\\a.ts")).toBe(false);
		expect(isSimplificationRepositoryPath("src/../a.ts")).toBe(false);
		expect(isSimplificationRepositoryPath("")).toBe(false);
	});
});

describe("simplification-schema-scope-kinds — pathList", () => {
	it("accepts a list of valid repository paths", () => {
		expect(pathList(["src/a.ts", "src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
	});
	it("rejects a list containing an invalid path", () => {
		expect(pathList(["src/a.ts", "/abs.ts"])).toBeNull();
	});
});

describe("simplification-schema-scope-kinds — uniqueCanonicalStrings", () => {
	it("accepts a sorted list of unique strings", () => {
		expect(uniqueCanonicalStrings(["a", "b", "c"])).toBe(true);
	});
	it("rejects a duplicate or an out-of-order list", () => {
		expect(uniqueCanonicalStrings(["a", "a"])).toBe(false);
		expect(uniqueCanonicalStrings(["b", "a"])).toBe(false);
	});
});

describe("simplification-schema-scope-kinds — nonNegativeInteger", () => {
	it("accepts zero and positive integers", () => {
		expect(nonNegativeInteger(0)).toBe(0);
		expect(nonNegativeInteger(5)).toBe(5);
	});
	it("rejects negative numbers, non-integers, and non-numbers", () => {
		expect(nonNegativeInteger(-1)).toBeNull();
		expect(nonNegativeInteger(1.5)).toBeNull();
		expect(nonNegativeInteger("1")).toBeNull();
	});
});

describe("simplification-schema-scope-kinds — finiteNumberOrNull", () => {
	it("passes through null and finite numbers", () => {
		expect(finiteNumberOrNull(null)).toBeNull();
		expect(finiteNumberOrNull(3)).toBe(3);
	});
	it("marks a non-finite or non-number value as undefined (parse failure)", () => {
		expect(finiteNumberOrNull(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(finiteNumberOrNull("3")).toBeUndefined();
	});
});

describe("simplification-schema-scope-kinds — parsedList", () => {
	it("parses every entry with the given parser", () => {
		expect(parsedList([1, 2, 3], (entry) => (typeof entry === "number" ? entry * 2 : null)))
			.toEqual([2, 4, 6]);
	});
	it("rejects a non-array or any entry the parser refuses", () => {
		expect(parsedList("nope", (entry) => (typeof entry === "number" ? entry : null))).toBeNull();
		expect(parsedList([1, "x"], (entry) => (typeof entry === "number" ? entry : null))).toBeNull();
	});
});
