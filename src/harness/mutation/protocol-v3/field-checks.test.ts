// ===========================================
// Protocol v3 — primitive field validators (unit pins)
// ===========================================

import { describe, expect, it } from "vitest";
import {
	checkBoundedText,
	checkRepoRelativePath,
	checkRfc3339,
	checkSha256Hex,
	unknownKeysIn,
} from "./field-checks.js";

describe("field checks — positive (must accept)", () => {
	it("rejects a lone surrogate in mutation replacement text", () => {
		expect(checkBoundedText("\uD800", "replacement")).toBe("replacement must be well-formed Unicode (no lone surrogates)");
	});

	// test-contract: public-api — the canonical formats pass.
	it("P1: canonical sha256 / timestamp / path / key-set pass", () => {
		expect(checkSha256Hex("a".repeat(64), "x")).toBeNull();
		expect(checkRfc3339("2026-08-31T12:00:00.000Z", "x")).toBeNull();
		expect(checkRepoRelativePath("src/lib/example.ts", "x")).toBeNull();
		expect(unknownKeysIn({ a: 1, b: 2 }, ["a", "b"], "blk")).toBeNull();
	});
});

describe("field checks — negative (must reject)", () => {
	// test-contract: security — hash format is exact: length, case, charset.
	it("N1: non-canonical hashes are rejected", () => {
		expect(checkSha256Hex("A".repeat(64), "x")).toContain("sha-256");
		expect(checkSha256Hex("a".repeat(63), "x")).toContain("sha-256");
		expect(checkSha256Hex("z".repeat(64), "x")).toContain("sha-256");
	});

	// test-contract: security — NaN-parsing timestamps and garbage reject
	// (Date.parse NaN must not read as valid).
	it("N2: invalid timestamps are rejected", () => {
		expect(checkRfc3339("yesterday", "x")).toContain("RFC3339");
		expect(checkRfc3339("2026-13-99T99:99:99Z", "x")).toContain("RFC3339");
		expect(checkRfc3339("2026-08-31 12:00:00", "x")).toContain("RFC3339");
	});

	// test-contract: security — traversal and absolute paths are rejected.
	it("N3: traversal / absolute / backslash paths are rejected", () => {
		expect(checkRepoRelativePath("../secrets.txt", "x")).toContain("repo-relative");
		expect(checkRepoRelativePath("/etc/passwd", "x")).toContain("repo-relative");
		expect(checkRepoRelativePath("src/../../x.ts", "x")).toContain("repo-relative");
		expect(checkRepoRelativePath("src\\win.ts", "x")).toContain("repo-relative");
	});

	// test-contract: security — nested unknown keys are named in the reason.
	it("N4: unknown nested keys are rejected by name", () => {
		expect(unknownKeysIn({ a: 1, smuggled: 2 }, ["a"], "blk")).toContain('unknown key "smuggled"');
	});
});
