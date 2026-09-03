// Companion test for shared-test-classification.ts — moved verbatim from
// shared.ts as part of the shared.ts line-cap split. Behavior unchanged.

import { afterEach, describe, expect, it } from "vitest";
import {
	__setPackageRootForTesting,
	isPatternDataFile,
	isStrictTestFile,
	isTestFile,
} from "./shared-test-classification.js";

afterEach(() => {
	__setPackageRootForTesting(undefined);
});

describe("isStrictTestFile — positive (must fire)", () => {
	it("matches __tests__/ directory files", () => {
		expect(isStrictTestFile("src/harness/checks/__tests__/foo.ts")).toBe(true);
	});

	it("matches *.test.ts and *.spec.ts filenames", () => {
		expect(isStrictTestFile("src/foo.test.ts")).toBe(true);
		expect(isStrictTestFile("src/foo.spec.ts")).toBe(true);
	});

	it("matches Python test_*.py and *_test.py", () => {
		expect(isStrictTestFile("test_foo.py")).toBe(true);
		expect(isStrictTestFile("foo_test.py")).toBe(true);
	});
});

describe("isStrictTestFile — negative (must not fire)", () => {
	it("does not match ordinary source", () => {
		expect(isStrictTestFile("src/harness/checks/shared.ts")).toBe(false);
	});

	it("does not match a harness-internal data file (strict has no data exemption)", () => {
		expect(isStrictTestFile("src/harness/checks/foo.ts")).toBe(false);
	});
});

describe("isPatternDataFile — positive (must fire)", () => {
	it("fires for a genuine test file even with no package root resolvable", () => {
		__setPackageRootForTesting(null);
		expect(isPatternDataFile("src/foo.test.ts")).toBe(true);
	});

	it("fires for a harness-internal checks/ file when package root resolves", () => {
		__setPackageRootForTesting("/repo");
		expect(isPatternDataFile("/repo/src/harness/checks/foo.ts")).toBe(true);
	});
});

describe("isPatternDataFile — negative (must not fire)", () => {
	it("does not fire for ordinary product source outside the package root", () => {
		__setPackageRootForTesting(null);
		expect(isPatternDataFile("src/lib/config.ts")).toBe(false);
	});

	it("does not fire for a checks/-shaped path when the package root is unresolved (fail-closed)", () => {
		__setPackageRootForTesting(null);
		expect(isPatternDataFile("/some/other/repo/src/harness/checks/foo.ts")).toBe(false);
	});
});

describe("isTestFile", () => {
	it("is a compat alias for isPatternDataFile", () => {
		__setPackageRootForTesting(null);
		expect(isTestFile("src/foo.test.ts")).toBe(isPatternDataFile("src/foo.test.ts"));
	});
});

describe("__setPackageRootForTesting", () => {
	it("overrides the cache so the harness-internal-data exemption can be forced on for a specific root", () => {
		__setPackageRootForTesting("/pkg");
		expect(isPatternDataFile("/pkg/src/harness/rules/foo.ts")).toBe(true);
		__setPackageRootForTesting(null);
		expect(isPatternDataFile("/pkg/src/harness/rules/foo.ts")).toBe(false);
	});
});
