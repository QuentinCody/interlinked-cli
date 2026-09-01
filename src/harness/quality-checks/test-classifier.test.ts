import { dirname, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { LanguageProfile } from "../types.js";
import {
	buildTestCandidates,
	classifyTestFailure,
	isLikelyTestFile,
} from "./test-classifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal LanguageProfile whose only field these functions read is `id`. */
function profileFor(id: LanguageProfile["id"]): LanguageProfile {
	return {
		id,
		display_name: id,
		file_extensions: [],
		project_root_markers: [],
		type_check: null,
		linter: null,
		test_runner: null,
		inline_checks: [],
	};
}

// `classifyTestFailure` keeps a module-level baseline Map keyed by testId.
// Tests that exercise the baseline path must use UNIQUE testIds so they don't
// collide with each other across the file (the Map is never reset between
// `it`s). A monotonic counter guarantees uniqueness.
let uid = 0;
function uniqueId(): string {
	uid += 1;
	return `/virtual/test-${uid}.spec.ts`;
}

// ===========================================================================
// classifyTestFailure — Check 1: module-resolution / per-language pre-existing
// ===========================================================================

describe("classifyTestFailure — module-resolution detection", () => {
	it("returns 'pre-existing' when every error line is a generic module-resolution failure", () => {
		const output = [
			"Error: Cannot find module 'left-pad'",
			"  at someStack",
			"Module not found: ./missing",
		].join("\n");
		// Only the two lines containing error/cannot keywords are inspected;
		// both match MODULE_RESOLUTION_PATTERNS → pre-existing.
		expect(classifyTestFailure(uniqueId(), output)).toBe("pre-existing");
	});

	it("returns null when at least one error line is NOT a config/env pattern", () => {
		const output = [
			"Error: Cannot find module 'left-pad'", // config
			"AssertionError: expected 1 to equal 2", // a real regression
		].join("\n");
		expect(classifyTestFailure(uniqueId(), output)).toBeNull();
	});

	it("matches the install-suggestion TS pattern (Cannot find name ... Do you need to install)", () => {
		const output =
			"src/x.ts(3,5): error: Cannot find name 'describe'. Do you need to install type definitions?";
		expect(classifyTestFailure(uniqueId(), output)).toBe("pre-existing");
	});

	it("matches ENOENT against node_modules", () => {
		const output = "Error: ENOENT: no such file in node_modules/foo/index.js";
		expect(classifyTestFailure(uniqueId(), output)).toBe("pre-existing");
	});

	it("returns null when there are no error-ish lines at all (errorLines.length === 0)", () => {
		// No line contains error|fail|cannot|ERR_|ImportError|ModuleNotFoundError,
		// so isPreExistingTestFailure short-circuits to false, AND hashTestError
		// falls back to a slice; first call records baseline and returns null.
		const output = "all green\n3 passed";
		expect(classifyTestFailure(uniqueId(), output)).toBeNull();
	});
});

// ===========================================================================
// classifyTestFailure — per-language signatures (Check 1 with `language`)
// ===========================================================================

describe("classifyTestFailure — per-language pre-existing signatures", () => {
	it("python: ModuleNotFoundError is pre-existing only when language=python", () => {
		const output = "E   ModuleNotFoundError: No module named 'numpy'";
		// Without language: the line does not match any generic pattern → null.
		expect(classifyTestFailure(uniqueId(), output)).toBeNull();
		// With language: LANG_PREEXISTING_PATTERNS.python matches → pre-existing.
		expect(classifyTestFailure(uniqueId(), output, "python")).toBe("pre-existing");
	});

	it("python: pytest 'fixture not found' is recognized", () => {
		// isPreExistingTestFailure first keeps only lines matching
		// /error|fail|cannot|.../i, so the line must carry a keyword AND match the
		// per-language anchor /\bE\s+fixture '[^']+' not found/. Pytest's own
		// summary line ("ERROR ... E   fixture '...' not found") satisfies both.
		const output = "ERROR at setup: E   fixture 'db_session' not found";
		expect(classifyTestFailure(uniqueId(), output, "python")).toBe("pre-existing");
	});

	it("rust: unresolved-import E0432 is pre-existing", () => {
		const output = "error[E0432]: unresolved import `crate::missing`";
		expect(classifyTestFailure(uniqueId(), output, "rust")).toBe("pre-existing");
	});

	it("go: 'cannot find package' is pre-existing", () => {
		const output = "cannot find package \"github.com/foo/bar\" in any of:";
		expect(classifyTestFailure(uniqueId(), output, "go")).toBe("pre-existing");
	});

	it("c_cpp: missing-header fatal error is pre-existing", () => {
		const output = "main.c:1:10: fatal error: foo.h file not found";
		expect(classifyTestFailure(uniqueId(), output, "c_cpp")).toBe("pre-existing");
	});

	it("java: 'cannot find symbol' is pre-existing", () => {
		const output = "Foo.java:5: error: cannot find symbol";
		expect(classifyTestFailure(uniqueId(), output, "java")).toBe("pre-existing");
	});

	it("language with no entry in LANG_PREEXISTING_PATTERNS falls back to generic only", () => {
		// `swift` has no per-language patterns; a swift-only failure that doesn't
		// match a generic pattern must NOT be classified pre-existing.
		const output = "Test Case failed: XCTAssertEqual failed";
		expect(classifyTestFailure(uniqueId(), output, "swift")).toBeNull();
	});
});

// ===========================================================================
// classifyTestFailure — Check 2: baseline cache
// ===========================================================================

describe("classifyTestFailure — baseline cache", () => {
	it("returns 'pre-existing' on the second failure with the same error hash", () => {
		const testId = uniqueId();
		const output = "AssertionError: boom at line 3";
		// First call: not a config error, not in baseline → records + returns null.
		expect(classifyTestFailure(testId, output)).toBeNull();
		// Second call, same testId + same first-error-line → baseline hit.
		expect(classifyTestFailure(testId, output)).toBe("pre-existing");
	});

	it("returns null again when the same test fails with a DIFFERENT error", () => {
		const testId = uniqueId();
		expect(classifyTestFailure(testId, "AssertionError: first boom")).toBeNull();
		// Different first-error-line → hash differs → not pre-existing, re-baselined.
		expect(classifyTestFailure(testId, "AssertionError: second boom")).toBeNull();
		// Now the second error is itself baselined.
		expect(classifyTestFailure(testId, "AssertionError: second boom")).toBe(
			"pre-existing",
		);
	});

	it("hashes via the slice fallback when no line contains error/fail/cannot", () => {
		// hashTestError's `.find(...)` returns undefined → falls back to
		// output.slice(0,100). Two identical no-keyword outputs hash equal, so the
		// baseline path still fires on repeat.
		const testId = uniqueId();
		const output = "ran 0 checks; nothing matched";
		expect(classifyTestFailure(testId, output)).toBeNull();
		expect(classifyTestFailure(testId, output)).toBe("pre-existing");
	});

	it("keys the baseline by testId (different ids do not share state)", () => {
		const output = "AssertionError: shared message";
		const a = uniqueId();
		const b = uniqueId();
		expect(classifyTestFailure(a, output)).toBeNull();
		// Different id, even with identical output, is a first-sighting → null.
		expect(classifyTestFailure(b, output)).toBeNull();
		// Re-failing `a` now hits its own baseline.
		expect(classifyTestFailure(a, output)).toBe("pre-existing");
	});
});

// ===========================================================================
// isLikelyTestFile
// ===========================================================================

describe("isLikelyTestFile", () => {
	it("TS/JS: matches .test and .spec base names", () => {
		expect(isLikelyTestFile("foo.test", "/a/foo.test.ts")).toBe(true);
		expect(isLikelyTestFile("foo.spec", "/a/foo.spec.ts")).toBe(true);
	});

	it("Python: matches test_ prefix and _test suffix", () => {
		expect(isLikelyTestFile("test_foo", "/a/test_foo.py")).toBe(true);
		expect(isLikelyTestFile("foo_test", "/a/foo_test.py")).toBe(true);
	});

	it("Go: matches *_test.go by full path even when base name does not", () => {
		// base name "foo_test" would also trip the python rule, so use a path
		// whose base name alone wouldn't match to isolate the Go branch.
		expect(isLikelyTestFile("foo.bar", "/a/foo.bar_test.go")).toBe(true);
	});

	it("Java: matches Test and Tests suffixes", () => {
		expect(isLikelyTestFile("FooTest", "/a/FooTest.java")).toBe(true);
		expect(isLikelyTestFile("FooTests", "/a/FooTests.java")).toBe(true);
	});

	it("Directory-based: matches __tests__, tests, and test dirs (forward + back slashes)", () => {
		expect(isLikelyTestFile("foo", "/a/__tests__/foo.ts")).toBe(true);
		expect(isLikelyTestFile("foo", "/a/tests/foo.ts")).toBe(true);
		expect(isLikelyTestFile("foo", "/a/test/foo.ts")).toBe(true);
		expect(isLikelyTestFile("foo", "C:\\proj\\__tests__\\foo.ts")).toBe(true);
	});

	it("returns false for a plain source file in no test directory", () => {
		expect(isLikelyTestFile("foo", "/a/src/foo.ts")).toBe(false);
		expect(isLikelyTestFile("widget", "/a/lib/widget.py")).toBe(false);
	});
});

// ===========================================================================
// buildTestCandidates
// ===========================================================================

describe("buildTestCandidates", () => {
	it("includes the TS/JS fallback set even with a null profile", () => {
		const dir = "/proj/src";
		const base = `${dir}/foo`;
		const out = buildTestCandidates(`${base}.ts`, ".ts", base, dir, "foo", null);
		expect(out).toEqual([
			`${base}.test.ts`,
			`${base}.spec.ts`,
			resolve(dir, "__tests__", "foo.test.ts"),
			resolve(dir, "__tests__", "foo.spec.ts"),
		]);
	});

	it("unknown language id contributes no language-specific candidates", () => {
		// `metal` has no entry in LANG_TEST_CANDIDATE_EMITTERS → only the fallback.
		const dir = "/proj/src";
		const base = `${dir}/foo`;
		const out = buildTestCandidates(
			`${base}.ts`,
			".ts",
			base,
			dir,
			"foo",
			profileFor("metal"),
		);
		expect(out).toHaveLength(4);
		expect(out[0]).toBe(`${base}.test.ts`);
	});

	it("python: emits test_/_/tests and parent tests candidates ahead of the fallback", () => {
		const dir = "/proj/pkg";
		const base = `${dir}/widget`;
		const out = buildTestCandidates(
			`${base}.py`,
			".py",
			base,
			dir,
			"widget",
			profileFor("python"),
		);
		expect(out.slice(0, 4)).toEqual([
			resolve(dir, "test_widget.py"),
			resolve(dir, "widget_test.py"),
			resolve(dir, "tests", "test_widget.py"),
			resolve(dirname(dir), "tests", "test_widget.py"),
		]);
		// Fallback still appended afterwards.
		expect(out).toContain(`${base}.test.py`);
	});

	it("go: emits a single sibling _test.go candidate before the fallback", () => {
		const dir = "/proj/pkg";
		const base = `${dir}/server`;
		const out = buildTestCandidates(
			`${base}.go`,
			".go",
			base,
			dir,
			"server",
			profileFor("go"),
		);
		expect(out[0]).toBe(`${base}_test.go`);
		expect(out).toHaveLength(5); // 1 go + 4 fallback
	});

	it("rust: emits sibling and parent tests/ candidates", () => {
		const dir = "/proj/src";
		const base = `${dir}/lib`;
		const out = buildTestCandidates(
			`${base}.rs`,
			".rs",
			base,
			dir,
			"lib",
			profileFor("rust"),
		);
		expect(out.slice(0, 2)).toEqual([
			resolve(dir, "tests", "lib.rs"),
			resolve(dirname(dir), "tests", "lib.rs"),
		]);
	});

	it("java: mirrors src/main/ → src/test/ AND emits a sibling FooTest", () => {
		// Build the absPath with the platform separator so indexOf(`${sep}src${sep}main${sep}`)
		// matches on every OS.
		const dir = ["", "proj", "src", "main", "java", "com"].join(sep);
		const base = `${dir}${sep}Widget`;
		const absPath = `${base}.java`;
		const out = buildTestCandidates(absPath, ".java", base, dir, "Widget", profileFor("java"));

		const expectedMirror = [
			"",
			"proj",
			"src",
			"test",
			"java",
			"com",
			"WidgetTest.java",
		].join(sep);
		expect(out[0]).toBe(expectedMirror);
		// Sibling candidate next.
		expect(out[1]).toBe(resolve(dir, "WidgetTest.java"));
		// Then the TS/JS fallback.
		expect(out).toContain(`${base}.test.java`);
	});

	it("java: when path has no src/main/ segment, only the sibling FooTest is emitted", () => {
		// mainIdx === -1 branch: no mirror candidate, sibling still present.
		const dir = ["", "proj", "app"].join(sep);
		const base = `${dir}${sep}Widget`;
		const absPath = `${base}.java`;
		const out = buildTestCandidates(absPath, ".java", base, dir, "Widget", profileFor("java"));
		// First candidate is the sibling (no mirror was pushed).
		expect(out[0]).toBe(resolve(dir, "WidgetTest.java"));
		expect(out).toHaveLength(5); // 1 java sibling + 4 fallback
	});
});
