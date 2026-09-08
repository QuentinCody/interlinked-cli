import { describe, expect, it } from "vitest";
import {
	checkUnknownKeys,
	ENV_KEY_PATTERN,
	err,
	fail,
	hasNoDuplicates,
	includes,
	isRepoRelativePath,
	type JsonObject,
	LOCAL_ID_PATTERN,
	ok,
	type ValidationError,
	validateCoversArray,
	validateLocalId,
	validateStringArray,
} from "./schema-validator-helpers.js";

// ----------------------------------------------------------------------------
// Result constructors: ok / fail / err
// ----------------------------------------------------------------------------

describe("ok", () => {
	it("returns a valid result with an empty error list", () => {
		const result = ok();
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("returns a fresh array each call (no shared mutation)", () => {
		const a = ok();
		const b = ok();
		expect(a.errors).not.toBe(b.errors);
		a.errors.push(err("x", "mutated"));
		expect(b.errors).toHaveLength(0);
	});
});

describe("fail", () => {
	it("wraps the supplied errors and marks the result invalid", () => {
		const errors: ValidationError[] = [err("a.b", "boom"), err("c", "bang")];
		const result = fail(errors);
		expect(result.valid).toBe(false);
		expect(result.errors).toBe(errors);
		expect(result.errors).toHaveLength(2);
	});

	it("accepts an empty error list while still reporting invalid", () => {
		const result = fail([]);
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([]);
	});
});

describe("err", () => {
	it("builds a {path, message} pair verbatim", () => {
		expect(err("root.field", "must be a string")).toEqual({
			path: "root.field",
			message: "must be a string",
		});
	});
});

// ----------------------------------------------------------------------------
// includes — membership + type guard
// ----------------------------------------------------------------------------

describe("includes", () => {
	const kinds = ["module", "package", "doc"] as const;

	it("returns true when the value is present", () => {
		expect(includes(kinds, "package")).toBe(true);
	});

	it("returns false when the value is absent", () => {
		expect(includes(kinds, "widget")).toBe(false);
	});

	it("returns false for a non-matching unknown type", () => {
		expect(includes(kinds, 42)).toBe(false);
		expect(includes(kinds, undefined)).toBe(false);
		expect(includes(kinds, null)).toBe(false);
	});

	it("narrows the type so the value is usable as a member", () => {
		const candidate: unknown = "doc";
		if (includes(kinds, candidate)) {
			// candidate is now (typeof kinds)[number]; this assignment must typecheck.
			const narrowed: "module" | "package" | "doc" = candidate;
			expect(narrowed).toBe("doc");
		} else {
			throw new Error("expected includes to narrow 'doc'");
		}
	});
});

// ----------------------------------------------------------------------------
// isRepoRelativePath — three rejection branches + accept branch
// ----------------------------------------------------------------------------

describe("isRepoRelativePath", () => {
	it("accepts a clean repo-relative path", () => {
		expect(isRepoRelativePath("src/harness/structure/types.ts")).toBe(true);
		expect(isRepoRelativePath("dir/sub")).toBe(true);
	});

	it("rejects an absolute path (leading slash)", () => {
		expect(isRepoRelativePath("/etc/passwd")).toBe(false);
	});

	it("rejects a parent-escaping path (leading ../)", () => {
		expect(isRepoRelativePath("../outside/x.ts")).toBe(false);
	});

	it("rejects a non-normalized path (interior ./ or ../ segment)", () => {
		// Normalizes to "b" / "a/b", so the equality check fails.
		expect(isRepoRelativePath("a/../b")).toBe(false);
		expect(isRepoRelativePath("a/./b")).toBe(false);
	});

	it("rejects a leading ./ path that normalizes away its prefix", () => {
		expect(isRepoRelativePath("./a")).toBe(false);
	});
});

// ----------------------------------------------------------------------------
// hasNoDuplicates
// ----------------------------------------------------------------------------

describe("hasNoDuplicates", () => {
	it("returns true for a list with all-unique entries", () => {
		expect(hasNoDuplicates(["a", "b", "c"])).toBe(true);
	});

	it("returns true for an empty list", () => {
		expect(hasNoDuplicates([])).toBe(true);
	});

	it("returns false when a value repeats", () => {
		expect(hasNoDuplicates(["a", "b", "a"])).toBe(false);
	});
});

// ----------------------------------------------------------------------------
// checkUnknownKeys
// ----------------------------------------------------------------------------

describe("checkUnknownKeys", () => {
	it("returns no errors when every key is allowed", () => {
		const obj: JsonObject = { a: 1, b: 2 };
		expect(checkUnknownKeys(obj, ["a", "b", "c"], "root")).toEqual([]);
	});

	it("returns no errors for an empty object", () => {
		expect(checkUnknownKeys({}, ["a"], "root")).toEqual([]);
	});

	it("flags each unknown key with a path-scoped message", () => {
		const obj: JsonObject = { a: 1, mystery: 2, other: 3 };
		const errors = checkUnknownKeys(obj, ["a"], "node");
		expect(errors).toEqual([
			{ path: "node.mystery", message: 'Unknown key "mystery"' },
			{ path: "node.other", message: 'Unknown key "other"' },
		]);
	});
});

// ----------------------------------------------------------------------------
// validateLocalId
// ----------------------------------------------------------------------------

describe("validateLocalId", () => {
	it("accepts a pattern-valid id with no errors", () => {
		expect(validateLocalId("Module_1.a-b", "ids[0]")).toEqual([]);
	});

	it("accepts a single alphanumeric character", () => {
		expect(validateLocalId("x", "p")).toEqual([]);
	});

	it("rejects an id starting with a separator (pattern miss)", () => {
		const errors = validateLocalId("-leading", "ids[0]");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.path).toBe("ids[0]");
		expect(errors[0]?.message).toContain('Invalid local ID "-leading"');
		expect(errors[0]?.message).toContain(LOCAL_ID_PATTERN.source);
	});

	it("rejects an empty id (pattern requires a leading char)", () => {
		const errors = validateLocalId("", "p");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("Invalid local ID");
	});

	it("rejects an id with a colon via the pattern check", () => {
		// A colon is outside the pattern's character class, so the LOCAL_ID_PATTERN
		// test is the only check that can reject it — which is why validateLocalId
		// carries no separate includes(":") branch.
		const errors = validateLocalId("ns:id", "p");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain('Invalid local ID "ns:id"');
	});
});

// ----------------------------------------------------------------------------
// validateCoversArray
// ----------------------------------------------------------------------------

describe("validateCoversArray", () => {
	it("accepts a well-formed covers array", () => {
		const covers = [
			{ artifact_kind: "module", artifact_id: "m1" },
			{ artifact_kind: "doc", artifact_id: "readme" },
		];
		expect(validateCoversArray(covers, "covers")).toEqual([]);
	});

	it("accepts an empty covers array", () => {
		expect(validateCoversArray([], "covers")).toEqual([]);
	});

	it("errors and short-circuits when covers is not an array", () => {
		const errors = validateCoversArray({ artifact_kind: "module" }, "covers");
		expect(errors).toEqual([{ path: "covers", message: "covers must be an array" }]);
	});

	it("flags an unknown key inside an element", () => {
		const covers = [{ artifact_kind: "module", artifact_id: "m1", extra: true }];
		const errors = validateCoversArray(covers, "covers");
		expect(errors).toContainEqual({
			path: "covers[0].extra",
			message: 'Unknown key "extra"',
		});
	});

	it("flags an invalid artifact_kind value", () => {
		const covers = [{ artifact_kind: "not_a_kind", artifact_id: "m1" }];
		const errors = validateCoversArray(covers, "covers");
		const kindErr = errors.find((e) => e.path === "covers[0].artifact_kind");
		expect(kindErr).toBeDefined();
		expect(kindErr?.message).toContain("Must be one of:");
		expect(kindErr?.message).toContain("module");
	});

	it("flags a non-string artifact_kind", () => {
		const covers = [{ artifact_kind: 5, artifact_id: "m1" }];
		const errors = validateCoversArray(covers, "covers");
		expect(errors.find((e) => e.path === "covers[0].artifact_kind")).toBeDefined();
	});

	it("flags a missing/non-string artifact_id", () => {
		const covers = [{ artifact_kind: "module", artifact_id: 9 }];
		const errors = validateCoversArray(covers, "covers");
		expect(errors).toContainEqual({
			path: "covers[0].artifact_id",
			message: "Must be a non-empty string",
		});
	});

	it("flags an empty-string artifact_id", () => {
		const covers = [{ artifact_kind: "module", artifact_id: "" }];
		const errors = validateCoversArray(covers, "covers");
		expect(errors).toContainEqual({
			path: "covers[0].artifact_id",
			message: "Must be a non-empty string",
		});
	});

	it("reports per-element paths across multiple bad elements", () => {
		const covers = [
			{ artifact_kind: "module", artifact_id: "ok" },
			{ artifact_kind: "bogus", artifact_id: "" },
		];
		const errors = validateCoversArray(covers, "covers");
		expect(errors.find((e) => e.path === "covers[1].artifact_kind")).toBeDefined();
		expect(errors.find((e) => e.path === "covers[1].artifact_id")).toBeDefined();
		// First (valid) element produced nothing.
		expect(errors.some((e) => e.path.startsWith("covers[0]"))).toBe(false);
	});
});

// ----------------------------------------------------------------------------
// validateStringArray
// ----------------------------------------------------------------------------

describe("validateStringArray", () => {
	it("accepts an array of unique strings", () => {
		expect(validateStringArray(["a", "b", "c"], "tags")).toEqual([]);
	});

	it("accepts an empty array", () => {
		expect(validateStringArray([], "tags")).toEqual([]);
	});

	it("errors and short-circuits when the value is not an array", () => {
		expect(validateStringArray("a,b,c", "tags")).toEqual([
			{ path: "tags", message: "Must be an array" },
		]);
	});

	it("flags each non-string element by index", () => {
		const errors = validateStringArray(["a", 2, true], "tags");
		expect(errors).toContainEqual({ path: "tags[1]", message: "Must be a string" });
		expect(errors).toContainEqual({ path: "tags[2]", message: "Must be a string" });
	});

	it("flags duplicate string values", () => {
		const errors = validateStringArray(["a", "b", "a"], "tags");
		expect(errors).toContainEqual({
			path: "tags",
			message: "Array must not contain duplicates",
		});
	});

	it("reports both a non-string element and a duplicate together", () => {
		// Non-string at [2] plus a string duplicate ("a") → two distinct errors.
		const errors = validateStringArray(["a", "a", 3], "tags");
		expect(errors).toContainEqual({ path: "tags[2]", message: "Must be a string" });
		expect(errors).toContainEqual({
			path: "tags",
			message: "Array must not contain duplicates",
		});
	});

	it("does not flag duplicates that arise only among non-string entries", () => {
		// Two numeric 5s are filtered out before the duplicate check, so only the
		// per-element 'Must be a string' errors fire — no duplicate error.
		const errors = validateStringArray([5, 5, "unique"], "tags");
		expect(errors.filter((e) => e.message === "Must be a string")).toHaveLength(2);
		expect(errors.some((e) => e.message === "Array must not contain duplicates")).toBe(false);
	});
});

// ----------------------------------------------------------------------------
// Re-exported patterns
// ----------------------------------------------------------------------------

describe("re-exported patterns", () => {
	it("LOCAL_ID_PATTERN matches valid ids and rejects separators-first", () => {
		expect(LOCAL_ID_PATTERN.test("abc.def-1")).toBe(true);
		expect(LOCAL_ID_PATTERN.test(".bad")).toBe(false);
	});

	it("ENV_KEY_PATTERN matches uppercase env keys and rejects lowercase/leading-digit", () => {
		expect(ENV_KEY_PATTERN.test("MY_KEY_1")).toBe(true);
		expect(ENV_KEY_PATTERN.test("lower")).toBe(false);
		expect(ENV_KEY_PATTERN.test("1ABC")).toBe(false);
	});
});
