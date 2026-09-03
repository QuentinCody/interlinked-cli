import { describe, expect, it } from "vitest";
import {
	GIT_OBJECT_PATTERN,
	MAX_LIST_ENTRIES,
	MAX_STRING_LENGTH,
	SHA256_PATTERN,
	SIMPLIFICATION_AGENT_CI_REQUEST_VERSION,
	SIMPLIFICATION_LENS_VERSION,
	VALID_RISK_TIERS,
	VALID_SCOPE_KINDS,
	VALIDATION_MODES,
} from "./simplification-agent-ci-request-schema.js";

describe("simplification Agent CI request schema constants", () => {
	it("pins the wire versions the parser accepts", () => {
		expect(SIMPLIFICATION_AGENT_CI_REQUEST_VERSION).toBe("simplification-request/v1");
		expect(SIMPLIFICATION_LENS_VERSION).toBe("simplification-lens/v1");
	});

	it("pins the enumerated vocabularies in canonical order", () => {
		expect(VALID_RISK_TIERS).toEqual(["lite", "full"]);
		expect(VALID_SCOPE_KINDS).toEqual(["repository", "diff", "paths"]);
		expect(VALIDATION_MODES).toEqual(["none", "candidate"]);
	});

	it("pins the list and string bounds", () => {
		expect(MAX_LIST_ENTRIES).toBe(4096);
		expect(MAX_STRING_LENGTH).toBe(4096);
	});

	it("accepts a lowercase sha256 digest and rejects other shapes", () => {
		expect(SHA256_PATTERN.test("a".repeat(64))).toBe(true);
		expect(SHA256_PATTERN.test("A".repeat(64))).toBe(false);
		expect(SHA256_PATTERN.test("a".repeat(63))).toBe(false);
	});

	it("accepts both Git object id widths and rejects other shapes", () => {
		expect(GIT_OBJECT_PATTERN.test("b".repeat(40))).toBe(true);
		expect(GIT_OBJECT_PATTERN.test("b".repeat(64))).toBe(true);
		expect(GIT_OBJECT_PATTERN.test("b".repeat(41))).toBe(false);
		expect(GIT_OBJECT_PATTERN.test("Z".repeat(40))).toBe(false);
	});
});
