// Companion test for shared-test-classification.ts — the predicate cases were
// moved verbatim from shared.ts as part of the shared.ts line-cap split
// (behavior unchanged); the package-root resolver's fail-closed case below was
// added later and drives the real resolver instead of the test-only override.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__setPackageRootForTesting,
	isPatternDataFile,
	isStrictTestFile,
	isTestSourcePath,
	isTestFile,
} from "./shared-test-classification.js";

afterEach(() => {
	__setPackageRootForTesting(undefined);
});

it.each([
	"src/thing_test.go", "src/ThingTest.java", "src/ThingTests.swift",
	"src/test_thing.swift", "src/test_thing.py", "src/thing_test.py",
])("recognizes the language's test filename convention: %s", (file) => {
	expect(isStrictTestFile(file)).toBe(true);
	expect(isTestSourcePath(file)).toBe(true);
});

it.each(["src/test_helper.ts", "src/test_thing.txt", "src/ThingTests.txt"])(
	"keeps similarly named production files out of test scope: %s", (file) => {
		expect(isStrictTestFile(file)).toBe(false);
		expect(isTestSourcePath(file)).toBe(false);
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

describe("package-root resolution — fail-closed", () => {
	// test-contract: invariant — the resolver's docstring promises it "returns
	// null when the package root can't be located" and that callers fail closed,
	// so a filesystem error during the upward walk must never escape as an
	// exception nor grant the harness-internal-data exemption.
	it("swallows a filesystem error during the upward walk and grants no exemption", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			return {
				...actual,
				existsSync: () => {
					throw new Error("EIO: i/o error reading package.json");
				},
			};
		});
		const mod = await import("./shared-test-classification.js");
		// A checks/ path inside interlinked-cli's OWN checkout: it is exempt
		// whenever the walk succeeds, so `false` here can only come from the
		// resolver having swallowed the error and returned null.
		const ownCheckFile = `${process.cwd()}/src/harness/checks/foo.ts`;
		expect(mod.isPatternDataFile(ownCheckFile)).toBe(false);
		// The strict half never consults the resolver, so it still answers.
		expect(mod.isPatternDataFile(`${process.cwd()}/src/harness/checks/foo.test.ts`)).toBe(true);
		vi.doUnmock("node:fs");
		vi.resetModules();
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
